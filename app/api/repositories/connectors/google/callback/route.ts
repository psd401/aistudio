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
  googleContentOAuthStateCookieName,
  type GoogleContentOAuthState,
} from "@/lib/repositories/google-drive/oauth-state";
import { requireRepositoryConnectorManager } from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

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

function repositoryIdFromState(state: string | null): number | null {
  if (!state) return null;
  const separator = state.indexOf(":");
  if (separator <= 0) return null;
  const repositoryId = Number(state.slice(0, separator));
  return Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? repositoryId
    : null;
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
  const returnedState = searchParams.get("state");
  const repositoryId = repositoryIdFromState(returnedState);
  if (!repositoryId) {
    timer({ status: "error", reason: "invalid_state_routing" });
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const cookieName = googleContentOAuthStateCookieName(repositoryId);
  const encryptedState = cookieStore.get(cookieName)?.value;
  cookieStore.delete(cookieName);
  try {
    // Validate CSRF/session state before branching on provider-controlled error
    // or code parameters.
    if (!encryptedState || !returnedState) {
      throw new Error("OAuth state is missing");
    }
    const state = oauthStateSchema.parse(
      JSON.parse(await decryptToken(encryptedState)) as unknown,
    ) satisfies GoogleContentOAuthState;
    if (
      state.repositoryId !== repositoryId ||
      !safeEqual(state.state, returnedState) ||
      Date.now() - state.createdAt > STATE_MAX_AGE_MS
    ) {
      throw new Error("OAuth state is invalid or expired");
    }
    const manager = await requireRepositoryConnectorManager(repositoryId);
    if (manager.userId !== state.userId) {
      throw new Error("OAuth session changed");
    }

    const providerError = searchParams.get("error");
    if (providerError) {
      throw new Error("Google authorization was not completed");
    }
    const code = searchParams.get("code");
    if (!code) throw new Error("Authorization code is missing");

    const tokens = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: state.codeVerifier,
      redirectUri: `${getIssuerUrl()}/api/repositories/connectors/google/callback`,
    });
    if (!tokens.refreshToken) {
      throw new Error("Google did not return an offline refresh token");
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
    log.info("Personal Google Drive connector authorized", {
      repositoryId,
      connectorId,
      userId: manager.userId,
    });
    return NextResponse.redirect(completionUrl(repositoryId, "connected"));
  } catch {
    timer({ status: "error" });
    log.warn("Personal Google Drive callback rejected", { repositoryId });
    return NextResponse.redirect(completionUrl(repositoryId, "failed"));
  }
}
