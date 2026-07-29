/** @jest-environment node */

const mockCookieGetAll = jest.fn();
const mockCookieDelete = jest.fn();
const mockDecryptToken = jest.fn();
const mockRequireRepositoryConnectorManager = jest.fn();
const mockExchangeGoogleAuthorizationCode = jest.fn();
const mockUpsertPersonalGoogleDriveConnector = jest.fn();
const mockRequestGoogleDriveSync = jest.fn();

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({
    getAll: mockCookieGetAll,
    delete: mockCookieDelete,
  })),
}));

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL) =>
      ({
        status: 307,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "location" ? url.toString() : null,
        },
      }) as Response,
  },
}));

jest.mock("@/lib/crypto/token-encryption", () => ({
  decryptToken: (value: string) => mockDecryptToken(value),
}));

jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://aistudio.example.test",
}));

jest.mock("@/lib/repositories/google-drive/connector-service", () => ({
  requestGoogleDriveSync: (input: unknown) => mockRequestGoogleDriveSync(input),
  upsertPersonalGoogleDriveConnector: (input: unknown) =>
    mockUpsertPersonalGoogleDriveConnector(input),
}));

jest.mock("@/lib/repositories/google-drive/oauth", () => ({
  exchangeGoogleAuthorizationCode: (input: unknown) =>
    mockExchangeGoogleAuthorizationCode(input),
}));

jest.mock("@/lib/repositories/google-drive/route-access", () => ({
  requireRepositoryConnectorManager: (repositoryId: number) =>
    mockRequireRepositoryConnectorManager(repositoryId),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "google-callback-test",
  startTimer: () => jest.fn(),
}));

import { GET } from "@/app/api/repositories/connectors/google/callback/route";
import { GOOGLE_DRIVE_SCOPE } from "@/lib/repositories/google-drive/formats";

const repositoryId = 42;
const userId = 7;
const validState = `${repositoryId}:valid-nonce`;
const originalResponseJson = Response.json;

function encryptedState(state = validState): string {
  return JSON.stringify({
    state,
    codeVerifier: "v".repeat(43),
    repositoryId,
    userId,
    createdAt: Date.now(),
  });
}

describe("Google Drive OAuth callback state boundary", () => {
  beforeAll(() => {
    Object.defineProperty(Response, "json", {
      configurable: true,
      value: (body: unknown, init?: ResponseInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(body), {
          ...init,
          headers,
        });
      },
    });
  });

  afterAll(() => {
    Object.defineProperty(Response, "json", {
      configurable: true,
      value: originalResponseJson,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGetAll.mockReturnValue([
      { name: "unrelated", value: "ignored" },
      {
        name: `google_content_oauth_state_${repositoryId}`,
        value: "encrypted-state",
      },
    ]);
    mockDecryptToken.mockImplementation(async (value: string) => {
      if (value !== "encrypted-state") throw new Error("Malformed cookie");
      return encryptedState();
    });
    mockRequireRepositoryConnectorManager.mockResolvedValue({
      userId,
      cognitoSub: "callback-user",
    });
    mockExchangeGoogleAuthorizationCode.mockResolvedValue({
      accessToken: "access-token",
      expiresInSeconds: 3600,
      refreshToken: "refresh-token",
      scopes: [GOOGLE_DRIVE_SCOPE],
    });
    mockUpsertPersonalGoogleDriveConnector.mockResolvedValue(
      "11111111-2222-4333-8444-555555555555",
    );
    mockRequestGoogleDriveSync.mockResolvedValue(undefined);
  });

  test("rejects a mismatched state before authorization even with a forged provider error", async () => {
    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/repositories/connectors/google/callback?state=${repositoryId}:attacker&error=access_denied`,
      ),
    );

    expect(response.status).toBe(400);
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted-state");
    expect(mockCookieDelete).not.toHaveBeenCalled();
    expect(mockRequireRepositoryConnectorManager).not.toHaveBeenCalled();
    expect(mockExchangeGoogleAuthorizationCode).not.toHaveBeenCalled();
  });

  test("validates state before treating a provider denial as a missing code", async () => {
    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/repositories/connectors/google/callback?state=${encodeURIComponent(validState)}&error=access_denied`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://aistudio.example.test/repositories/${repositoryId}?googleDrive=failed`,
    );
    expect(mockCookieDelete).toHaveBeenCalledWith(
      `google_content_oauth_state_${repositoryId}`,
    );
    expect(mockRequireRepositoryConnectorManager).toHaveBeenCalledWith(
      repositoryId,
    );
    expect(mockExchangeGoogleAuthorizationCode).not.toHaveBeenCalled();
  });

  test("preserves the valid PKCE callback and connector creation flow", async () => {
    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/repositories/connectors/google/callback?state=${encodeURIComponent(validState)}&code=authorization-code`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://aistudio.example.test/repositories/${repositoryId}?googleDrive=connected`,
    );
    expect(mockExchangeGoogleAuthorizationCode).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: "v".repeat(43),
      redirectUri:
        "https://aistudio.example.test/api/repositories/connectors/google/callback",
    });
    expect(mockUpsertPersonalGoogleDriveConnector).toHaveBeenCalledWith({
      repositoryId,
      userId,
      refreshToken: "refresh-token",
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
    });
    expect(mockRequestGoogleDriveSync).toHaveBeenCalledWith({
      connectorId: "11111111-2222-4333-8444-555555555555",
      trigger: "initial",
    });
  });
});
