/**
 * Browser-side counterpart to `lib/content/code-encoding.ts`.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * `code-encoding.ts` decodes with Node's `Buffer` and is imported by route
 * handlers / server actions. The ENCODE half runs in a client component, so it
 * lives here and uses only Web APIs (`TextEncoder` + `btoa`). Keeping the two
 * halves apart avoids pulling a Node-only dependency into the client bundle.
 *
 * Every in-app content-write surface that can carry artifact code (the artifact
 * canvas save, the library "New artifact" / "Start blank" create) MUST encode
 * with this before posting: the edge WAF's `CrossSiteScripting_BODY` rule
 * inspects every request body and returns a bare 403 for `<script>` / `<style>`
 * / inline `style=` — markup a legitimate artifact always carries, including the
 * `ARTIFACT_STARTER_HTML` seed body. See `code-encoding.ts` for the full
 * rationale.
 */

/**
 * UTF-8-safe base64 encode of a content body.
 *
 * `btoa` only accepts Latin-1, so the text is encoded to UTF-8 bytes first. The
 * byte→binary-string conversion is chunked to stay clear of the
 * `String.fromCharCode` argument-count limit on large artifacts.
 */
export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
