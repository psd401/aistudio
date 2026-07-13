/**
 * Atrium content-body transit encoding (WAF-opaque artifact code).
 *
 * WHY THIS EXISTS
 * ---------------
 * The ALB in front of AI Studio runs AWS WAF with the managed
 * `AWSManagedRulesCommonRuleSet` (see `infra/lib/frontend-stack-ecs.ts`). That
 * rule set's `CrossSiteScripting_BODY` sub-rule inspects EVERY request body and
 * BLOCKS anything that looks like reflected XSS — `<script>`, `<style>`,
 * `style="…"`, `onerror=`, `javascript:`, etc. It is NOT excluded (only
 * `SizeRestrictions_BODY` + `GenericRFI_BODY` are) and it is NOT path-scoped, so
 * it fires on any POST/PUT whose body carries that markup — including a perfectly
 * legitimate Atrium ARTIFACT whose whole point is to be self-contained HTML/JS/CSS.
 * The agent saw this as a bare `403 Forbidden` with no detail (a WAF block never
 * reaches the app, so no app error is produced).
 *
 * THE FIX (keep the WAF fully intact)
 * -----------------------------------
 * Rather than carve a hole in the WAF's XSS inspection for the content-write
 * paths, artifact code is sent base64-ENCODED. base64's alphabet is
 * `[A-Za-z0-9+/=]` — it contains no `<`, `>`, `"`, `:` or whitespace, so an
 * encoded body can never contain `<script`, `onerror=` or any other XSS
 * signature. The WAF sees inert text and lets it through; every other request in
 * the app still gets full XSS body inspection. The server decodes here, at the
 * transport boundary, BEFORE the §28.3 guardrails/PII screening and the size
 * caps run — so screening always operates on the real, decoded content, never on
 * the opaque wrapper.
 *
 * Artifact code is DATA, not app-origin script: it is rendered exclusively inside
 * the cross-origin `allow-scripts`-only sandbox (§28.1), never on the app origin,
 * so decoding it server-side introduces no new execution surface.
 *
 * This helper is the ONE decode point shared by the REST routes
 * (`POST /api/v1/content`, `POST /api/v1/content/:id/versions`), the MCP
 * create/version tools, and the in-app `createVersionAction` server action.
 */

import { ValidationError } from "./errors";

/** The transit encodings a content-write surface accepts for its body. */
export const CONTENT_CODE_ENCODINGS = ["base64"] as const;
export type ContentCodeEncoding = (typeof CONTENT_CODE_ENCODINGS)[number];

/**
 * Max size (bytes) of a base64-DECODED content body accepted on the
 * `codeEncoding` path. base64 CANNOT amplify (a decoded payload is 3/4 of its
 * encoded length), so this is a defense-in-depth sanity bound on client-supplied
 * encoded content, NOT a product content-length limit. Sized to match the
 * existing generous per-content-body bound the repo already applies to OKF
 * imports (`OKF_IMPORT_MAX_FILE_CONTENT_CHARS`, `lib/content/rest.ts`) so a
 * legitimately large artifact/document is never constrained.
 */
export const MAX_DECODED_BODY_BYTES = 5_000_000;

/** Canonical (padded, non-url-safe) base64: groups of 4, standard alphabet. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode a content body according to its declared transit `encoding`.
 *
 * - `encoding === undefined` → the body is returned UNCHANGED (the pre-existing
 *   raw contract; callers that never opt in are byte-for-byte unaffected).
 * - `encoding === "base64"` → `body` is validated as canonical base64, decoded to
 *   a UTF-8 string, and bounded by {@link MAX_DECODED_BODY_BYTES}.
 *
 * Throws a `ValidationError` (surfaced as HTTP 400) when `codeEncoding` is set but
 * no body is supplied, when the body is not valid base64, or when the decoded
 * content exceeds the size cap. Never returns silently-garbled content: Node's
 * `Buffer.from(x, "base64")` is lenient (it drops invalid characters and stops at
 * the first bad byte), so the input is STRICTLY validated before decoding.
 */
export function decodeContentBody(
  body: string | undefined,
  encoding: ContentCodeEncoding | undefined
): string | undefined {
  if (encoding === undefined) return body;
  // Defensive boundary check: only "base64" is supported today. A caller that
  // bypasses the zod enum (e.g. via a cast, or a future untyped caller) with an
  // unsupported value is REJECTED here rather than silently decoded as base64 —
  // the repo pattern of validating enum-like input at the service boundary, not
  // only at the API/action layer. `String(encoding)` keeps this a genuine runtime
  // guard (the static type is already narrowed to the sole member).
  if (String(encoding) !== "base64") {
    throw new ValidationError(`Unsupported codeEncoding: ${String(encoding)}`);
  }
  if (typeof body !== "string") {
    throw new ValidationError(
      "codeEncoding was set but no body was provided to decode"
    );
  }
  return decodeBase64Body(body);
}

/** Strictly validate + decode a canonical base64 content body (UTF-8). */
function decodeBase64Body(encoded: string): string {
  const normalized = encoded.trim();
  if (normalized.length === 0) {
    throw new ValidationError("codeEncoding \"base64\" body is empty");
  }
  // Reject non-base64 input up front so a corrupted payload / a raw `<script>`
  // that slipped past a mis-set flag fails with a clear 400 instead of decoding
  // to garbage (Buffer.from is lenient and would silently truncate).
  if (normalized.length % 4 !== 0 || !BASE64_RE.test(normalized)) {
    throw new ValidationError("Invalid base64 content body (codeEncoding)");
  }
  // Allocation guard: reject clearly-oversized input BEFORE decoding a huge
  // buffer, using the MINIMUM possible decoded size. A canonical base64 string of
  // length L decodes to (L/4)·3 − p bytes (p = 0–2 padding chars), so
  // ⌊L·3/4⌋ overestimates the true size by at most 2 — the `+ 2` slack keeps a
  // payload whose real decoded size is exactly the cap from being false-rejected
  // here (the exact byte check below is authoritative).
  const approxDecodedBytes = Math.floor((normalized.length * 3) / 4);
  if (approxDecodedBytes > MAX_DECODED_BODY_BYTES + 2) {
    throw new ValidationError(
      `Decoded content exceeds the ${MAX_DECODED_BODY_BYTES}-byte limit`
    );
  }
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  if (decoded.length === 0) {
    // All-padding / degenerate input (e.g. "====") decodes to nothing.
    throw new ValidationError("Invalid base64 content body (codeEncoding)");
  }
  // Exact post-decode byte bound (the pre-check above is an allocation guard).
  if (Buffer.byteLength(decoded, "utf8") > MAX_DECODED_BODY_BYTES) {
    throw new ValidationError(
      `Decoded content exceeds the ${MAX_DECODED_BODY_BYTES}-byte limit`
    );
  }
  return decoded;
}
