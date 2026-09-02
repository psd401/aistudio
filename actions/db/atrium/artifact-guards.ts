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
import type { ContentDataAccess } from "@/lib/content";

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
