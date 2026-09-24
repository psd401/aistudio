/**
 * Assistant Architect composer attachments (#1735 / FS#165437).
 *
 * Reported journey: open an Assistant Architect tool page, press the composer's
 * attachment (paperclip) button, pick a file — and nothing happened, with
 * `Unhandled Promise Rejection: Error: Attachments are not supported` in the
 * console on every attempt. The shared composer rendered the button even though
 * the Assistant Architect runtime had no attachment adapter.
 *
 * This spec drives that journey end to end:
 *   1. an approved fixture assistant is executed,
 *   2. the composer's paperclip is present once the thread renders,
 *   3. choosing a document attaches it (a chip appears) instead of rejecting,
 *   4. no "Attachments are not supported" error reaches the page.
 *
 * The `/api/assistant-architect/execute` stream is stubbed so the run completes
 * deterministically without a model provider — what is under test is the
 * client-side runtime wiring, not model output. The upload endpoints are stubbed
 * for the same reason: the assertion is that the adapter accepts the file and the
 * composer shows it, not that S3 is reachable from the test machine.
 */

import { mkdir } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import type postgres from "postgres";
import { test, expect } from "./fixtures";
import { authenticateContext, SEEDED_STAFF_SUB } from "./helpers/session-auth";

type TestDatabase = postgres.Sql;

const ATTACHMENT_UNSUPPORTED = /Attachments are not supported/i;

interface ArchitectFixture {
  architectId: number;
  name: string;
}

/**
 * A completed Assistant Architect execution stream. Ending the stream is what
 * flips the thread out of "running", which `StreamingStateMonitor` turns into
 * `hasResults` — the state in which the composer takes follow-up turns.
 */
const EXECUTION_STREAM = [
  `data: ${JSON.stringify({ type: "start" })}`,
  "",
  `data: ${JSON.stringify({ type: "text-start", id: "t1" })}`,
  "",
  `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "Fixture result." })}`,
  "",
  `data: ${JSON.stringify({ type: "text-end", id: "t1" })}`,
  "",
  `data: ${JSON.stringify({ type: "finish" })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

async function createArchitectFixture(
  sql: TestDatabase,
  stamp: number
): Promise<ArchitectFixture> {
  const [staff] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE cognito_sub = ${SEEDED_STAFF_SUB}
  `;
  if (!staff) throw new Error("Seeded staff user is missing");

  const [model] = await sql<{ id: number }[]>`
    SELECT id FROM ai_models WHERE active = true ORDER BY id LIMIT 1
  `;
  if (!model) throw new Error("No active AI model is configured");

  const name = `E2E Attachment Assistant ${stamp}`;
  const [architect] = await sql<{ id: number }[]>`
    INSERT INTO assistant_architects (name, description, status, user_id)
    VALUES (
      ${name},
      'Fixture assistant for the composer attachment regression test',
      'approved',
      ${staff.id}
    )
    RETURNING id
  `;
  if (!architect) throw new Error("Assistant fixture was not created");

  await sql`
    INSERT INTO tool_input_fields (assistant_architect_id, name, label, field_type, position)
    VALUES (${architect.id}, 'topic', 'Topic', 'short_text', 0)
  `;
  // The literal placeholder the architect substitutes the input field into. Kept
  // in a variable so the `${...}` is not swallowed by the tagged template.
  const promptContent = "Consider: ${topic}";
  await sql`
    INSERT INTO chain_prompts (assistant_architect_id, name, content, model_id, position)
    VALUES (${architect.id}, 'Main', ${promptContent}, ${model.id}, 0)
  `;

  return { architectId: architect.id, name };
}

async function dropArchitectFixture(
  sql: TestDatabase,
  architectId: number | null
): Promise<void> {
  // tool_input_fields and chain_prompts cascade from assistant_architects.
  if (architectId !== null) {
    await sql`DELETE FROM assistant_architects WHERE id = ${architectId}`;
  }
}

/**
 * Stubs the execute stream plus both upload paths the document adapter can take
 * (the unified temporary-attachment endpoint and the legacy document upload), so
 * the test never depends on a model provider or on S3.
 */
async function stubBackends(page: Page): Promise<void> {
  await page.route("**/api/assistant-architect/execute", route =>
    route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Execution-Id": "424242",
        "X-Prompt-Count": "1",
      },
      body: EXECUTION_STREAM,
    })
  );
  await page.route("**/api/repositories/temporary-attachments**", route =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "stubbed", code: "STORAGE_UNAVAILABLE" }),
    })
  );
  await page.route("**/api/documents/v2/**", route =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "stubbed", code: "STORAGE_UNAVAILABLE" }),
    })
  );
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function runAttachmentTest(
  { page }: { page: Page },
  testInfo: TestInfo
): Promise<void> {
  const postgresClient = (await import("postgres")).default;
  const sql = postgresClient(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" }
  );
  let architectId: number | null = null;

  try {
    const fixture = await createArchitectFixture(sql, Date.now());
    architectId = fixture.architectId;

    await authenticateContext(page.context());
    await stubBackends(page);
    const errors = collectPageErrors(page);

    await page.goto(`/tools/assistant-architect/${fixture.architectId}`);
    await page.getByLabel("Topic").fill("Attachment regression check");
    await page.getByRole("button", { name: /generate/i }).click();

    // The composer only exists once the execution pane mounts.
    const paperclip = page.getByRole("button", { name: "Add Attachment" });
    await expect(paperclip).toBeVisible({ timeout: 30_000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await paperclip.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "blind-spot-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Notes the assistant should read."),
    });

    // The attachment is accepted and shown instead of rejecting.
    await expect(page.getByText("blind-spot-notes.txt").first()).toBeVisible({
      timeout: 30_000,
    });

    await mkdir(".verification", { recursive: true });
    await page.screenshot({
      path: `.verification/assistant-architect-attachment-${testInfo.project.name}.png`,
      fullPage: true,
    });

    expect(
      errors.filter(message => ATTACHMENT_UNSUPPORTED.test(message))
    ).toEqual([]);
  } finally {
    await dropArchitectFixture(sql, architectId);
    await sql.end();
  }
}

function defineAttachmentSuite(): void {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server"
  );
  test(
    "composer attaches a document instead of rejecting with 'Attachments are not supported'",
    runAttachmentTest
  );
}

test.describe("Assistant Architect composer attachments (#1735)", defineAttachmentSuite);
