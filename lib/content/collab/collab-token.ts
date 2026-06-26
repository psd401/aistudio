/**
 * Atrium collab session token (#1051)
 *
 * A short-TTL signed token that authorizes one browser to open a specific
 * document's collaboration websocket. Minted by the `/api/content/[id]/collab`
 * route AFTER a `canView`/`canEdit` check, verified by the Hocuspocus collab
 * server's `onAuthenticate`. This mirrors Proof's `collab-session` token: the
 * websocket itself carries no ambient cookie trust — authorization is an explicit,
 * per-document, expiring grant that also encodes write permission.
 *
 * Signed with HS256 using AUTH_SECRET (already present for Auth.js). Claims:
 *   sub = users.id (string), oid = content object id, w = may write (boolean).
 */

import { SignJWT, jwtVerify } from "jose";

const ISSUER = "atrium-collab";
const AUDIENCE = "atrium-collab-ws";
const TTL_SECONDS = 300; // 5 minutes; the provider refreshes by reconnecting.

export interface CollabClaims {
  /** users.id as a string. */
  sub: string;
  /** content object id (the Yjs document name). */
  oid: string;
  /** whether this session may write (else read-only). */
  w: boolean;
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not configured; cannot sign collab tokens");
  }
  return new TextEncoder().encode(secret);
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
