/**
 * Cross-bundle contract checks for the OneRoster sync (#1310).
 *
 * The Lambda is intentionally isolated from Next.js, so these checks prevent
 * its duplicated setting names and deterministic invocation ARN from drifting.
 */

import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("OneRoster sync cross-bundle contracts", () => {
  const appSettings = source("lib/roster/settings.ts");
  const lambdaSettings = source(
    "infra/lambdas/oneroster-sync/config.ts"
  );
  const db = source("infra/lambdas/oneroster-sync/db.ts");
  const groupDb = source("infra/lambdas/group-sync/db.ts");
  const appGroupReconciler = source("lib/db/drizzle/user-roles.ts");

  it("keeps all shared database-first setting keys synchronized", () => {
    for (const key of [
      "ROSTER_SYNC_ENABLED",
      "ROSTER_ROLE_SYNC_ENABLED",
      "ONEROSTER_BASE_URL",
      "ONEROSTER_AUTH_MODE",
      "ONEROSTER_CREDENTIALS_SECRET_ARN",
      "ONEROSTER_API_VERSION",
      "ONEROSTER_PAGE_SIZE",
      "ONEROSTER_LAST_PERM_REV",
      "ONEROSTER_SYNC_STATUS",
    ]) {
      expect(appSettings).toContain(key);
      expect(lambdaSettings).toContain(key);
    }
  });

  it("grants ECS invoke access to the deterministic OneRoster function only", () => {
    const ecsService = source("infra/lib/constructs/ecs-service.ts");

    expect(ecsService).toContain(
      "function:psd-oneroster-sync-${environment}"
    );
  });

  it("chunks collection writes below 5,000 rows", () => {
    expect(db).toContain("const UPSERT_CHUNK_SIZE = 4_000");
  });

  it("source-scopes role writes and structurally excludes administrator", () => {
    expect(db).toContain(
      "SELECT computed.user_id, computed.role_id, 'oneroster'"
    );
    expect(db).toContain("WHERE managed.source = 'oneroster'");
    expect(db).toContain(
      "lower(protected_role.name) = 'administrator'"
    );
    expect(db).not.toContain(
      "SELECT computed.user_id, computed.role_id, 'administrator'"
    );
  });

  it("hands overlapping unique rows to the surviving managed provider", () => {
    expect(db).toContain("SET source = 'group-sync'");
    expect(groupDb).toContain("SET source = 'oneroster'");
    expect(appGroupReconciler).toContain('source: "oneroster"');

    for (const roleName of [
      "teacher",
      "aide",
      "proctor",
      "administrator",
      "districtadministrator",
      "siteadministrator",
      "systemadministrator",
    ]) {
      expect(db).toContain(roleName);
      expect(groupDb).toContain(roleName);
      expect(appGroupReconciler).toContain(roleName);
    }
  });

  it("applies absence deactivation only inside collection transactions", () => {
    expect(db).toContain("return sql.begin(async (tx) =>");
    expect(db).toContain(
      "const absent = await deactivateAbsent(tx, \"oneroster_orgs\", rows)"
    );
    expect(db).toContain("sourced_id <> ALL($1::text[])");
    expect(db).toContain("last_synced_at");
  });
});
