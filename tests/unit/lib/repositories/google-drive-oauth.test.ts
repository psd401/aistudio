/** @jest-environment node */

const mockSecretsSend = jest.fn();

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: jest.fn((input: unknown) => input),
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
}));

import {
  __resetGoogleOAuthConfigForTests,
  exchangeGoogleAuthorizationCode,
  generateGooglePkce,
  loadGoogleContentOAuthConfig,
} from "@/lib/repositories/google-drive/oauth";
import { GOOGLE_DRIVE_SCOPE } from "@/lib/repositories/google-drive/formats";
import { GOOGLE_CONTENT_WIF_CONFIG } from "@/lib/repositories/google-drive/wif";

function tokenResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("Google content OAuth", () => {
  beforeEach(() => {
    mockSecretsSend.mockReset();
    process.env.GOOGLE_CONTENT_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_CONTENT_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_CONTENT_PICKER_API_KEY = "picker-key";
    process.env.GOOGLE_CONTENT_PICKER_APP_ID = "1022506104054";
    __resetGoogleOAuthConfigForTests();
  });

  afterEach(() => {
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CONTENT_PICKER_API_KEY;
    delete process.env.GOOGLE_CONTENT_PICKER_APP_ID;
    __resetGoogleOAuthConfigForTests();
  });

  test("creates RFC 7636 S256 PKCE material", () => {
    const pkce = generateGooglePkce();
    expect(pkce.verifier).toMatch(/^[\w-]{43}$/);
    expect(pkce.challenge).toMatch(/^[\w-]{43}$/);
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  test("exchanges a code with PKCE and accepts exactly drive.readonly", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        tokenResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: GOOGLE_DRIVE_SCOPE,
          token_type: "Bearer",
        }),
      );

    const token = await exchangeGoogleAuthorizationCode({
      code: "authorization-code",
      codeVerifier: "v".repeat(43),
      redirectUri:
        "https://aistudio.example.test/api/repositories/connectors/google/callback",
      fetch: fetchMock,
    });

    expect(token.scopes).toEqual([GOOGLE_DRIVE_SCOPE]);
    const init = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code_verifier")).toBe("v".repeat(43));
    expect(body.get("client_secret")).toBe("client-secret");
  });

  test("fails closed when Google grants an unexpected scope", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        tokenResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: `${GOOGLE_DRIVE_SCOPE} https://www.googleapis.com/auth/drive.file`,
        }),
      );

    await expect(
      exchangeGoogleAuthorizationCode({
        code: "authorization-code",
        codeVerifier: "v".repeat(43),
        redirectUri: "https://aistudio.example.test/callback",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("unexpected scope");
  });

  test("sanitizes a missing deployment-managed secret", async () => {
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CONTENT_PICKER_API_KEY;
    delete process.env.GOOGLE_CONTENT_PICKER_APP_ID;
    __resetGoogleOAuthConfigForTests();
    mockSecretsSend.mockRejectedValue(
      new Error("Secrets Manager can't find the specified secret"),
    );

    await expect(loadGoogleContentOAuthConfig()).rejects.toThrow(
      "Google Drive is not configured for this environment",
    );
  });

  test("sanitizes malformed deployment configuration", async () => {
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_CONTENT_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CONTENT_PICKER_API_KEY;
    delete process.env.GOOGLE_CONTENT_PICKER_APP_ID;
    __resetGoogleOAuthConfigForTests();
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: "incomplete" }),
    });

    await expect(loadGoogleContentOAuthConfig()).rejects.toThrow(
      "Google Drive is not configured for this environment",
    );
  });
});

describe("Google content WIF contract", () => {
  test("pins the infrastructure-delivered audience and service account", () => {
    expect(GOOGLE_CONTENT_WIF_CONFIG).toEqual({
      projectNumber: "1022506104054",
      poolId: "aws-agent-broker",
      providerId: "content-sync",
      serviceAccountEmail:
        "unified-content-sync@psd-aistudio-broker.iam.gserviceaccount.com",
    });
  });
});
