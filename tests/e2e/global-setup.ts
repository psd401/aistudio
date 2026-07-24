import { chromium, type FullConfig } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { authenticateContext } from "./helpers/session-auth";

/**
 * Local E2E global setup: (1) generate authenticated storageState files, and
 * (2) browser-warm dev routes.
 *
 * (1) AUTH STATE — many specs (nexus/*, assistant-architect, admin)
 * were written against a global authenticated session saved to tests/e2e/.auth/*.json
 * (the standard Playwright storageState pattern) that was never wired up, so they
 * ran unauthenticated and timed out. We mint two seeded sessions here and persist
 * them; authed describes opt in via `test.use({ storageState })`, and
 * nexus-conversation-ownership reads user-a/user-b directly. Runs whenever
 * PLAYWRIGHT_AUTH_ENABLED=true.
 *
 * (2) WARM — the suite runs against `next dev`, which lazily compiles each route's
 * server AND client bundle on first hit (5-15s). Under parallel load that blows the
 * tight per-action timeouts and looks like real failures. We compile each route once
 * with a real authenticated browser. Gated on PLAYWRIGHT_WARM=1 (set by the runner).
 */

const AUTH_DIR = "tests/e2e/.auth";

// user-a = admin (holds every capability); user-b = staff (a distinct identity for
// ownership/permission tests). Subs must match scripts/db/seed-local.sql.
const SESSIONS: Array<{ file: string; email: string; sub: string }> = [
  { file: "user-a.json", email: "test@example.com", sub: "e2e-test-user" },
  { file: "user-b.json", email: "staff@example.com", sub: "e2e-staff-user" },
];

// Every route the suite navigates to (derived from page.goto across tests/e2e),
// warmed once serially here so the parallel run never compiles a route under load
// (which thrashed a cold dev server). Keep in sync when specs add new routes.
const WARM_ROUTES = [
  "/",
  "/dashboard",
  "/nexus",
  "/nexus/decision-capture",
  "/admin/users",
  "/admin/roles",
  "/admin/agents",
  "/admin/agents/skills/review",
  "/admin/credentials",
  "/admin/skill-review",
  "/admin/settings",
  "/admin/tools",
  "/repositories",
  "/prompt-library",
  "/compare",
  "/settings",
  "/skills",
  "/agent-connect",
  "/utilities/assistant-architect",
  "/utilities/assistant-architect/create",
  "/utilities/assistant-catalog",
  // Heavy dynamic routes for the seeded fixture architect (assistant-architect-seed.sql).
  "/utilities/assistant-architect/9000/edit/prompts", // ReactFlow editor
  "/tools/assistant-architect/9000", // execution/streaming page
  "/atrium/a7100000-0000-4000-8000-000000004040/edit",
  "/c/board-procedure-4040",
];

export default async function globalSetup(config: FullConfig) {
  if (process.env.PLAYWRIGHT_AUTH_ENABLED !== "true") return;

  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ||
    config.projects[0]?.use?.baseURL ||
    "http://localhost:3000";

  const browser = await chromium.launch();
  try {
    // (1) Auth storageState files.
    await mkdir(AUTH_DIR, { recursive: true });
    for (const s of SESSIONS) {
      const ctx = await browser.newContext({ baseURL });
      await authenticateContext(ctx, s.email, s.sub);
      await ctx.storageState({ path: `${AUTH_DIR}/${s.file}` });
      await ctx.close();
    }
    console.log(`[setup] wrote ${SESSIONS.length} storageState files to ${AUTH_DIR}/`);

    // (2) Route warm-up (optional).
    if (process.env.PLAYWRIGHT_WARM === "1") {
      const started = Date.now();
      console.log(`[warm] compiling ${WARM_ROUTES.length} routes via browser @ ${baseURL} …`);
      const ctx = await browser.newContext({ baseURL });
      await authenticateContext(ctx, SESSIONS[0].email, SESSIONS[0].sub);
      const page = await ctx.newPage();
      for (const route of WARM_ROUTES) {
        try {
          await page.goto(route, { waitUntil: "domcontentloaded", timeout: 90_000 });
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        } catch {
          console.log(`[warm] (skipped) ${route}`);
        }
      }
      await ctx.close();
      console.log(`[warm] done in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  } finally {
    await browser.close();
  }
}
