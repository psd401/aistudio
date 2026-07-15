/**
 * Default role for a NEWLY-PROVISIONED user (Epic #1202, Phase 4 / #1207).
 *
 * Single source of truth for the username heuristic that used to be duplicated,
 * verbatim, in lib/auth/resolve-user.ts and actions/db/get-current-user-action.ts.
 * A K-12 convention: student accounts are all-digit ID emails
 * (e.g. 123456@psd401.net), everyone else is staff. An empty/absent username
 * resolves to 'staff' — the exact behavior of the prior inline
 * `/^\d+$/.test("") === false` code.
 *
 * LEGACY FALLBACK — being retired. Group-sync is now the authoritative role source:
 * both provisioning paths call the managed-role reconciler immediately AFTER
 * assigning this default (reconcileUserManagedRoles), so a user who is a member of a
 * mapped group receives their real role at provisioning regardless of this value.
 * This heuristic therefore only decides the role for a user who is in NO mapped
 * group.
 *
 * RETIREMENT IS COVERAGE-GATED (#1207). Reducing this to a no-role default —
 * `return null` (assign nothing; rely entirely on group-sync) — is safe only once
 * staff group→role coverage is confirmed, because otherwise a newly-provisioned
 * staff member who is not yet in a mapped group would receive no role. Confirm with:
 *
 *   DATABASE_URL=<prod> bun run scripts/db/report-heuristic-only-roles.ts
 *
 * and follow the decision rule in docs/features/google-group-sync.md (§ "Retiring the
 * username heuristic"). Until that report is run and approved, this preserves the
 * pre-#1207 behavior EXACTLY — but now from one place, so the eventual reduction is a
 * single edit here rather than two divergent copies.
 *
 * @returns the role name to assign, or `null` to assign no default role.
 */
export function defaultRoleForNewUser(email: string | null | undefined): string | null {
  const username = (email ?? "").split("@")[0];
  // Numeric username prefix → student (all-digit district student IDs); anything
  // else (including an empty username) → staff.
  const isNumeric = /^\d+$/.test(username);
  return isNumeric ? "student" : "staff";
}
