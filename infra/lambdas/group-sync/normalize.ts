/**
 * Email normalization for the group-sync Lambda.
 *
 * Mirrors lib/groups/normalize.ts in the app (the Lambda is an isolated bundle and
 * cannot import app code). Keep this trivial so the two copies cannot drift:
 * Google emails are case-insensitive and email is an authorization join key, so
 * every write and comparison lowercases.
 */

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
