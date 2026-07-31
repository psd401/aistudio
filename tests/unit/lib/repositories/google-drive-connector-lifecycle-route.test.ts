/** @jest-environment node */

const setPaused = jest.fn();

if (typeof Response.json !== "function") {
  Object.defineProperty(Response, "json", {
    configurable: true,
    value: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json" },
      }),
  });
}

jest.mock("@/lib/repositories/google-drive/connector-service", () => ({
  connectorBelongsToRepository: jest.fn().mockResolvedValue(true),
  disconnectGoogleDriveConnector: jest.fn(),
  setGoogleDriveConnectorPaused: (...args: unknown[]) => setPaused(...args),
}));
jest.mock("@/lib/repositories/google-drive/oauth", () => ({
  revokeGoogleRefreshToken: jest.fn(),
}));
jest.mock("@/lib/repositories/google-drive/route-access", () => ({
  requireRepositoryConnectorManager: jest.fn().mockResolvedValue({
    userId: 7,
    cognitoSub: "user-sub",
  }),
  repositoryConnectorErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 400 }
    ),
}));

import { PATCH } from "@/app/api/repositories/[repositoryId]/connectors/google/[connectorId]/route";

const context = {
  params: Promise.resolve({
    repositoryId: "39",
    connectorId: "11111111-2222-4333-8444-555555555555",
  }),
};

describe("Google Drive connector lifecycle route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["pause", true, "paused"],
    ["resume", false, "pending"],
  ] as const)(
    "%s changes connector state without invoking destructive disconnect",
    async (operation, paused, status) => {
      setPaused.mockResolvedValue({ status });
      const response = await PATCH(
        new Request("https://example.test", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation }),
        }),
        context
      );

      expect(response.status).toBe(200);
      expect(setPaused).toHaveBeenCalledWith({
        connectorId: "11111111-2222-4333-8444-555555555555",
        paused,
      });
    }
  );
});
