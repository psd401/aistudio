/* eslint-disable logging/require-request-id, logging/require-logger-in-server-actions */
// The two rules above are path-based (they fire on any actions/ file); this is a
// non-action helper module, so they do not apply -- same as ./requester.ts.
// NOT a "use server" module: these are internal helpers shared by the two
// artifact data-bridge actions (`artifact-data.ts`, `artifact-query.ts`).
// `import "server-only"` makes a client-component import fail at build time.
import "server-only";

/**
 * Shared input guards for the Atrium artifact data bridge (#1517, #1705).
 *
 * `assertArtifactDataAccess` is the exclusivity gate the whole #1705 security
 * argument rests on: an artifact's `data_access` mode selects EXACTLY ONE of
 * the bridge's data surfaces (the record store or viewer-scoped queries), and
 * both actions call this one function so the check cannot drift between them.
 * See the `artifact-data.ts` header for why the modes can never be combined.
 */

import { ErrorFactories } from "@/lib/error-utils";
import { versionService } from "@/lib/content";
import { resolveVersionDataAccess } from "@/lib/content/types";
import type { ContentDataAccess, ContentVersionDTO } from "@/lib/content";
import type { createLogger } from "@/lib/logger";

export const MAX_CONTENT_ID_LENGTH = 200;

/** Lone surrogates and NUL are rejected by Postgres text columns. */
export function hasPostgresIncompatibleUnicode(value: string): boolean {
  if (value.includes("\u0000")) return true;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      else index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

export function validateContentId(contentId: unknown): string {
  if (typeof contentId !== "string") {
    throw ErrorFactories.missingRequiredField("contentId");
  }
  // Bound attacker-controlled work before trim scans or allocates a normalized
  // copy. Padded IDs are invalid rather than a path around the raw input cap.
  if (contentId.length > MAX_CONTENT_ID_LENGTH) {
    throw ErrorFactories.valueOutOfRange(
      "contentId",
      contentId.length,
      1,
      MAX_CONTENT_ID_LENGTH
    );
  }
  const normalized = contentId.trim();
  if (!normalized) {
    throw ErrorFactories.missingRequiredField("contentId");
  }
  if (hasPostgresIncompatibleUnicode(normalized)) {
    throw ErrorFactories.invalidInput(
      "contentId",
      null,
      "contentId must use PostgreSQL-compatible Unicode"
    );
  }
  return normalized;
}

/**
 * Refuse unless `content` is an artifact in exactly the `expected` mode.
 *
 * `records` and `query` are mutually exclusive by design (the exfiltration
 * loop described in `artifact-data.ts`); `none` means "no bridge data
 * operations at all". `notConfiguredMessage` is the reason given when the
 * artifact exists but is in a different mode.
 */
export function assertArtifactDataAccess(
  content: { kind: string; dataAccess: ContentDataAccess },
  expected: ContentDataAccess,
  notConfiguredMessage: string
): void {
  if (content.kind !== "artifact") {
    throw ErrorFactories.validationFailed([
      { field: "contentId", message: "Content is not an artifact" },
    ]);
  }
  if (content.dataAccess !== expected) {
    throw ErrorFactories.validationFailed([
      { field: "contentId", message: notConfiguredMessage },
    ]);
  }
}

/**
 * WHICH version is running, and the data-bridge mode IT was authored for
 * (#1789, extending #1787's audit resolution).
 *
 * Before #1789 the mode lived on the object, so a `/c/` reader's capability
 * followed whatever the author had most recently selected while working on a
 * draft: flipping a Live records-mode sign-up sheet to `query` broke
 * `AtriumData.submit` for every reader, with no republish. The mode is now
 * stamped on the version the code lives on, and every bridge action authorizes
 * against the version the page actually rendered.
 *
 * `requested` comes from a TRUSTED page prop (the published version id on `/c/`,
 * the head on the authoring surfaces), never from the sandboxed frame — but it
 * still crosses the client, so it is verified rather than believed:
 * `versionService.getById` is scoped by `objectId`, so an id belonging to
 * another object is refused outright and can never lend its mode to this one.
 *
 * The head needs no lookup on either axis: `contentService.update` keeps the
 * head's stamp equal to the object's mode, so the ordinary case costs no extra
 * query.
 *
 * A lookup that FAILS (a DB blip) falls back to the head — the pre-#1787
 * contract: the lookup chooses which version answers, and failing an otherwise
 * healthy operation on it reported "the data service is unavailable" for work
 * that never ran. The fallback is logged. A lookup that SUCCEEDS and finds
 * nothing still refuses: that id is not this object's.
 */
export async function resolveRenderedVersionAccess(
  content: {
    id: string;
    currentVersionId: string | null;
    dataAccess: ContentDataAccess;
  },
  requested: unknown,
  log: ReturnType<typeof createLogger>
): Promise<{ versionId: string | null; dataAccess: ContentDataAccess }> {
  const head = {
    versionId: content.currentVersionId,
    dataAccess: content.dataAccess,
  };
  if (typeof requested !== "string" || !requested.trim()) return head;
  const versionId = requested.trim();
  if (versionId === content.currentVersionId) return head;

  let version: ContentVersionDTO | null;
  try {
    version = await versionService.getById(content.id, versionId);
  } catch (error) {
    log.warn("Rendered version lookup failed; falling back to the head", {
      contentId: content.id,
      requestedVersionId: versionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return head;
  }
  if (!version) {
    throw ErrorFactories.invalidInput(
      "versionId",
      null,
      "versionId does not belong to this artifact"
    );
  }
  return {
    versionId: version.id,
    // Null (a version predating migration 183) resolves to the object's mode —
    // exactly the pre-#1789 behaviour, so the deploy changes no capability.
    dataAccess: resolveVersionDataAccess(version, content.dataAccess),
  };
}
