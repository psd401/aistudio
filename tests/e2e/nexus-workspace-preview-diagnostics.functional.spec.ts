import { test, expect, type Page, type BrowserContext } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";
import { CLOSE_SCRIPT, routeAppSandbox } from "./helpers/atrium-sandbox-host";
import {
  PREVIEW_DIAGNOSTICS_UNCONSUMED_HEADER,
  PREVIEW_DIAGNOSTICS_UNCONSUMED_VALUE,
} from "@/lib/nexus/preview-diagnostics-header";

/**
 * E2E (gated): the artifact preview's failures reach the chat exactly once, and
 * come back when the turn that carried them never looked at them (#1839).
 *
 * The one-shot buffer (`lib/atrium/artifact-preview-diagnostics.ts`) is TAKEN
 * when a Nexus message is sent. Unit tests cover the buffer and the server's
 * prompt block; this spec proves the browser wiring end to end:
 *  1. A real artifact throws inside a real cross-origin preview frame, the error
 *     is forwarded to the workspace panel, and the NEXT chat request body carries
 *     it as `workspacePreviewDiagnostics` — and the request after that does not.
 *  2. When the response carries `X-Preview-Diagnostics-Unconsumed` (what an
 *     image-generation or Deep Research turn returns), the client puts the
 *     entries back, so the following send carries them again.
 *
 * The frame is real: `scripts/test/e2e-local.sh` starts the server with
 * `ATRIUM_SANDBOX_ORIGIN` pointing at an unresolvable origin, and
 * `routeAppSandbox` serves the committed `infra/sandbox-host/render.html` there.
 * The chat responses are mocked (no model call), exactly like
 * `nexus-workspace-chat-tools.spec.ts` — what is under test is the request body
 * the browser builds, not what a model does with it.
 */

const SENTINEL = "e2e-1839-preview-sentinel";

/** A minimal UI-message stream, one distinct reply per send. */
function mockChatStream(reply: string): string {
  return [
    `data: {"type":"start","messageId":"e2e-${reply}"}\n\n`,
    `data: {"type":"text-start","id":"t-${reply}"}\n\n`,
    `data: {"type":"text-delta","id":"t-${reply}","delta":"${reply}"}\n\n`,
    `data: {"type":"text-end","id":"t-${reply}"}\n\n`,
    'data: {"type":"finish","finishReason":"stop"}\n\n',
    "data: [DONE]\n\n",
  ].join("");
}

interface SentDiagnostics {
  contentId: string;
  entries: { kind: string; message: string }[];
}

/**
 * In-page, before any app code: record every frame error the preview forwards.
 * The app's own listener receives the same event in the same dispatch, so once
 * this log has an entry the buffer has it too — the send can't race the frame.
 */
function collectFrameErrors(): void {
  const log: string[] = [];
  (window as unknown as { __e2eFrameErrors: string[] }).__e2eFrameErrors = log;
  window.addEventListener("message", (event) => {
    if (event.source === window) return;
    const data = event.data as { type?: string; message?: string };
    if (data?.type === "atrium-artifact-error") log.push(String(data.message));
  });
}

async function createThrowingArtifact(page: Page): Promise<{ id: string; slug: string }> {
  const res = await page.request.post("/api/v1/content", {
    data: {
      kind: "artifact",
      title: `Preview failure probe ${Date.now()}${Math.floor(Math.random() * 1000)}`,
      bodyFormat: "html",
      body:
        '<div id="out">dashboard</div>' +
        `<script>throw new Error("${SENTINEL}")${CLOSE_SCRIPT}`,
      visibility: { level: "private" },
    },
  });
  expect(res.status()).toBe(201);
  const data = (await res.json())?.data as { id: string; slug: string };
  return data;
}

/** Open the artifact beside the chat and wait until its preview has thrown. */
async function openFailingPreview(page: Page, slug: string): Promise<void> {
  await page.goto(`/nexus?workspace=${slug}`);
  await expect(page.getByTestId("workspace-panel")).toBeVisible({ timeout: 60_000 });
  const frame = page.getByTestId("artifact-sandbox-frame");
  const unavailable = page.getByTestId("artifact-sandbox-unavailable");
  await expect(frame.or(unavailable).first()).toBeVisible({ timeout: 60_000 });
  // Fail loudly, never skip: a missing frame means the server was not started by
  // scripts/test/e2e-local.sh (no ATRIUM_SANDBOX_ORIGIN), not that the feature works.
  expect(
    await unavailable.isVisible(),
    "Sandbox unconfigured — run via `bun run test:e2e:local` so the server gets ATRIUM_SANDBOX_ORIGIN"
  ).toBe(false);
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __e2eFrameErrors: string[] }).__e2eFrameErrors),
      { timeout: 30_000 }
    )
    .toEqual([expect.stringContaining(SENTINEL) as unknown as string]);
}

/**
 * Route the chat endpoint: record each body, and answer each send with the next
 * of `extraHeaders` (an empty object for an ordinary turn).
 */
async function routeChat(
  page: Page,
  extraHeaders: Record<string, string>[]
): Promise<{ bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/nexus/chat", async (route) => {
    const index = bodies.length;
    bodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        ...(extraHeaders[index] ?? {}),
      },
      body: mockChatStream(`reply-${index + 1}`),
    });
  });
  return { bodies };
}

/** Send one message and wait for its mocked reply to render. */
async function send(page: Page, text: string, replyNumber: number): Promise<void> {
  const input = page
    .locator('textarea, [contenteditable="true"][role="textbox"], [data-testid="composer-input"]')
    .first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByText(`reply-${replyNumber}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

function diagnosticsOf(body: Record<string, unknown> | undefined): SentDiagnostics | undefined {
  return body?.workspacePreviewDiagnostics as SentDiagnostics | undefined;
}

function expectCarriesSentinel(body: Record<string, unknown> | undefined, contentId: string): void {
  const sent = diagnosticsOf(body);
  expect(sent?.contentId).toBe(contentId);
  expect(sent?.entries).toEqual([
    expect.objectContaining({ kind: "script", message: expect.stringContaining(SENTINEL) }),
  ]);
}

const definePreviewDiagnosticsDeliverySuite = () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server started by scripts/test/e2e-local.sh"
  );
  // First hits compile /nexus and the workspace panel on the dev server.
  test.describe.configure({ timeout: 180_000 });

  let context: BrowserContext;
  let page: Page;
  let artifact: { id: string; slug: string };

  test.beforeEach(async ({ browser, baseURL }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    page = await context.newPage();
    await page.addInitScript(collectFrameErrors);
    await routeAppSandbox(page, new URL(baseURL ?? "http://localhost:3000").origin);
    artifact = await createThrowingArtifact(page);
  });

  test.afterEach(async () => {
    try {
      await page.request.delete(`/api/v1/content/${artifact.id}`);
    } catch {
      // Best-effort teardown; never mask the real failure.
    }
    await context.close();
  });

  test("the next send carries the preview failure, and the one after it does not", async () => {
    const chat = await routeChat(page, [{}, {}]);
    await openFailingPreview(page, artifact.slug);

    await send(page, "does my dashboard work?", 1);
    await send(page, "thanks", 2);

    expect(chat.bodies).toHaveLength(2);
    expectCarriesSentinel(chat.bodies[0], artifact.id);
    // TAKEN on send: a failure is reported once, not on every later turn.
    expect(diagnosticsOf(chat.bodies[1])).toBeUndefined();
  });

  test("an unconsumed turn puts the failure back for the next send", async () => {
    // The first reply is what a special route (image generation, Deep Research)
    // returns: it never built the prompt block, so the entries must survive.
    const chat = await routeChat(page, [
      { [PREVIEW_DIAGNOSTICS_UNCONSUMED_HEADER]: PREVIEW_DIAGNOSTICS_UNCONSUMED_VALUE },
      {},
      {},
    ]);
    await openFailingPreview(page, artifact.slug);

    await send(page, "draw me a chart", 1);
    await send(page, "does my dashboard work?", 2);
    await send(page, "thanks", 3);

    expect(chat.bodies).toHaveLength(3);
    expectCarriesSentinel(chat.bodies[0], artifact.id);
    // Restored by the header, so the ordinary turn after it still sees them...
    expectCarriesSentinel(chat.bodies[1], artifact.id);
    // ...and that turn consumed them.
    expect(diagnosticsOf(chat.bodies[2])).toBeUndefined();
  });
};

test.describe(
  "Nexus workspace preview failures reach the chat once (#1839, authenticated)",
  definePreviewDiagnosticsDeliverySuite
);
