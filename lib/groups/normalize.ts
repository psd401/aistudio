/**
 * Email / prefix normalization for group sync (Epic #1202, Phase 0).
 *
 * Google emails are case-insensitive and email is becoming an authorization join
 * key (Epic #1202), so EVERY write and EVERY comparison lowercases. These helpers
 * are the single normalization point shared by the admin UI (rule input) and the
 * selection resolver. The sync Lambda mirrors this one-liner in its own bundle
 * (it cannot import app code), so keep the rule trivial: trim + lowercase.
 */

/** Lowercase + trim an email (or group email). Returns "" for nullish input. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Normalize a selection prefix. Same rule as an email (trim + lowercase); a
 * prefix is matched with `startsWith` against normalized group emails.
 */
export function normalizePrefix(prefix: string | null | undefined): string {
  return (prefix ?? "").trim().toLowerCase();
}
