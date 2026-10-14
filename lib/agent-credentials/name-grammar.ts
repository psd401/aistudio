/**
 * Credential name grammar — the single source of truth.
 *
 * A credential name becomes the last path segment of the secret's id
 * (`psd-agent-creds/{env}/user/{email}/{name}`), so the grammar is a security
 * boundary: no slash means no traversal out of the owner's prefix.
 *
 * This lives in its own module, with no AWS SDK or database imports, so that
 * callers which must validate a name but must NOT pull in
 * `@aws-sdk/client-secrets-manager` — the consent-token layer and the
 * consent-link route (#1887) — can share the broker's exact rule instead of
 * hand-copying it. A copied regex drifts, and the drift surfaces as a
 * `write-failed` *after* the user has already typed their secret into the
 * entry page.
 */

/** 1-128 characters of letters, digits, dot, hyphen, or underscore. */
export const CREDENTIAL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/

/** True when `value` is a credential name the broker will accept. */
export function isCredentialName(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_NAME_RE.test(value)
}
