import { createHash, randomBytes } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { decryptToken } from "@/lib/crypto/token-encryption";
import { GOOGLE_DRIVE_SCOPE } from "./formats";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CONTENT_CONFIGURATION_ERROR =
  "Google Drive is not configured for this environment";

const googleContentSecretSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  pickerApiKey: z.string().min(1),
  appId: z.string().min(1),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface GoogleContentOAuthConfig {
  clientId: string;
  clientSecret: string;
  pickerApiKey: string;
  appId: string;
}

export interface GoogleAccessToken {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  scopes: string[];
}

let secretsClient: SecretsManagerClient | null = null;
let cachedConfig: {
  value: GoogleContentOAuthConfig;
  expiresAt: number;
} | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) secretsClient = new SecretsManagerClient({});
  return secretsClient;
}

function secretId(): string {
  const override = process.env.GOOGLE_CONTENT_OAUTH_SECRET_ID?.trim();
  if (override) return override;
  const environment =
    process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev";
  return `aistudio/${environment}/google-content-oauth`;
}

function envConfig(): GoogleContentOAuthConfig | null {
  const values = {
    clientId: process.env.GOOGLE_CONTENT_OAUTH_CLIENT_ID?.trim(),
    clientSecret: process.env.GOOGLE_CONTENT_OAUTH_CLIENT_SECRET?.trim(),
    pickerApiKey: process.env.GOOGLE_CONTENT_PICKER_API_KEY?.trim(),
    appId: process.env.GOOGLE_CONTENT_PICKER_APP_ID?.trim(),
  };
  if (
    !values.clientId ||
    !values.clientSecret ||
    !values.pickerApiKey ||
    !values.appId
  ) {
    return null;
  }
  return {
    clientId: values.clientId,
    clientSecret: values.clientSecret,
    pickerApiKey: values.pickerApiKey,
    appId: values.appId,
  };
}

export async function loadGoogleContentOAuthConfig(): Promise<GoogleContentOAuthConfig> {
  const configuredFromEnv = envConfig();
  if (configuredFromEnv) return configuredFromEnv;
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }

  try {
    const result = await getSecretsClient().send(
      new GetSecretValueCommand({ SecretId: secretId() }),
    );
    if (!result.SecretString) {
      throw new Error(GOOGLE_CONTENT_CONFIGURATION_ERROR);
    }
    const config = googleContentSecretSchema.parse(
      JSON.parse(result.SecretString) as unknown,
    );
    cachedConfig = { value: config, expiresAt: Date.now() + 5 * 60_000 };
    return config;
  } catch {
    // AWS SDK errors include provider and resource details that are useful only
    // to operators. Keep the public route response stable and non-disclosing.
    throw new Error(GOOGLE_CONTENT_CONFIGURATION_ERROR);
  }
}

export function generateGooglePkce(): {
  verifier: string;
  challenge: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function scopesFromResponse(value: string | undefined): string[] {
  if (!value) return [GOOGLE_DRIVE_SCOPE];
  return value.split(/\s+/).filter(Boolean);
}

async function parseTokenResponse(
  response: Response,
): Promise<GoogleAccessToken> {
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed (${response.status})`);
  }
  const token = tokenResponseSchema.parse(await response.json());
  const scopes = scopesFromResponse(token.scope);
  if (scopes.length !== 1 || scopes[0] !== GOOGLE_DRIVE_SCOPE) {
    throw new Error("Google OAuth returned an unexpected scope set");
  }
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in,
    refreshToken: token.refresh_token ?? null,
    scopes,
  };
}

export async function exchangeGoogleAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetch?: typeof fetch;
}): Promise<GoogleAccessToken> {
  const config = await loadGoogleContentOAuthConfig();
  const fetchImpl = input.fetch ?? fetch;
  return parseTokenResponse(
    await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        grant_type: "authorization_code",
      }),
    }),
  );
}

export async function refreshGoogleAccessToken(input: {
  encryptedRefreshToken: string;
  fetch?: typeof fetch;
}): Promise<GoogleAccessToken> {
  const config = await loadGoogleContentOAuthConfig();
  const refreshToken = await decryptToken(input.encryptedRefreshToken);
  const fetchImpl = input.fetch ?? fetch;
  return parseTokenResponse(
    await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
    }),
  );
}

export async function revokeGoogleRefreshToken(input: {
  encryptedRefreshToken: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const token = await decryptToken(input.encryptedRefreshToken);
  const response = await (input.fetch ?? fetch)(GOOGLE_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Google OAuth revocation failed (${response.status})`);
  }
}

export function __resetGoogleOAuthConfigForTests(): void {
  cachedConfig = null;
  secretsClient = null;
}
