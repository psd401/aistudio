import { test, expect, type BrowserContext } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * Atrium Phase 1 full verification (#1051) — drives every surface against a live
 * dev server (server.ts on :3200 with the collab WS) and captures screenshots.
 *
 * Run:
 *   set -a && source .env.local && set +a
 *   PLAYWRIGHT_AUTH_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3200 \
 *     bunx playwright test tests/e2e/atrium-phase1-verify.spec.ts
 *
 * Prereqs: tests/e2e/fixtures/atrium-reference-seed.sql +
 * scripts/dev/seed-atrium-doc-state.ts applied (seeds the doc, agent Y.Doc state,
 * S3 body, and the building-scoped users).
 */

const OBJECT_ID = "a7100000-0000-4000-8000-000000004040";
const SLUG = "board-procedure-4040";
const SHOT = "docs/verification/atrium-phase1";

const ADMIN = { email: "test@example.com", sub: "e2e-test-user" };
const HS = { email: "hs-staff@example.com", sub: "e2e-hs-staff" };
const OUT = { email: "other-staff@example.com", sub: "e2e-other-staff" };

async function ctx(browser: import("@playwright/test").Browser, who: { email: string; sub: string }): Promise<BrowserContext> {
  const context = await browser.newContext();
  await authenticateContext(context, who.email, who.sub);
  return context;
}

test.describe("Atrium Phase 1 — route guards (always-run)", () => {
  test("collab token + agent-bridge are 401 unauthenticated", async ({ request }) => {
    expect((await request.get(`/api/content/${OBJECT_ID}/collab`)).status()).toBe(401);
    expect(
      (await request.post(`/api/content/${OBJECT_ID}/agent-bridge`, { data: { markdown: "# x" } })).status()
    ).toBe(401);
  });
});

test.describe("Atrium Phase 1 — authenticated surfaces", () => {
  // These tests all drive the SAME server-side collaborative document (one Y.Doc on
  // the dev server). Running them concurrently makes them clobber each other — e.g.
  // the agent-bridge "replace" wipes content another test is asserting on, and the
  // two-tab sync test competes for the same doc. Serialize this block so the shared
  // state is deterministic; other spec files still run in parallel on other workers.
  test.describe.configure({ mode: "serial" });

  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed dev server — see docs/guides/atrium-phase1-verification.md"
  );

  test("collab token: owner gets canEdit=true", async ({ browser }) => {
    const context = await ctx(browser, ADMIN);
    try {
      const res = await context.request.get(`/api/content/${OBJECT_ID}/collab`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.docName).toBe(OBJECT_ID);
      expect(body.canEdit).toBe(true);
      expect(typeof body.token).toBe("string");
    } finally {
      await context.close();
    }
  });

  test("reader: HS staff renders body + provenance footer", async ({ browser }) => {
    const context = await ctx(browser, HS);
    try {
      const page = await context.newPage();
      const res = await page.goto(`/c/${SLUG}`);
      expect(res?.status()).toBe(200);
      // Provenance footer (DB-only — agent-drafted + human-reviewed) renders
      // regardless of S3, so it's always asserted.
      await expect(page.locator('.atrium-provenance-badge[data-author="agent"]')).toBeVisible();
      await expect(page.locator('.atrium-provenance-badge[data-author="human"]')).toBeVisible();
      // The rendered BODY comes from the S3 source.md snapshot. CI runs without S3,
      // where the reader falls back to an empty article (the render pipeline itself
      // is covered by tests/smoke/atrium-markdown-render.smoke.ts). Assert the body
      // + callout/warn rendering only when S3 is available (set ATRIUM_E2E_HAS_S3).
      if (process.env.ATRIUM_E2E_HAS_S3 === "true") {
        await expect(page.locator(".atrium-content")).toContainText("Board Procedure 4040");
        await expect(page.locator(".atrium-content .atrium-callout").first()).toBeVisible();
        await expect(page.locator(".atrium-content .atrium-callout-warn")).toBeVisible();
      }
      await page.screenshot({ path: `${SHOT}/01-reader-hs-staff.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });

  test("reader: out-of-building user is 404 (existence-masking, not 403)", async ({ browser }) => {
    const context = await ctx(browser, OUT);
    try {
      const res = await context.request.get(`/c/${SLUG}`);
      // Non-viewable published doc 404s so its slug cannot be enumerated via 403.
      expect(res.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test("editor: loads seeded agent content with purple rail", async ({ browser }) => {
    const context = await ctx(browser, ADMIN);
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJECT_ID}/edit`);
      // Wait for the collab provider to sync the seeded Y.Doc into the editor.
      await expect(page.locator(".ProseMirror")).toContainText("Board Procedure 4040", {
        timeout: 60000,
      });
      // Agent-authored blocks carry the purple rail (data-author=agent).
      await expect(page.locator('.atrium-rail-block[data-author="agent"]').first()).toBeVisible({
        timeout: 60000,
      });
      // Collab ready signal: the Meridian sheet byline reports the synced ("saved")
      // state (the old "Connected" toolbar label was removed in the slice-C redesign).
      await expect(page.getByTestId("editor-byline")).toContainText("saved", { timeout: 60000 });
      await page.screenshot({ path: `${SHOT}/02-editor-agent-purple.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });

  test("editor: a human edit turns its block green", async ({ browser }) => {
    const context = await ctx(browser, ADMIN);
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJECT_ID}/edit`);
      const pm = page.locator(".ProseMirror");
      await expect(pm).toContainText("Board Procedure 4040", { timeout: 60000 });
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60000 });

      // Click into the LAST paragraph and append a new, all-human paragraph (so the
      // new block is unambiguously human-dominant rather than merging into an agent
      // block — deterministic green).
      await pm.locator("p").last().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Reviewed and approved by a human editor.");

      // Inline authored mark proves the edit is attributed to the human...
      await expect(
        page.locator('.ProseMirror span[data-author="human"]').first()
      ).toBeVisible({ timeout: 60000 });
      // ...and the new all-human block shows the green rail.
      await expect(
        page.locator('.atrium-rail-block[data-author="human"]').first()
      ).toBeVisible({ timeout: 60000 });
      await page.screenshot({ path: `${SHOT}/03-editor-human-green.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });

  test("collab: an edit in one tab syncs live to another", async ({ browser }) => {
    const a = await ctx(browser, ADMIN);
    const b = await ctx(browser, ADMIN);
    try {
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await pageA.goto(`/atrium/${OBJECT_ID}/edit`);
      await pageB.goto(`/atrium/${OBJECT_ID}/edit`);
      await expect(pageA.locator(".ProseMirror")).toContainText("Board Procedure 4040", { timeout: 60000 });
      await expect(pageB.locator(".ProseMirror")).toContainText("Board Procedure 4040", { timeout: 60000 });
      await expect(pageA.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true", { timeout: 60000 });

      const marker = `LIVE-SYNC-${Date.now()}`;
      await pageA.locator(".ProseMirror").click();
      await pageA.keyboard.press("End");
      await pageA.keyboard.press("Enter");
      await pageA.keyboard.type(marker);

      // The marker typed in A must appear in B via the Yjs websocket.
      await expect(pageB.locator(".ProseMirror")).toContainText(marker, { timeout: 60000 });
      await pageA.screenshot({ path: `${SHOT}/04-sync-tab-a.png`, fullPage: true });
      await pageB.screenshot({ path: `${SHOT}/05-sync-tab-b.png`, fullPage: true });
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("agent bridge: a server push appears live in the editor (purple)", async ({ browser }) => {
    const editorCtx = await ctx(browser, ADMIN);
    const apiCtx = await ctx(browser, ADMIN);
    try {
      const page = await editorCtx.newPage();
      await page.goto(`/atrium/${OBJECT_ID}/edit`);
      await expect(page.locator(".ProseMirror")).toContainText("Board Procedure 4040", { timeout: 60000 });

      const pushed = `Agent appended a compliance note ${Date.now()}.`;
      const res = await apiCtx.request.post(`/api/content/${OBJECT_ID}/agent-bridge`, {
        headers: { "x-agent-id": "ship-reporter" },
        data: {
          markdown: `# Board Procedure 4040 — One-pager\n\n${pushed}`,
          mode: "replace",
        },
      });
      expect(res.status()).toBe(200);

      await expect(page.locator(".ProseMirror")).toContainText(pushed, { timeout: 60000 });
      await page.screenshot({ path: `${SHOT}/06-agent-bridge-live.png`, fullPage: true });
    } finally {
      await editorCtx.close();
      await apiCtx.close();
    }
  });
});
