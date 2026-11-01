/**
 * Turn a mid-stream failure into something the user can act on (#1899, case 3).
 *
 * `toUIMessageStream()` was called with no `onError`, so the AI SDK's default
 * handler (`() => 'An error occurred.'`) is what reached the thread. Five words,
 * no distinction between "the provider is down", "this took too long" and "a
 * guardrail blocked it" — and nothing telling the user whether retrying is
 * worth it. That is the third of the blank/useless-reply shapes behind the
 * repeated resends reported in the #1899 fleet read.
 *
 * The mapping is deliberately coarse and allow-listed: the returned string is
 * rendered verbatim in the browser, so a raw provider message (which can carry
 * request ids, prompt fragments, internal hostnames, or model identifiers) is
 * never passed through. Classification reads the error, the reply never quotes it.
 */

/** The fixed set of user-facing explanations. Nothing else is ever returned. */
export const STREAM_ERROR_MESSAGES = {
  timeout:
    "The response took too long and was stopped. Please try again, or break the request into smaller parts.",
  rateLimited:
    "The AI service is busy right now and turned this request away. Please wait a moment and try again.",
  unavailable:
    "The AI service could not be reached. This is usually temporary — please try again in a moment.",
  contentBlocked:
    "The response was blocked by a content safety filter. Please rephrase your request.",
  tooLong:
    "This conversation is too long for the model to continue. Start a new chat, or shorten your request.",
  unknown:
    "Something went wrong while writing the response, so it stopped partway. Please try again.",
} as const;

export type StreamErrorKind = keyof typeof STREAM_ERROR_MESSAGES;

/** Everything about an error we are willing to look at, flattened to lower case. */
function errorFingerprint(error: unknown): { text: string; status?: number } {
  if (typeof error === "string") return { text: error.toLowerCase() };

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.name, record.message, record.code, record.type]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const rawStatus = record.statusCode ?? record.status;
    const status =
      typeof rawStatus === "number" && Number.isFinite(rawStatus)
        ? rawStatus
        : undefined;
    // Providers routinely wrap the real failure; look one level down too.
    const nested =
      record.cause && typeof record.cause === "object"
        ? errorFingerprint(record.cause).text
        : "";
    return { text: `${parts} ${nested}`.toLowerCase(), status };
  }

  return { text: "" };
}

/**
 * Classification rules, in priority order.
 *
 * Order matters: a provider reporting a timeout as `504 gateway timeout` must be
 * called a timeout, not a generic outage, so the timeout rule is first and the
 * broad 5xx rule is last.
 */
const CLASSIFICATION_RULES: ReadonlyArray<{
  kind: StreamErrorKind;
  needles: readonly string[];
  matchesStatus?: (status: number) => boolean;
}> = [
  {
    kind: "timeout",
    needles: ["timeout", "timed out", "etimedout", "deadline", "aborterror", "aborted"],
  },
  {
    kind: "rateLimited",
    needles: ["rate limit", "ratelimit", "too many requests", "quota", "throttl"],
    matchesStatus: status => status === 429,
  },
  {
    kind: "contentBlocked",
    needles: ["content filter", "content_filter", "guardrail", "safety", "blocked", "prohibited"],
  },
  {
    kind: "tooLong",
    needles: [
      "context length",
      "context_length",
      "too many tokens",
      "maximum context",
      "prompt is too long",
    ],
  },
  {
    kind: "unavailable",
    needles: [
      "overloaded",
      "unavailable",
      "service_unavailable",
      "bad gateway",
      "econnreset",
      "econnrefused",
      "enotfound",
      "fetch failed",
      "network error",
    ],
    matchesStatus: status => status >= 500,
  },
];

/** Which explanation fits this error. */
export function classifyStreamError(error: unknown): StreamErrorKind {
  const { text, status } = errorFingerprint(error);

  for (const rule of CLASSIFICATION_RULES) {
    if (typeof status === "number" && rule.matchesStatus?.(status)) return rule.kind;
    if (rule.needles.some(needle => text.includes(needle))) return rule.kind;
  }

  return "unknown";
}

/**
 * The `onError` handler for `toUIMessageStream()`: a specific, sanitized
 * explanation in place of "An error occurred.".
 */
export function sanitizeStreamErrorMessage(error: unknown): string {
  return STREAM_ERROR_MESSAGES[classifyStreamError(error)];
}
