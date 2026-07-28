import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

interface ExportAssistantPayload {
  name: string;
  description: string;
  status: string;
  prompts: Array<{
    name: string;
    content: string;
    model_name: string;
    position: number;
  }>;
  input_fields: Array<{
    name: string;
    label: string;
    field_type: string;
    position: number;
  }>;
}

interface MutationResponseBody {
  data?: {
    result?: {
      id?: number;
      name?: string;
      status?: string;
    };
    results?: Array<{
      id?: number;
      status?: string;
    }>;
    modelMappings?: unknown[];
    sourceAssistantId?: number;
  };
}

function importEnvelope(assistant: ExportAssistantPayload, exportedAt: string) {
  return {
    version: "1.0",
    exported_at: exportedAt,
    assistants: [assistant],
  };
}

async function createAssistant(
  page: Page,
  assistant: ExportAssistantPayload,
  exportedAt: string,
): Promise<number> {
  const response = await page.request.post("/api/v1/assistants/import", {
    data: importEnvelope(assistant, exportedAt),
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as MutationResponseBody;
  const sourceId = body.data?.results?.[0]?.id;
  expect(sourceId).toBeTruthy();
  expect(body.data?.results?.[0]?.status).toBe("pending_approval");
  expect(body.data?.modelMappings?.length).toBeGreaterThan(0);
  if (!sourceId) throw new Error("Create response omitted the assistant ID");
  return sourceId;
}

async function expectMalformedImportRejected(page: Page): Promise<void> {
  const response = await page.request.post("/api/v1/assistants/import", {
    headers: { "Content-Type": "application/json" },
    data: "{not-json",
  });
  expect(response.status()).toBe(400);
}

async function updateAssistant(
  page: Page,
  assistantId: number,
  assistant: ExportAssistantPayload,
  updatedName: string,
  exportedAt: string,
): Promise<void> {
  const updatedAssistant = {
    ...assistant,
    name: updatedName,
    description: "Updated atomically through the import API",
    status: "approved",
    prompts: [
      {
        ...assistant.prompts[0],
        content: "Explain {{topic}} in three bullets",
      },
    ],
  };
  const response = await page.request.put(`/api/v1/assistants/${assistantId}`, {
    data: importEnvelope(updatedAssistant, exportedAt),
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as MutationResponseBody;
  expect(body.data?.result).toMatchObject({
    id: assistantId,
    name: updatedName,
    status: "pending_approval",
  });
}

async function forkAssistant(
  page: Page,
  sourceId: number,
  forkName: string,
): Promise<number> {
  const response = await page.request.post(
    `/api/v1/assistants/${sourceId}/fork`,
    { data: { name: forkName } },
  );
  expect(response.status()).toBe(201);
  const body = (await response.json()) as MutationResponseBody;
  const forkId = body.data?.result?.id;
  expect(forkId).toBeTruthy();
  expect(forkId).not.toBe(sourceId);
  expect(body.data).toMatchObject({
    sourceAssistantId: sourceId,
    result: {
      name: forkName,
      status: "pending_approval",
    },
  });
  if (!forkId) throw new Error("Fork response omitted the assistant ID");
  return forkId;
}

async function expectAssistantDetail(
  page: Page,
  assistantId: number,
  expectedName: string,
): Promise<void> {
  const response = await page.request.get(`/api/v1/assistants/${assistantId}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data?: {
      id?: number;
      name?: string;
      description?: string;
      status?: string;
    };
  };
  expect(body.data).toMatchObject({
    id: assistantId,
    name: expectedName,
    status: "pending_approval",
  });
}

async function expectPendingRows(
  page: Page,
  sourceName: string,
  forkName: string,
): Promise<void> {
  await page.goto("/admin/assistants");
  await expect(page.getByText(sourceName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(forkName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const sourceRow = page
    .locator("table tbody tr")
    .filter({ hasText: sourceName });
  const forkRow = page.locator("table tbody tr").filter({ hasText: forkName });
  await expect(sourceRow.getByText("Pending")).toBeVisible();
  await expect(forkRow.getByText("Pending")).toBeVisible();
}

function createPayload(name: string): ExportAssistantPayload {
  return {
    name,
    description: "Created through the Assistant Architect import API",
    // The service must ignore caller-supplied approval.
    status: "approved",
    prompts: [
      {
        name: "Primary prompt",
        content: "Summarize {{topic}}",
        model_name: "agent-import-e2e-model",
        position: 0,
      },
    ],
    input_fields: [
      {
        name: "topic",
        label: "Topic",
        field_type: "short_text",
        position: 0,
      },
    ],
  };
}

/**
 * Authenticated functional flow for issue #1404:
 * create from ExportFormat -> replace -> fork -> verify source + admin UI.
 *
 * Requires the isolated host dev server/local DB harness documented in
 * docs/guides/e2e-authenticated-testing.md.
 */
test.describe("agent-assistant-import", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against an isolated host dev server — see docs/guides/e2e-authenticated-testing.md",
  );

  test("creates, updates, and forks a pending-approval assistant", async ({
    page,
  }, testInfo: TestInfo) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    );

    const suffix = `${Date.now()}-${testInfo.workerIndex}`;
    const sourceName = `Agent import ${suffix}`;
    const updatedName = `Agent import updated ${suffix}`;
    const forkName = `Agent import fork ${suffix}`;
    const exportedAt = new Date().toISOString();
    const assistant = createPayload(sourceName);

    const sourceId = await createAssistant(page, assistant, exportedAt);
    await expectMalformedImportRejected(page);
    await updateAssistant(page, sourceId, assistant, updatedName, exportedAt);
    await expectAssistantDetail(page, sourceId, updatedName);

    const forkId = await forkAssistant(page, sourceId, forkName);
    await expectAssistantDetail(page, sourceId, updatedName);
    await expectAssistantDetail(page, forkId, forkName);
    await expectPendingRows(page, updatedName, forkName);

    await page.screenshot({
      path: testInfo.outputPath("agent-assistant-import-pending.png"),
      fullPage: true,
    });
  });
});
