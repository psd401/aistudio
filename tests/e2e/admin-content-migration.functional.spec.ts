import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

test.describe("Unified content migration admin workflow", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host :3100 dev server",
  );

  test("an administrator can inventory sources and record a dry run", async ({
    page,
  }) => {
    const postgres = (await import("postgres")).default;
    const database = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" },
    );
    let createdRunId: string | null = null;
    try {
      const existingRuns = new Set(
        (
          await database<{ id: string }[]>`
            SELECT id
            FROM repository_migration_runs
            WHERE mode = 'dry_run'
          `
        ).map((run) => run.id),
      );
      await authenticateContext(
        page.context(),
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB,
      );
      await page.goto("/admin/repositories");
      const panel = page.getByTestId("content-migration-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText("Unified content migration")).toBeVisible();
      await expect(
        page.getByTestId("content-retirement-readiness"),
      ).toBeVisible();

      await panel.getByRole("button", { name: "Dry run" }).click();
      await expect
        .poll(
          async () => {
            const [created] = await database<{ id: string }[]>`
              SELECT id
              FROM repository_migration_runs
              WHERE mode = 'dry_run'
              ORDER BY created_at DESC
              LIMIT 1
            `;
            createdRunId =
              created && !existingRuns.has(created.id) ? created.id : null;
            return createdRunId;
          },
          {
            message: "the administrator action should persist a new dry run",
            timeout: 15_000,
          },
        )
        .not.toBeNull();
    } finally {
      if (createdRunId) {
        await database`
          DELETE FROM repository_migration_runs
          WHERE id = ${createdRunId}::uuid
            AND mode = 'dry_run'
        `;
      }
      await database.end();
    }
  });
});
