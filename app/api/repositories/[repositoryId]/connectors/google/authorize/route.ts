import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { encryptToken } from "@/lib/crypto/token-encryption";
import { getIssuerUrl } from "@/lib/oauth/issuer-config";
import { assertGoogleContentSyncEnabled } from "@/lib/repositories/google-drive/connector-service";
import { GOOGLE_DRIVE_SCOPE } from "@/lib/repositories/google-drive/formats";
import {
  generateGooglePkce,
  loadGoogleContentOAuthConfig,
} from "@/lib/repositories/google-drive/oauth";
import {
  googleContentOAuthStateCookieName,
  type GoogleContentOAuthState,
} from "@/lib/repositories/google-drive/oauth-state";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

const STATE_MAX_AGE_SECONDS = 5 * 60;

export async function GET(
  _request: Request,
  context: { params: Promise<{ repositoryId: string }> },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.oauth.authorize");
  const log = createLogger({
    requestId,
    action: "googleContent.oauth.authorize",
  });
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    await assertGoogleContentSyncEnabled();
    const config = await loadGoogleContentOAuthConfig();
    const pkce = generateGooglePkce();
    const nonce = randomBytes(32).toString("base64url");
    const state = `${repositoryId}:${nonce}`;
    const statePayload: GoogleContentOAuthState = {
      state,
      codeVerifier: pkce.verifier,
      repositoryId,
      userId: manager.userId,
      createdAt: Date.now(),
    };
    const encryptedState = await encryptToken(JSON.stringify(statePayload));
    const callbackUri = `${getIssuerUrl()}/api/repositories/connectors/google/callback`;
    const authorizationUrl = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", callbackUri);
    authorizationUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("include_granted_scopes", "false");

    const cookieStore = await cookies();
    cookieStore.set(
      googleContentOAuthStateCookieName(repositoryId),
      encryptedState,
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: STATE_MAX_AGE_SECONDS,
        path: "/",
      },
    );
    timer({ status: "success" });
    log.info("Personal Google Drive authorization started", {
      repositoryId,
      userId: manager.userId,
    });
    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    timer({ status: "error" });
    log.warn("Personal Google Drive authorization rejected");
    return repositoryConnectorErrorResponse(error);
  }
}
