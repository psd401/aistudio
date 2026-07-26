import { createHash } from "node:crypto";

const mockCodeVerifier = "v".repeat(43);
const mockOwnerEmail = "owner@psd401.net";
const mockNonce = "a".repeat(64);
let mockExecutedLabels: string[] = [];
let mockNonceAvailable = true;
let mockSessionEmail: string | null = mockOwnerEmail;

const mockVerifyConsentToken = jest.fn();
const mockStoreTokens = jest.fn();

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () =>
    mockSessionEmail ? { email: mockSessionEmail } : null
  ),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
  generateRequestId: () => "request-aistudio-test",
  startTimer: () => () => undefined,
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_callback: unknown, label: string) => {
    mockExecutedLabels.push(label);
    if (label === "lookupAistudioConsentNonce") {
      return mockNonceAvailable
        ? [{ codeVerifier: mockCodeVerifier, ownerEmail: mockOwnerEmail }]
        : [];
    }
    if (label === "lookupAistudioCallbackNonce") {
      return mockNonceAvailable
        ? [
            {
              ownerEmail: mockOwnerEmail,
              tokenKind: "aistudio",
              codeVerifier: mockCodeVerifier,
            },
          ]
        : [];
    }
    if (label === "consumeAistudioConsentNonce") {
      return [{ nonce: mockNonce }];
    }
    return [];
  }),
}));

jest.mock("@/lib/db/schema", () => ({
  psdAgentWorkspaceConsentNonces: {},
}));

jest.mock("@/lib/agent-workspace/consent-token", () => ({
  verifyConsentToken: (...args: unknown[]) =>
    mockVerifyConsentToken(...args),
}));

jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  storeAistudioOAuthTokens: (...args: unknown[]) => mockStoreTokens(...args),
}));

jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://issuer.example",
}));

import {
  handleAistudioCallback,
  verifyAistudioConsentAndGetOAuthUrl,
} from "@/actions/agent-aistudio.actions";
import {
  AISTUDIO_OPENCLAW_CLIENT_ID,
  AISTUDIO_OPENCLAW_SCOPES,
} from "@/lib/oauth/openclaw-client";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mockExecutedLabels = [];
  mockNonceAvailable = true;
  mockSessionEmail = mockOwnerEmail;
  mockVerifyConsentToken.mockReset();
  mockStoreTokens.mockReset();
  mockStoreTokens.mockResolvedValue(undefined);
  global.fetch = jest.fn();
});

describe("AI Studio OAuth consent", () => {
  it("builds a public-client authorization URL with exact scopes and S256 PKCE", async () => {
    mockVerifyConsentToken.mockResolvedValue({
      sub: mockOwnerEmail,
      kind: "aistudio",
      nonce: mockNonce,
    });

    const result = await verifyAistudioConsentAndGetOAuthUrl("signed-token");
    expect(result.isSuccess).toBe(true);
    expect(result.data?.valid).toBe(true);

    const oauthUrl = new URL(result.data?.oauthUrl ?? "");
    expect(`${oauthUrl.origin}${oauthUrl.pathname}`).toBe(
      "https://issuer.example/api/oauth/auth"
    );
    expect(oauthUrl.searchParams.get("client_id")).toBe(
      AISTUDIO_OPENCLAW_CLIENT_ID
    );
    expect(oauthUrl.searchParams.get("state")).toBe(mockNonce);
    expect(oauthUrl.searchParams.get("scope")).toBe(
      AISTUDIO_OPENCLAW_SCOPES.join(" ")
    );
    expect(oauthUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(oauthUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(mockCodeVerifier).digest("base64url")
    );
  });

  it("rejects an expired or consumed nonce", async () => {
    mockVerifyConsentToken.mockResolvedValue({
      sub: mockOwnerEmail,
      kind: "aistudio",
      nonce: mockNonce,
    });
    mockNonceAvailable = false;

    const result = await verifyAistudioConsentAndGetOAuthUrl("signed-token");
    expect(result.data).toMatchObject({ valid: false });
    expect(result.data?.error).toMatch(/expired|already used/i);
  });

  it("rejects a signed token whose owner does not match the nonce owner", async () => {
    mockVerifyConsentToken.mockResolvedValue({
      sub: "different-owner@psd401.net",
      kind: "aistudio",
      nonce: mockNonce,
    });
    mockSessionEmail = "different-owner@psd401.net";

    const result = await verifyAistudioConsentAndGetOAuthUrl("signed-token");
    expect(result.data).toMatchObject({ valid: false });
    expect(result.data?.oauthUrl).toBeUndefined();
  });

  it.each([null, "attacker@psd401.net"])(
    "rejects a consent link when the live session is %s",
    async (sessionEmail) => {
      mockSessionEmail = sessionEmail;
      mockVerifyConsentToken.mockResolvedValue({
        sub: mockOwnerEmail,
        kind: "aistudio",
        nonce: mockNonce,
      });

      const result =
        await verifyAistudioConsentAndGetOAuthUrl("signed-token");

      expect(result.data).toMatchObject({ valid: false });
      expect(result.data?.oauthUrl).toBeUndefined();
      expect(mockExecutedLabels).toEqual([]);
    }
  );
});

describe("AI Studio OAuth callback", () => {
  it("stores rotating OAuth tokens and consumes the nonce for the same identity", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          scope: AISTUDIO_OPENCLAW_SCOPES.join(" "),
          expires_in: 900,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ sub: "user-1", email: mockOwnerEmail })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await handleAistudioCallback("authorization-code", mockNonce);

    expect(result.data).toEqual({
      success: true,
      ownerEmail: mockOwnerEmail,
    });
    expect(mockStoreTokens).toHaveBeenCalledWith(
      mockOwnerEmail,
      expect.objectContaining({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      })
    );
    expect(mockExecutedLabels).toContain("consumeAistudioConsentNonce");

    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest[0]).toBe("https://issuer.example/api/oauth/token");
    expect(String(tokenRequest[1]?.body)).toContain(
      `client_id=${AISTUDIO_OPENCLAW_CLIENT_ID}`
    );
    expect(String(tokenRequest[1]?.body)).toContain(
      `code_verifier=${mockCodeVerifier}`
    );
  });

  it("does not store tokens or consume the nonce when userinfo identifies another user", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 900,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ email: "someone-else@psd401.net" })
      ) as unknown as typeof fetch;

    const result = await handleAistudioCallback("authorization-code", mockNonce);

    expect(result.data).toMatchObject({ success: false });
    expect(mockStoreTokens).not.toHaveBeenCalled();
    expect(mockExecutedLabels).not.toContain("consumeAistudioConsentNonce");
  });

  it.each([null, "attacker@psd401.net"])(
    "rejects the callback when the live session is %s",
    async (sessionEmail) => {
      mockSessionEmail = sessionEmail;

      const result = await handleAistudioCallback(
        "authorization-code",
        mockNonce
      );

      expect(result.data).toMatchObject({ success: false });
      expect(mockStoreTokens).not.toHaveBeenCalled();
      expect(mockExecutedLabels).toEqual(["lookupAistudioCallbackNonce"]);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed state before querying or exchanging a code", async () => {
    const result = await handleAistudioCallback("authorization-code", "bad");
    expect(result.data).toMatchObject({ success: false });
    expect(mockExecutedLabels).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
