/**
 * Atrium surface helpers (shared by REST v1 + MCP)
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5). Small utilities both agent surfaces
 * use so behavior stays identical: resolving a collection slug-or-id to an id,
 * and building a reader deep link returned in tool/route results.
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections } from "@/lib/db/schema";
import { hasCapabilityAccess } from "@/utils/roles";
import { ForbiddenError, ValidationError } from "./errors";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function collectionIdByColumn(
  column: typeof contentCollections.id | typeof contentCollections.slug,
  value: string
): Promise<string | undefined> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: contentCollections.id })
        .from(contentCollections)
        .where(eq(column, value))
        .limit(1),
    "atrium.resolveCollectionId"
  );
  return rows[0]?.id;
}

/**
 * Resolve a `collection` argument (a slug OR a uuid) to a collection id, or
 * `undefined` when none is supplied. Throws a user-facing `ValidationError`
 * (→ 400) when it matches no collection.
 *
 * EXISTENCE is validated here — not deferred to the service. `contentService.create`
 * skips its own collection check when an explicit `visibility.level` is supplied
 * (the `??` short-circuits `collectionDefault`), so an unvalidated id would reach
 * the INSERT and surface as an opaque FK-violation 500 instead of a 400. A
 * uuid-shaped input is tried as an id first, then as a slug (a slug can itself be
 * uuid-shaped) — mirroring `loadByIdOrSlug`.
 *
 * Overloads: a REQUIRED (non-empty) argument always resolves to a `string` — the
 * function only returns `undefined` for a falsy input, and either resolves or
 * throws otherwise — so a caller passing a zod-validated `.min(1)` id needs no
 * `undefined` narrowing. Passing an optional/nullable value keeps the
 * `string | undefined` result.
 */
export function resolveCollectionId(collection: string): Promise<string>;
export function resolveCollectionId(
  collection?: string | null
): Promise<string | undefined>;
export async function resolveCollectionId(
  collection?: string | null
): Promise<string | undefined> {
  if (!collection) return undefined;
  if (UUID_RE.test(collection)) {
    const byId = await collectionIdByColumn(contentCollections.id, collection);
    if (byId) return byId;
    // Fall through: the value may be a uuid-shaped slug rather than an id.
  }
  const bySlug = await collectionIdByColumn(contentCollections.slug, collection);
  if (!bySlug) {
    throw new ValidationError("Collection not found", { collection });
  }
  return bySlug;
}

/** The internal reader deep link for a content object, returned in results. */
export function contentDeepLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}

/**
 * The PUBLIC (anonymous) reader link for a content object at `/p/[slug]` — the
 * `external_ref` the `public_web` publish adapter records and the URL a
 * public-web publication is served at (Phase 7, #1057). Built from
 * `ATRIUM_PUBLIC_BASE_URL` (the same base the internal deep link uses); the
 * §33 #7 decision serves `public_web` via the authenticated-but-anonymous Next
 * public route rather than a separate CloudFront/S3 static export, so the base is
 * the app origin and the path segment (`/p/` vs `/c/`) is the only difference.
 */
export function publicReaderLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/p/${slug}`;
}

/** The capability every Atrium authoring entry point (UI actions + agent surfaces) gates on. */
export const ATRIUM_CONTENT_CAPABILITY = "atrium-content";

/**
 * Gate a CONTENT-AUTHORING call (create/update/version/visibility/publish) by the
 * `atrium-content` feature capability — for SESSION callers only.
 *
 * Session scopes are role-derived (REV-SEC-161, `lib/api/auth-middleware.ts`), not
 * a wildcard, so `requireScope("content:*")` is no longer a pure no-op for a
 * session caller. But role-derived scopes and the `atrium-content` capability are
 * two independent grants (see capabilities-vs-scopes separation below) — a role's
 * scope mapping is not guaranteed to track the capability, so a logged-in user
 * whose role happens to carry a content scope could still lack `atrium-content`.
 * This function is the capability-side gate that every Atrium UI server action
 * already enforces, applied to session callers on the REST v1 / MCP surfaces too.
 *
 * `api_key` (`sk-`) and `jwt` (OIDC) callers are intentionally NOT gated here:
 * their access is scoped by an explicitly granted `content:*` scope (issuing an
 * sk- key with `content:create` is a deliberate authorization), and they carry no
 * browser session / capability grants. Reads are never gated (a viewer only sees
 * what `canView` admits regardless of capability).
 *
 * NOTE on the capabilities-vs-scopes separation: CLAUDE.md says do NOT gate
 * API/MCP endpoints with `hasCapabilityAccess()`. This is a deliberate, bounded
 * exception scoped to the ONE case that rule can't cover: a browser session on an
 * API/MCP surface authenticates via role-derived scopes, not a capability grant,
 * so `requireScope` alone cannot confirm `atrium-content` specifically. The
 * capability check is applied ONLY to that session path (the `authType !==
 * "session"` early-return keeps every genuine api_key/jwt/MCP-token caller purely
 * scope-gated) as a second, independent layer — not a substitute for scopes. Do
 * NOT extend this to non-session callers — that WOULD violate the separation.
 */
export async function assertContentAuthoringCapability(auth: {
  authType?: "session" | "api_key" | "jwt";
  cognitoSub: string;
}): Promise<void> {
  // Only browser sessions need the capability gate — their scopes come from role
  // mapping, not an explicit content grant; a missing authType is an internal
  // (non-HTTP) caller, so neither is a session and the gate does not apply.
  if (auth.authType !== "session") return;
  const allowed = await hasCapabilityAccess(
    ATRIUM_CONTENT_CAPABILITY,
    auth.cognitoSub
  );
  if (!allowed) {
    throw new ForbiddenError(
      "The atrium-content capability is required to author content",
      { capability: ATRIUM_CONTENT_CAPABILITY }
    );
  }
}
