/**
 * What the chat thread shows when an assistant turn ends in an error (#1966).
 *
 * The server already sanitizes the errors it authors (`sanitizeStreamErrorMessage`
 * for mid-stream provider failures, fixed strings for non-2xx responses). What it
 * cannot sanitize is a failure in the BROWSER's read of the response body: when the
 * connection is cut after the 200 has started streaming (ALB idle timeout, a proxy
 * truncating a chunked body, a dropped network), `fetch`'s body reader rejects with
 * the browser's own network-stack text, and assistant-ui rendered `String(error)`
 * verbatim. Firefox users saw "Error in input stream" with no hint what to do.
 *
 * Only browser transport failures are rewritten. Every other message is app-authored
 * (already sanitized server text or a client message like "Session expired") and is
 * passed through unchanged.
 */

export const STREAM_INTERRUPTED_MESSAGE =
  "The connection was interrupted before the response finished. Please try again — " +
  "if it keeps happening, check your network connection or try a different browser.";

/**
 * Lower-cased openings of the errors browsers and runtimes raise when a response
 * body read or request fails at the transport level. Matched at the START of the
 * message (after an optional "TypeError: " / "net::" prefix), so app-authored text
 * that merely contains a phrase — "Upload failed", "…a network error…" — is kept.
 */
const TRANSPORT_FAILURE_SIGNATURES: readonly string[] = [
  "error in input stream", // Firefox: truncated/corrupted chunked body mid-read
  "networkerror when attempting to fetch resource", // Firefox: request failed
  "network error", // Chrome/Edge: body read failed mid-stream
  "failed to fetch", // Chrome/Edge: request failed
  "load failed", // Safari: request failed
  "the network connection was lost", // Safari
  "err_incomplete_chunked_encoding",
  "err_http2_protocol_error",
  "error in body stream",
];

/** Too generic to match as a prefix; only the bare error text counts. */
const EXACT_TRANSPORT_FAILURES: readonly string[] = [
  "terminated", // undici: connection closed mid-body
];

const RUNTIME_PREFIX = /^(?:typeerror:\s*|net::)/;

export function isBrowserTransportFailure(error: unknown): boolean {
  const text = errorText(error).trim().toLowerCase().replace(RUNTIME_PREFIX, "");
  if (!text) return false;
  return (
    EXACT_TRANSPORT_FAILURES.includes(text) ||
    TRANSPORT_FAILURE_SIGNATURES.some(signature => text.startsWith(signature))
  );
}

/** The message to render for a failed assistant turn. */
export function toDisplayableChatError(error: unknown): string {
  if (isBrowserTransportFailure(error)) return STREAM_INTERRUPTED_MESSAGE;
  return errorText(error);
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
