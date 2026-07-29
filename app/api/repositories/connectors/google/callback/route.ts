import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { decryptToken } from "@/lib/crypto/token-encryption";
import { getIssuerUrl } from "@/lib/oauth/issuer-config";
import {
  requestGoogleDriveSync,
  upsertPersonalGoogleDriveConnector,
} from "@/lib/repositories/google-drive/connector-service";
import { exchangeGoogleAuthorizationCode } from "@/lib/repositories/google-drive/oauth";
import {
  GOOGLE_CONTENT_OAUTH_STATE_COOKIE_PREFIX,
  googleContentOAuthStateCookieName,
  type GoogleContentOAuthState,
} from "@/lib/repositories/google-drive/oauth-state";
import { requireRepositoryConnectorManager } from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

const STATE_MAX_AGE_MS = 5 * 60_000;
const oauthStateSchema = z.object({
  state: z.string(),
  codeVerifier: z.string().min(43).max(128),
  repositoryId: z.number().int().positive(),
  userId: z.number().int().positive(),
  createdAt: z.number().int().positive(),
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

interface OAuthStateCookieStore {
  getAll(): Array<{ name: string; value: string }>;
}

async function findMatchingOAuthState(
  cookieStore: OAuthStateCookieStore,
  returnedState: string,
): Promise<{
  cookieName: string;
  state: GoogleContentOAuthState;
} | null> {
  const candidates = cookieStore
    .getAll()
    .filter(({ name }) =>
      name.startsWith(GOOGLE_CONTENT_OAUTH_STATE_COOKIE_PREFIX),
    );
  for (const candidate of candidates) {
    try {
      const state = oauthStateSchema.parse(
        JSON.parse(await decryptToken(candidate.value)) as unknown,
      ) satisfies GoogleContentOAuthState;
      if (safeEqual(state.state, returnedState)) {
        return { cookieName: candidate.name, state };
      }
    } catch {
      // Ignore malformed/expired sibling state cookies. Only a timing-safe
      // match is allowed to route this callback to a repository.
    }
  }
  return null;
}

function completionUrl(
  repositoryId: number,
  result: "connected" | "failed",
): URL {
  const url = new URL(`/repositories/${repositoryId}`, getIssuerUrl());
  url.searchParams.set("googleDrive", result);
  return url;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.oauth.callback");
  const log = createLogger({
    requestId,
    action: "googleContent.oauth.callback",
  });
  const { searchParams } = new URL(request.url);
  const cookieStore = await cookies();
  const matchedState = await findMatchingOAuthState(
    cookieStore,
    searchParams.get("state") ?? "",
  );
  if (!matchedState) {
    timer({ status: "error", reason: "invalid_state" });
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }
  const { state } = matchedState;
  const repositoryId = state.repositoryId;
  cookieStore.delete(matchedState.cookieName);
  try {
    if (
      matchedState.cookieName !==
        googleContentOAuthStateCookieName(repositoryId) ||
      Date.now() - state.createdAt > STATE_MAX_AGE_MS
    ) {
      throw ErrorFactories.authInvalidToken("Google OAuth state");
    }
    const manager = await requireRepositoryConnectorManager(repositoryId);
    if (manager.userId !== state.userId) {
      throw ErrorFactories.authInvalidToken("Google OAuth session");
    }

    // OAuth error callbacks do not carry a code. Treat the absence of a code as
    // failure after unconditional state validation rather than branching on
    // the provider-controlled `error` parameter.
    const code = searchParams.get("code");
    if (!code) {
      throw ErrorFactories.missingRequiredField("authorization code");
    }

    const tokens = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: state.codeVerifier,
      redirectUri: `${getIssuerUrl()}/api/repositories/connectors/google/callback`,
    });
    if (!tokens.refreshToken) {
      throw ErrorFactories.externalServiceError(
        "Google OAuth",
        new Error("Offline refresh token was missing")
      );
    }
    const connectorId = await upsertPersonalGoogleDriveConnector({
      repositoryId,
      userId: manager.userId,
      refreshToken: tokens.refreshToken,
      grantedScopes: tokens.scopes,
    });
    await requestGoogleDriveSync({
      connectorId,
      trigger: "initial",
    }).catch(() => {
      // The database next_sync_at row is the durable outbox; the scheduled
      // worker will recover a transient SQS dispatch failure.
    });
    timer({ status: "success" });
    log.info("Google Drive connector authorized", {
      repositoryId,
      connectorId,
      userId: manager.userId,
    });
    return NextResponse.redirect(completionUrl(repositoryId, "connected"));
  } catch {
    timer({ status: "error" });
    log.warn("Google Drive callback rejected", { repositoryId });
    return NextResponse.redirect(completionUrl(repositoryId, "failed"));
  }
}
