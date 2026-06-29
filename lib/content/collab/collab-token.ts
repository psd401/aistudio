/**
 * Atrium collab session token (#1051)
 *
 * A short-TTL signed token that authorizes one browser to open a specific
 * document's collaboration websocket. Minted by the `/api/content/[id]/collab`
 * route AFTER a `canView`/`canEdit` check, verified by the y-websocket-protocol
 * collab server's token verification step. This mirrors Proof's `collab-session`
 * token: the
 * websocket itself carries no ambient cookie trust — authorization is an explicit,
 * per-document, expiring grant that also encodes write permission.
 *
 * Signed with HS256 using COLLAB_JWT_SECRET, a key dedicated to collab tokens.
 * Unlike NextAuth session cookies (HttpOnly, SameSite, never in a URL), collab
 * tokens travel as a `?token=` query param and are therefore captured by ALB
 * access logs, reverse proxies, and load balancers. A dedicated key means an
 * AUTH_SECRET leak does not also hand an attacker the ability to forge collab
 * tokens with arbitrary `oid`/`w` claims (write access to any document). Falls
 * back to AUTH_SECRET only in development so existing deployments keep working;
 * production MUST set COLLAB_JWT_SECRET (see .env.example / ECS task definition).
 * Claims: sub = users.id (string), oid = content object id, w = may write (boolean).
 */

import { SignJWT, jwtVerify } from "jose";

const ISSUER = "atrium-collab";
const AUDIENCE = "atrium-collab-ws";
const TTL_SECONDS = 300; // 5 minutes; the client re-mints a fresh token on every websocket reconnect (DocumentEditor).

export interface CollabClaims {
  /** users.id as a string. */
  sub: string;
  /** content object id (the Yjs document name). */
  oid: string;
  /** whether this session may write (else read-only). */
  w: boolean;
}

function secretKey(): Uint8Array {
  // Dedicated key for collab tokens. Outside development, AUTH_SECRET is NOT an
  // acceptable fallback — collab tokens ride in URLs and must not share the
  // session-cookie signing key (see file header).
  const dedicated = process.env.COLLAB_JWT_SECRET;
  if (dedicated) {
    return new TextEncoder().encode(dedicated);
  }
  if (process.env.NODE_ENV !== "production") {
    const fallback = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (fallback) {
      return new TextEncoder().encode(fallback);
    }
  }
  throw new Error(
    "COLLAB_JWT_SECRET is not configured; cannot sign collab tokens (AUTH_SECRET fallback is dev-only)"
  );
}

/** Mint a collab session token for one document. */
export async function signCollabToken(claims: CollabClaims): Promise<string> {
  return new SignJWT({ oid: claims.oid, w: claims.w })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey());
}

/**
 * Verify a collab session token. Returns the claims, or null if the token is
 * missing/invalid/expired. Never throws on a bad token (the collab server treats
 * null as "reject the connection").
 */
export async function verifyCollabToken(token: string | undefined | null): Promise<CollabClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.oid !== "string") {
      return null;
    }
    return { sub: payload.sub, oid: payload.oid, w: payload.w === true };
  } catch {
    return null;
  }
}
