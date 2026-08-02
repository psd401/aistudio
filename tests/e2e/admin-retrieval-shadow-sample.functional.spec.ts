import { expect, test } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

test.describe("Retrieval-shadow sample admin workflow", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server",
  );

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context());
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: /Content Platform/ }).click();
  });

  test("runs a bounded sample from the guided rollout card", async ({ page }) => {
    const postgres = (await import("postgres")).default;
    const database = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" },
    );
    let repositoryId: number | null = null;
    let previousObservationId = 0;

    try {
      const [repository] = await database<{ id: number }[]>`
        SELECT id
        FROM knowledge_repositories
        WHERE metadata ->> 'e2eFixture' = 'unified-content'
        LIMIT 1
      `;
      if (!repository) {
        throw new Error("Unified-content E2E repository fixture is missing");
      }
      repositoryId = repository.id;
      const [observation] = await database<{ id: number }[]>`
        SELECT COALESCE(MAX(id), 0)::integer AS id
        FROM repository_retrieval_shadow_observations
        WHERE repository_id = ${repositoryId}
      `;
      previousObservationId = observation?.id ?? 0;

      const form = page.getByTestId("retrieval-shadow-sample-form");
      await expect(form).toBeVisible();
      await form.getByLabel("Repository ID").fill(String(repositoryId));
      await form
        .getByLabel("Sample queries (one per line)")
        .fill("attendance policy\nemergency closure procedure");
      await form.getByRole("button", { name: "Run shadow sample" }).click();

      await expect(
        form.getByText(
          /E2E Unified Content Repository: \d+ recorded, \d+ skipped/,
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        form.getByText("attendance policy", { exact: true }),
      ).toBeVisible();
      await expect(
        form.getByText("emergency closure procedure", { exact: true }),
      ).toBeVisible();
    } finally {
      if (repositoryId !== null) {
        await database`
          DELETE FROM repository_retrieval_shadow_observations
          WHERE repository_id = ${repositoryId}
            AND id > ${previousObservationId}
        `;
      }
      await database.end();
    }
  });

  test("shows an actionable error for an empty sample query", async ({ page }) => {
    const form = page.getByTestId("retrieval-shadow-sample-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Repository ID").fill("1");
    await form.getByRole("button", { name: "Run shadow sample" }).click();

    await expect(form.getByText("Sample query 1 must not be empty.")).toBeVisible();
  });
});
