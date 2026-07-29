/** @jest-environment node */

const getFile = jest.fn();
const replaceGoogleDriveSelections = jest.fn();

jest.mock("@/lib/repositories/google-drive/connector-service", () => ({
  connectorBelongsToRepository: jest.fn().mockResolvedValue(true),
  getGoogleDriveConnectorCredential: jest.fn().mockResolvedValue({
    encryptedRefreshToken: "encrypted-token",
  }),
  replaceGoogleDriveSelections: (...args: unknown[]) =>
    replaceGoogleDriveSelections(...args),
  requestGoogleDriveSync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/repositories/google-drive", () => ({
  GoogleDriveClient: jest.fn().mockImplementation(() => ({ getFile })),
  GOOGLE_FOLDER_MIME_TYPE: "application/vnd.google-apps.folder",
  GOOGLE_SHORTCUT_MIME_TYPE: "application/vnd.google-apps.shortcut",
}));
jest.mock("@/lib/repositories/google-drive/oauth", () => ({
  refreshGoogleAccessToken: jest
    .fn()
    .mockResolvedValue({ accessToken: "access-token" }),
}));
jest.mock("@/lib/repositories/google-drive/route-access", () => ({
  requireRepositoryConnectorManager: jest
    .fn()
    .mockResolvedValue({ userId: 7, cognitoSub: "manager-sub" }),
  repositoryConnectorErrorResponse: jest.fn((error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 400 },
    ),
  ),
}));

import { POST } from "@/app/api/repositories/[repositoryId]/connectors/google/selections/route";

const CONNECTOR_ID = "11111111-2222-4333-8444-555555555555";
const context = { params: Promise.resolve({ repositoryId: "42" }) };

function request(fileIds: string[]): Request {
  return new Request(
    "https://aistudio.example.test/api/repositories/42/connectors/google/selections",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectorId: CONNECTOR_ID, fileIds }),
    },
  );
}

describe("Google Drive selection replacement route", () => {
  beforeAll(() => {
    Object.assign(Response, {
      json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init),
    });
  });

  beforeEach(() => {
    getFile.mockReset();
    replaceGoogleDriveSelections.mockReset();
  });

  test("bounds provider fanout and applies the route-local request budget", async () => {
    let active = 0;
    let peak = 0;
    getFile.mockImplementation(
      async (fileId: string, resourceKey?: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (fileId === "shortcut-file") {
          return {
            id: fileId,
            name: "Linked handbook",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: {
              targetId: "target-file",
              targetMimeType: "application/vnd.google-apps.document",
              targetResourceKey: "target-resource-key",
            },
          };
        }
        if (fileId === "target-file") {
          expect(resourceKey).toBe("target-resource-key");
          return {
            id: fileId,
            name: "Handbook",
            mimeType: "application/vnd.google-apps.document",
          };
        }
        return {
          id: fileId,
          name: fileId,
          mimeType: "text/plain",
        };
      },
    );

    const response = await POST(
      request([
        "shortcut-file",
        ...Array.from({ length: 19 }, (_, index) => `file-${index}`),
      ]),
      context,
    );

    expect(response.status).toBe(200);
    expect(peak).toBe(5);
    expect(getFile).toHaveBeenCalledWith(
      "target-file",
      "target-resource-key",
    );
    expect(replaceGoogleDriveSelections).toHaveBeenCalledTimes(1);
    getFile.mockResolvedValue({
      id: "file",
      name: "file",
      mimeType: "text/plain",
    });

    // One request was consumed above. Four more are admitted and the sixth
    // request in this route-local window is rejected.
    for (let index = 0; index < 4; index += 1) {
      const response = await POST(request([`file-${index}`]), context);
      expect(response.status).toBe(200);
    }
    const limited = await POST(request(["file-limited"]), context);
    expect(limited.status).toBe(429);
  });
});
