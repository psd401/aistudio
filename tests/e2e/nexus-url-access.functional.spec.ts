import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

import { validatedFs } from "@/lib/filesystem/validated-fs";

/**
 * E2E (gated): flow `nexus-url-access` — Nexus chat can open a pasted URL
 * (Issue #1696 / FS#164087, sharing a root cause with FS#164086).
 *
 * The reported bug: pasting a direct URL into Nexus chat returned "cannot
 * access URL directly". Chat's only internet-facing tool was provider-native
 * web SEARCH, which finds pages but cannot open a given link; Claude/Bedrock
 * models had no web tool of any kind. The fix attaches the in-process,
 * SSRF-guarded `web_fetch` tool to every turn on every provider.
 *
 * This drives a REAL model, because the thing under test is whether the model
 * is *able* to open the link — which no deterministic stub can demonstrate.
 * The deterministic half (tool is cataloged, is attached for every provider,
 * fetches text, still refuses internal hosts) is unit-tested in
 * tests/unit/lib/tools/web-fetch-tool.test.ts.
 *
 * Routing coverage matches the issue's acceptance criteria. Nexus does not
 * expose raw models in the composer — it exposes a routing mode
 * (`model-family-selector.tsx`): Standard lets the router choose (AUTO mode),
 * Advanced pins a family. So the cases are Advanced·Claude (the Bedrock path
 * that had NO web tool at all before this fix), Advanced·ChatGPT and
 * Advanced·Gemini (the providers that had search but no fetch), and Standard.
 *
 * TARGET URL: a real public page. The SSRF guard blocks localhost and private
 * ranges by design, so a local fixture server is deliberately unreachable and
 * cannot be used here. `https://example.com` is the stable, canonical choice.
 *
 * PREREQUISITES (why this is gated — it is NOT run in CI):
 *  - Host dev server (`bun run server.ts`) with PLAYWRIGHT_AUTH_ENABLED=true
 *    and chat-capable models configured for each family under test
 *    (docs/guides/e2e-authenticated-testing.md).
 *  - Outbound network access to the target URL from the app server.
 */

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? ".verification";
validatedFs.mkdirSync(SHOT_DIR, { recursive: true });

const TARGET_URL = process.env.NEXUS_URL_ACCESS_TARGET ?? "https://example.com";
/** Text that only appears in the reply if the page was actually retrieved. */
const EXPECTED_PAGE_TEXT = process.env.NEXUS_URL_ACCESS_EXPECT ?? "Example Domain";

/**
 * The failure the ticket reported. If any of these survive in the reply, the
 * model is still explaining a missing capability instead of using the tool.
 */
const REFUSAL_PATTERNS = [
  /can(?:no|')?t access (?:the |a )?URL/i,
  /cannot access (?:the |a )?URL/i,
  /unable to access (?:the )?(?:URL|internet|web)/i,
  /can(?:no|')?t browse the (?:web|internet)/i,
  /do(?:n'|es no)?t have (?:the )?ability to (?:access|browse|open)/i,
  /I do not have (?:internet|web) access/i,
];

/** Routing modes to cover. `family` undefined means Standard (AUTO) routing. */
const ROUTING_CASES: Array<{
  label: string;
  key: string;
  family?: "anthropic" | "openai" | "google";
}> = [
  // Listed first: before this fix Bedrock/Claude had no web tool of any kind,
  // so this is the case that proves the total-loss path is closed.
  { label: "advanced-claude", key: "anthropic", family: "anthropic" },
  { label: "advanced-chatgpt", key: "openai", family: "openai" },
  { label: "advanced-gemini", key: "google", family: "google" },
  { label: "standard-auto", key: "auto" },
];

/**
 * Which families this deployment actually has credentials for. The router drops
 * a family whose provider credentials are unconfigured ("Excluding models from
 * routing; provider credentials not configured"), and the chat turn then fails
 * with a generic error — indistinguishable in the UI from a real regression. So
 * the runner declares what is configured rather than the spec guessing, and a
 * partially-configured environment still reports honestly on what it CAN run.
 *
 * The default covers only what every environment has: Bedrock is always treated
 * as configured (ambient AWS credentials), and AUTO routing falls back to it. A
 * default that named openai/google turned the pre-push wall red on any machine
 * without those keys. Opt in where they exist:
 * NEXUS_URL_ACCESS_FAMILIES=anthropic,openai,google,auto
 */
const CONFIGURED_FAMILIES = (
  process.env.NEXUS_URL_ACCESS_FAMILIES ?? "anthropic,auto"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

/** Send a chat message and wait for the assistant to finish its reply. */
async function sendChat(
  page: import("@playwright/test").Page,
  text: string
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  // Done when an assistant message exists and the Send button is back. Generous
  // timeout: a cold model plus a live fetch round-trip.
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({
    timeout: 150_000,
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 150_000,
  });
}

/** Pin the routing mode via the composer's routing-mode menu. */
async function selectRouting(
  page: import("@playwright/test").Page,
  family?: "anthropic" | "openai" | "google"
): Promise<void> {
  await page.getByRole("button", { name: "Nexus routing mode" }).click();
  if (!family) {
    await page.getByTestId("nexus-mode-standard").click();
    return;
  }
  await page.getByTestId("nexus-mode-advanced").click();
  await page.getByTestId(`nexus-family-${family}`).click();
}

test.describe("Nexus chat — a pasted URL is opened, not refused (#1696)", () => {
  // A real model call plus a web fetch round-trip on a cold dev server needs
  // well over the default per-test budget.
  test.describe.configure({ timeout: 240_000 });

  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated host dev server — see docs/guides/e2e-authenticated-testing.md"
  );

  for (const { label, key, family } of ROUTING_CASES) {
    test(`${label}: reads the page instead of replying it cannot access URLs`, async ({
      browser,
    }) => {
      test.skip(
        !CONFIGURED_FAMILIES.includes(key),
        `${key} is not listed in NEXUS_URL_ACCESS_FAMILIES for this deployment`
      );

      const context = await browser.newContext();
      await authenticateContext(context);
      try {
        const page = await context.newPage();
        await page.goto("/nexus");

        await selectRouting(page, family);

        await sendChat(
          page,
          `Open ${TARGET_URL} and quote the exact main heading on that page.`
        );

        const lastReply = page.locator('[data-role="assistant"]').last();

        // The page content actually came back.
        await expect(lastReply).toContainText(EXPECTED_PAGE_TEXT, {
          timeout: 150_000,
        });

        // And the reported symptom is gone.
        const replyText = await lastReply.innerText();
        for (const pattern of REFUSAL_PATTERNS) {
          expect(replyText).not.toMatch(pattern);
        }

        await page.screenshot({
          path: `${SHOT_DIR}/nexus-url-access-${label}.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    });
  }
});
