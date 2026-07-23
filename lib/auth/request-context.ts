import { headers } from "next/headers";

// The inbound x-request-id is attacker-controlled and flows into the logging
// correlation field, so accept it only when it matches a bounded, safe allowlist
// (no CRLF, control chars, or oversized values that could forge/spoof log lines);
// otherwise fall back to a generated UUID (REV-SEC-189).
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export async function getRequestId(): Promise<string> {
  const headersList = await headers();
  const headerValue = headersList.get("x-request-id");
  if (headerValue && REQUEST_ID_PATTERN.test(headerValue)) {
    return headerValue;
  }
  return crypto.randomUUID();
}

export async function createRequestContext() {
  return {
    requestId: await getRequestId(),
    timestamp: Date.now(),
  };
}