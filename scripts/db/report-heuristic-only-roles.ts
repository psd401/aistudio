/**
 * Heuristic-only-role report (Epic #1202, Phase 4 / #1207).
 *
 * The user-provisioning path assigns a DEFAULT role from a username heuristic
 * (`/^\d+$/.test(username) ? 'student' : 'staff'` — see lib/auth/resolve-user.ts and
 * actions/db/get-current-user-action.ts). #1207 asks: once group→role mapping
 * coverage is confirmed, remove or reduce that heuristic to a no-role default. This
 * report quantifies the blast radius of doing so.
 *
 * WHY THIS IS A PROXY, NOT AN EXACT MEASURE. `addUserRole` stamps the default role
 * with source='manual' (the column default) — identical to an admin-assigned role —
 * so a heuristic-assigned role is NOT distinguishable from a hand-assigned one by
 * source alone. The faithful proxy for "relies on the heuristic/manual default, not
 * on group-sync" is: a user holds a role with source='manual' that group-sync would
 * NOT compute for them (they are in no active group whose group_role_mapping grants
 * that role). Those users would keep their role today (removal only changes NEW
 * provisioning), but they are the shape of user who, if newly provisioned AFTER the
 * heuristic is removed, would receive NO role.
 *
 * The "computed" set below mirrors reconcileManagedRoles / reconcileUserManagedRoles
 * EXACTLY (active group, lower(email) join on both sides) so the coverage number is
 * the same one the reconcilers act on.
 *
 * Run against the TARGET database (read-only; never writes):
 *   DATABASE_URL=postgres://... bun run scripts/db/report-heuristic-only-roles.ts
 *
 * DECISION RULE (documented in docs/features/google-group-sync.md):
 *   - "manual default role, no group-sync coverage" ≈ 0 for staff  → safe to drop
 *     the non-numeric→staff branch (rely on group-sync for staff).
 *   - large for staff → keep the staff default (or map the missing staff groups
 *     first, then re-run this report).
 *   - numeric→student is least-privilege and low-risk regardless.
 */

import postgres from "postgres";
import { scriptLogger as log } from "./script-logger";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";

async function main(): Promise<void> {
  log.section("AI Studio - Heuristic-Only-Role Report (#1207)");
  log.info("Database", { url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@") });

  const sql = postgres(DATABASE_URL, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    // The (user_id, role_id) set group-sync WOULD compute — same join the
    // reconcilers use (active group, lower(email) on both sides). A FUNCTION, not a
    // stored fragment: postgres.js fragments carry per-use state, so build a fresh
    // one at each interpolation (avoids reusing one fragment object across queries).
    const computedCte = () => sql`
      computed AS (
        SELECT DISTINCT u.id AS user_id, grm.role_id
          FROM group_role_mappings grm
          JOIN groups g
            ON lower(g.group_email) = lower(grm.group_email)
           AND g.is_active = true
          JOIN group_members gm ON gm.group_id = g.id
          JOIN users u ON lower(u.email) = lower(gm.member_email)
      )
    `;

    // 1. Population overview.
    const [overview] = await sql<
      { total_users: number; with_roles: number; without_roles: number }[]
    >`
      SELECT count(*)::int AS total_users,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
             ))::int AS with_roles,
             count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
             ))::int AS without_roles
        FROM users u
    `;
    log.info("Population", { ...overview });

    // 2. Per-role: manual grants that group-sync does NOT reproduce — the
    //    heuristic/manual-reliant grants. Numeric-username breakdown lets us see
    //    the student (numeric) vs staff (non-numeric) split the heuristic encodes.
    const perRole = await sql<
      {
        role_name: string;
        manual_no_group_coverage: number;
        of_which_numeric_username: number;
      }[]
    >`
      WITH ${computedCte()}
      SELECT r.name AS role_name,
             count(*)::int AS manual_no_group_coverage,
             count(*) FILTER (
               WHERE split_part(u.email, '@', 1) ~ '^\\d+$'
             )::int AS of_which_numeric_username
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        JOIN users u ON u.id = ur.user_id
       WHERE ur.source = 'manual'
         AND NOT EXISTS (
           SELECT 1 FROM computed c
            WHERE c.user_id = ur.user_id AND c.role_id = ur.role_id
         )
       GROUP BY r.name
       ORDER BY manual_no_group_coverage DESC
    `;
    log.section("Manual roles NOT reproduced by group-sync (per role)");
    if (perRole.length === 0) {
      log.success("None — every manual role is also computed from a group mapping.");
    } else {
      for (const row of perRole) {
        log.info(row.role_name, {
          manualNoGroupCoverage: row.manual_no_group_coverage,
          ofWhichNumericUsername: row.of_which_numeric_username,
        });
      }
    }

    // 3. Users whose ENTIRE role set is manual + uncovered by group-sync — the
    //    clearest "would have no role if newly provisioned post-removal" cohort.
    const [heuristicOnly] = await sql<
      { count: number; numeric_username: number }[]
    >`
      WITH ${computedCte()}
      SELECT count(*)::int AS count,
             count(*) FILTER (WHERE split_part(u.email, '@', 1) ~ '^\\d+$')::int
               AS numeric_username
        FROM users u
       WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_roles ur
            WHERE ur.user_id = u.id
              AND (
                ur.source <> 'manual'
                OR EXISTS (
                  SELECT 1 FROM computed c
                   WHERE c.user_id = ur.user_id AND c.role_id = ur.role_id
                )
              )
         )
    `;
    log.section("Heuristic-reliant users (all roles manual + no group-sync coverage)");
    log.info("Cohort", {
      users: heuristicOnly?.count ?? 0,
      numericUsername_student: heuristicOnly?.numeric_username ?? 0,
      nonNumericUsername_staff:
        (heuristicOnly?.count ?? 0) - (heuristicOnly?.numeric_username ?? 0),
    });
    log.info(
      "Interpretation: if the heuristic were removed, NEW users of this shape would " +
        "receive NO default role and rely entirely on group-sync. A large non-numeric " +
        "(staff) count means map the missing staff groups before dropping the staff branch."
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  log.error("Heuristic-only-role report failed to run", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(2);
});
