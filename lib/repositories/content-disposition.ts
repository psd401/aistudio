/**
 * Build a safe `Content-Disposition` header value from a user-controlled display
 * filename (REV-COR-071). The repository download flow passes this via S3's
 * `ResponseContentDisposition`, which S3 reflects VERBATIM into the response
 * header — so a raw double-quote or control char in the name would break/alter
 * the header. We emit a sanitized quoted ASCII form plus an RFC 5987 `filename*`
 * so non-ASCII names still round-trip.
 *
 * Extracted from repository-items.actions.ts (a "use server" module, whose
 * exports must be async server actions) so this pure helper is unit-testable.
 */
export function toContentDispositionValue(name: string): string {
  // Keep only printable ASCII (drops control chars + non-ASCII), then remove the
  // quote/backslash that could break out of the quoted form. Empty → "download".
  const asciiSafe = name.replace(/[^ -~]/g, "").replace(/["\\]/g, "").trim() || "download"
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  )
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`
}
