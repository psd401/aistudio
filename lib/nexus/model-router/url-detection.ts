/**
 * Does a chat message name a page to open? (#1696 / FS#164087)
 *
 * A leaf module on purpose. Both the classifier (to suppress the implicit
 * web-search branch) and the router (to prefer a model that can actually call
 * `web_fetch`) have to answer this question the same way, and every test suite
 * that mocks `./classifier` would otherwise lose the router's copy of it.
 * Keeping the pattern here means one definition, no mock coupling, and no drift
 * between the two decisions.
 */

/**
 * An explicit http(s) URL in the message — the "paste a link" case. Bounded by
 * whitespace and common trailing delimiters so a link inside prose or markdown
 * still matches. No `g` flag: `test()` on a global regex is stateful across
 * calls.
 */
const EXPLICIT_URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']{3,}/i
/** Same pattern, global, for `replace()` only — never call `test()` on it. */
const EXPLICIT_URL_PATTERN_ALL = /\bhttps?:\/\/[^\s<>()[\]{}"']{3,}/gi

export function containsExplicitUrl(text: string): boolean {
  return EXPLICIT_URL_PATTERN.test(text)
}

/**
 * The message with every explicit URL removed, so wording checks read only what
 * the user wrote. A link like `https://news.example/latest-policy` must not make
 * the message itself read as a request for current information.
 */
export function stripExplicitUrls(text: string): string {
  return text.replace(EXPLICIT_URL_PATTERN_ALL, " ")
}
