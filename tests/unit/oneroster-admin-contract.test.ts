/**
 * Cross-surface contracts for the #1311 administrator UI.
 *
 * These source checks complement behavior/E2E coverage by pinning the isolated
 * Lambda status writer and the admin-registry route, which cannot share imports.
 */


import path from "node:path";
import { ALL_ADMIN_PAGES } from "@/app/(protected)/admin/_lib/admin-pages";
import { validatedFs } from "@/lib/filesystem/validated-fs";

function source(relativePath: string): string {
  return validatedFs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("OneRoster administrator contracts", () => {
  it("registers /admin/rosters in the admin hub", () => {
    expect(
      ALL_ADMIN_PAGES.find((page) => page.href === "/admin/rosters")
    ).toMatchObject({
      title: "Rosters",
      slug: "rosters",
    });
  });

  it("persists and polls a shared run id without a token endpoint flow", () => {
    const trigger = source("lib/roster/trigger.ts");
    const lambda = source("infra/lambdas/oneroster-sync/index.ts");
    const component = source(
      "app/(protected)/admin/rosters/_components/rosters-admin.tsx"
    );

    expect(trigger).toContain("requestedByUserId, runId");
    expect(lambda).toContain("writeStatusSafely");
    expect(lambda).toContain('state: "running"');
    expect(lambda).toContain('"succeeded"');
    expect(lambda).toContain('"failed"');
    expect(component).toContain("syncInFlightRef");
    expect(component).toContain("pollForRun");
    expect(component).toContain("monitorPersistedRun");
    expect(component).toContain("isOneRosterSyncStatusActive");
    expect(component).not.toMatch(/token[_ -]?url/i);
  });

  it("discards stale school and class roster responses", () => {
    const component = source(
      "app/(protected)/admin/rosters/_components/rosters-admin.tsx"
    );

    expect(component).toContain("schoolRequestRef");
    expect(component).toContain("rosterRequestRef");
    expect(component).toContain("requestId !== schoolRequestRef.current");
    expect(component).toContain("requestId !== rosterRequestRef.current");
  });

  it("keeps roster rows read-only in the application layer", () => {
    const queries = source("lib/roster/queries.ts");
    const actions = source("actions/db/roster-admin-actions.ts");

    expect(queries).not.toMatch(/\.(?:insert|update|delete)\(oneroster/i);
    expect(actions).not.toMatch(/\.(?:insert|update|delete)\(oneroster/i);
    expect(actions).toContain('hasRole("administrator")');
  });
});
