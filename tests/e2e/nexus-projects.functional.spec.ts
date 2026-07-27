import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

const STAFF_EMAIL = "staff@example.com";
const STAFF_SUB = "e2e-staff-user";
const SHARED_REPOSITORY = "E2E Unified Content Repository";
const OWNER_ONLY_REPOSITORY = "E2E Owner Only Repository";

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", method, id, ...(params ? { params } : {}) };
}

function defineNexusProjectsAuthenticatedSuite1Part1() {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and seeded users"
  );

  test("persists project context, membership, private files, and project chats", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    );

    const suffix = Date.now();
    const projectName = `E2E Nexus project ${suffix}`;
    const originalInstructions = "Use the current approved project sources.";
    const updatedInstructions =
      "Use the current approved project sources and cite each policy.";

    await page.goto("/nexus/projects");
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("Project instructions").fill(originalInstructions);
    await page.getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/\/nexus\/projects\/[0-9a-f-]+$/, {
      timeout: 30_000,
    });
    const projectId = page.url().split("/").at(-1);
    expect(projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    await expect(
      page.getByRole("heading", { name: projectName })
    ).toBeVisible();
    await expect(page.getByText("Private project repository")).toBeVisible();
    await page
      .getByLabel("Project instructions")
      .fill(updatedInstructions);
    await page.getByRole("button", { name: "Save context" }).click();
    await expect(page.getByText("Project updated")).toBeVisible();

    await page.getByLabel("Member email").fill(STAFF_EMAIL);
    await page.getByLabel("Member role").selectOption("editor");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`${STAFF_EMAIL} · editor`)).toBeVisible();

    await authenticateContext(page.context(), STAFF_EMAIL, STAFF_SUB);
    await page.reload();
    await expect(page.getByText("Your role: editor")).toBeVisible();
    await expect(page.getByLabel("Member email")).toHaveCount(0);
    await expect(page.getByLabel("Project instructions")).toHaveValue(
      updatedInstructions
    );

    await page.getByRole("button", { name: "New project chat" }).click();
    await expect(page).toHaveURL(/\/nexus\?conversationId=[0-9a-f-]+&projectId=\d+$/, {
      timeout: 30_000,
    });
    expect(new URL(page.url()).searchParams.get("projectId")).toBe(String(projectId));

    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    );
    await page.goto(`/nexus/projects/${projectId}`);
    await page
      .getByRole("button", { name: `Remove ${STAFF_EMAIL}` })
      .click();
    await expect(page.getByText("Member removed")).toBeVisible();
    await expect(page.getByText(`${STAFF_EMAIL} · editor`)).toHaveCount(0);

    await authenticateContext(page.context(), STAFF_EMAIL, STAFF_SUB);
    const removedMemberResponse = await page.goto(
      `/nexus/projects/${projectId}`
    );
    expect(removedMemberResponse?.status()).toBe(404);
  });

  }

function defineNexusProjectsAuthenticatedSuite1Part2() {test("queries only live authorized repositories over REST and MCP with a revocable scoped key", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await authenticateContext(page.context(), STAFF_EMAIL, STAFF_SUB);
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API Keys" }).click();

    const keyName = `E2E repository catalog ${Date.now()}`;
    let rawKey: string | null = null;
    const keyRow = () =>
      page
        .getByText(keyName, { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");

    try {
      await page.getByRole("button", { name: "Generate Key" }).click();
      const createDialog = page.getByRole("dialog", {
        name: "Generate API Key",
      });
      await createDialog.getByLabel("Key Name").fill(keyName);
      for (const scope of [
        "repositories:list",
        "repositories:read",
        "repositories:search",
        "repositories:changes",
      ]) {
        await createDialog
          .getByRole("checkbox", { name: scope, exact: false })
          .click();
      }
      await createDialog.getByRole("button", { name: "Create Key" }).click();

      const createdDialog = page.getByRole("alertdialog", {
        name: "Save Your API Key",
      });
      rawKey = (await createdDialog.locator("code").textContent())?.trim() ?? null;
      expect(rawKey).toMatch(/^sk-[\da-f]{64}$/);
      await createdDialog
        .getByRole("button", { name: "I've saved my key" })
        .click();

      const authHeaders = { Authorization: `Bearer ${rawKey}` };
      const listResponse = await page.request.get(
        `/api/v1/repositories?query=${encodeURIComponent("E2E")}`,
        { headers: authHeaders }
      );
      expect(listResponse.status()).toBe(200);
      const listBody = (await listResponse.json()) as {
        data: Array<{ id: number; name: string }>;
      };
      expect(listBody.data.map((repository) => repository.name)).toContain(
        SHARED_REPOSITORY
      );
      expect(listBody.data.map((repository) => repository.name)).not.toContain(
        OWNER_ONLY_REPOSITORY
      );
      const sharedRepository = listBody.data.find(
        (repository) => repository.name === SHARED_REPOSITORY
      );
      expect(sharedRepository).toBeDefined();

      const mcpResponse = await page.request.post("/api/mcp", {
        headers: authHeaders,
        data: rpc("tools/call", {
          name: "repositories_list",
          arguments: { query: "E2E" },
        }),
      });
      expect(mcpResponse.status()).toBe(200);
      const mcpBody = (await mcpResponse.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const mcpCatalog = JSON.parse(
        mcpBody.result?.content?.[0]?.text ?? "{}"
      ) as { repositories?: Array<{ name: string }> };
      expect(
        mcpCatalog.repositories?.map((repository) => repository.name)
      ).toContain(SHARED_REPOSITORY);
      expect(
        mcpCatalog.repositories?.map((repository) => repository.name)
      ).not.toContain(OWNER_ONLY_REPOSITORY);

      const changesResponse = await page.request.get(
        `/api/v1/repositories/changes?repositoryIds=${sharedRepository?.id}`,
        { headers: authHeaders }
      );
      expect(changesResponse.status()).toBe(200);
      const changesBody = (await changesResponse.json()) as {
        data: Array<{ repositoryId: number; itemName: string }>;
      };
      expect(changesBody.data.length).toBeGreaterThan(0);
      expect(
        changesBody.data.every(
          (change) => change.repositoryId === sharedRepository?.id
        )
      ).toBe(true);
    } finally {
      if (rawKey) {
        await expect(keyRow()).toBeVisible();
        await keyRow().getByRole("button", { name: "Revoke" }).click();
        await page
          .getByRole("alertdialog", { name: "Revoke API Key?" })
          .getByRole("button", { name: "Revoke Key" })
          .click();
        await expect(keyRow()).toContainText("Revoked");

        const revokedResponse = await page.request.get("/api/v1/repositories", {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        expect(revokedResponse.status()).toBe(401);
      }
    }
  });
}

const defineNexusProjectsAuthenticatedSuite1 = () => {
  defineNexusProjectsAuthenticatedSuite1Part1()
  defineNexusProjectsAuthenticatedSuite1Part2()
};

test.describe("Nexus Projects (authenticated)", defineNexusProjectsAuthenticatedSuite1);

const defineRepositoryCatalogAPIGuardsSuite2 = () => {
  test("rejects catalog requests without an API credential", async ({
    request,
  }) => {
    const list = await request.get("/api/v1/repositories");
    expect(list.status()).toBe(401);

    const search = await request.post("/api/v1/repositories/search", {
      data: { query: "policy" },
    });
    expect(search.status()).toBe(401);
  });
};

test.describe("Repository catalog API guards", defineRepositoryCatalogAPIGuardsSuite2);
