import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  buildAtriumSandboxCsp,
  renderAtriumSandboxHostPage,
} from "@/infra/lib/atrium-sandbox-host-page";

/**
 * Atrium sandbox host — real-browser script semantics (#1785). Always-run, CI-safe.
 *
 * This spec loads the REAL committed host page (infra/sandbox-host/render.html,
 * with the deploy-time tokens substituted the way the CDK stack does) in
 * Chromium and drives it with `postMessage`, exactly as the app does. It needs
 * NO app server, NO session and NO network: every request — the host page and
 * the "cdnjs" library — is fulfilled by `page.route`.
 *
 * It exists because the jsdom smoke (tests/smoke/atrium-artifact-sandbox-host)
 * cannot model the two browser rules that caused #1785:
 *   * a script created by `createElement` with a `src` is force-async, so it
 *     runs whenever its download finishes rather than in document order;
 *   * a recreated inline script runs synchronously the instant it is inserted.
 * jsdom serializes dynamically inserted scripts on its own, so only a real
 * browser can prove that a `<script src=cdnjs/chart.js>` followed by inline
 * `new Chart(...)` now works. The library response is deliberately DELAYED so
 * the pre-fix ordering bug would be guaranteed, not luck.
 *
 * Imports @playwright/test directly rather than ./fixtures: the shared fixture
 * injects a Next-dev-overlay stripper that registers its own DOMContentLoaded
 * listener, and this spec asserts on exactly those events.
 *
 * Run: bunx playwright test tests/e2e/atrium-sandbox-script-order.spec.ts
 */

const SANDBOX_ORIGIN = "https://atrium-sandbox.test";
const HOST_URL = `${SANDBOX_ORIGIN}/render.html`;
const CHART_CDN_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
/** How long the stubbed CDN "takes"; long enough that force-async would lose. */
const CDN_DELAY_MS = 300;
const CLOSE_SCRIPT = "</" + "script>";

/**
 * The host page as deployed. The parent-origin allowlist is the sandbox origin
 * itself because this spec drives the page at top level (window.parent ===
 * window), so a render message it posts to itself carries that origin.
 */
function hostHtml(): string {
  const template = fs.readFileSync(
    path.join(process.cwd(), "infra", "sandbox-host", "render.html"),
    "utf8"
  );
  // The same builder the CDK stack deploys with, allowlisting the one CDN.
  const parentOrigins = [SANDBOX_ORIGIN];
  const csp = buildAtriumSandboxCsp({
    parentOrigins,
    cdns: ["https://cdnjs.cloudflare.com"],
  });
  return renderAtriumSandboxHostPage(template, parentOrigins, csp);
}

/** Observations of the stubbed CDN, for syncing on it instead of sleeping. */
interface CdnStub {
  /** Resolves when the first library request reaches the stub. */
  requested: Promise<void>;
  /** How many library requests reached the stub. */
  requestCount: () => number;
}

async function openHost(page: Page): Promise<CdnStub> {
  let requestCount = 0;
  let markRequested: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  await page.route(HOST_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: hostHtml() })
  );
  await page.route(CHART_CDN_URL, async (route) => {
    requestCount += 1;
    markRequested();
    await new Promise((resolve) => setTimeout(resolve, CDN_DELAY_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      // Stands in for Chart.js: the point is only that the symbol exists.
      body: "window.Chart = function Chart(){}; window.Chart.defaults = {};",
    });
  });
  await page.goto(HOST_URL);
  await page.waitForLoadState("load");
  return { requested, requestCount: () => requestCount };
}

/** Post a render message the way the app's ArtifactSandbox does. */
async function render(page: Page, code: string): Promise<void> {
  await page.evaluate((artifactCode) => {
    window.postMessage({ type: "atrium-render", code: artifactCode }, "*");
  }, code);
}

function readLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __artifactLog?: string[] }).__artifactLog ?? []
  );
}

/** `typeof window.Chart` in the page — "function" once the stub library ran. */
function chartType(page: Page): Promise<string> {
  return page.evaluate(() => typeof (window as { Chart?: unknown }).Chart);
}

/** Records DOMContentLoaded/load — the bootstrap habit #1785 rendered blank. */
const LIFECYCLE_SCRIPT =
  "<script>" +
  'document.addEventListener("DOMContentLoaded", function () {' +
  '  window.__artifactLog.push("DOMContentLoaded");' +
  '  document.getElementById("out").textContent =' +
  '    "bootstrapped by DOMContentLoaded; Chart is " + typeof window.Chart;' +
  "});" +
  'window.addEventListener("load", function () {' +
  '  window.__artifactLog.push("load"); });' +
  CLOSE_SCRIPT;

test.describe("Atrium sandbox host — script order and lifecycle events (#1785)", () => {
  test("a cdnjs library runs before the inline code that uses it, then DOMContentLoaded and load fire once", async ({
    page,
  }, testInfo) => {
    await openHost(page);
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    const code =
      '<div id="out" style="font:16px/1.6 system-ui;padding:32px;color:#111">' +
      "not bootstrapped</div>" +
      `<script src="${CHART_CDN_URL}">` +
      CLOSE_SCRIPT +
      "<script>" +
      'window.__artifactLog.push("inline sees Chart: " + typeof Chart);' +
      CLOSE_SCRIPT +
      LIFECYCLE_SCRIPT;

    await render(page, code);
    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["inline sees Chart: function", "DOMContentLoaded", "load"]);

    await expect(page.locator("#out")).toHaveText(
      "bootstrapped by DOMContentLoaded; Chart is function"
    );

    // Nothing further may arrive after the chain has finished.
    await page.waitForTimeout(500);
    expect(await readLog(page)).toEqual([
      "inline sees Chart: function",
      "DOMContentLoaded",
      "load",
    ]);

    fs.mkdirSync(path.join(process.cwd(), ".verification"), { recursive: true });
    await page.screenshot({
      path: path.join(
        process.cwd(),
        ".verification",
        "atrium-sandbox-script-order.png"
      ),
    });
    await testInfo.attach("sandbox-script-order", {
      body: JSON.stringify(await readLog(page)),
      contentType: "application/json",
    });
  });

  test("a render that supersedes one still waiting on a CDN abandons the stale chain", async ({
    page,
  }) => {
    const cdn = await openHost(page);
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    await render(
      page,
      `<script src="${CHART_CDN_URL}">` +
        CLOSE_SCRIPT +
        "<script>" +
        'window.__artifactLog.push("first artifact");' +
        CLOSE_SCRIPT +
        LIFECYCLE_SCRIPT
    );
    // Supersede it once the library request is provably in flight: the stub
    // has received it and holds the response for CDN_DELAY_MS.
    await cdn.requested;
    await render(
      page,
      '<div id="out"></div><script>window.__artifactLog.push("second artifact");' +
        CLOSE_SCRIPT +
        LIFECYCLE_SCRIPT
    );

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["second artifact", "DOMContentLoaded", "load"]);

    // Let the stale CDN answer — the library running proves it did — then give
    // any (incorrect) resumed stale chain time to act; it must stay dead.
    await expect.poll(() => chartType(page)).toBe("function");
    await page.waitForTimeout(500);
    expect(await readLog(page)).toEqual([
      "second artifact",
      "DOMContentLoaded",
      "load",
    ]);
  });

  test("a blocked or failing external script does not stall the rest of the artifact", async ({
    page,
  }) => {
    await openHost(page);
    // Override the CDN stub with a hard failure for this test only.
    await page.route(CHART_CDN_URL, (route) => route.abort("failed"));
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    await render(
      page,
      '<div id="out"></div>' +
        `<script src="${CHART_CDN_URL}">` +
        CLOSE_SCRIPT +
        "<script>" +
        'window.__artifactLog.push("inline ran, Chart=" + typeof window.Chart);' +
        CLOSE_SCRIPT +
        LIFECYCLE_SCRIPT
    );

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["inline ran, Chart=undefined", "DOMContentLoaded", "load"]);
  });

  test("a classic nomodule script is skipped without stalling the chain", async ({
    page,
  }) => {
    const cdn = await openHost(page);
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    await render(
      page,
      '<div id="out"></div>' +
        `<script nomodule src="${CHART_CDN_URL}">` +
        CLOSE_SCRIPT +
        "<script>" +
        'window.__artifactLog.push("inline ran, Chart=" + typeof window.Chart);' +
        CLOSE_SCRIPT +
        LIFECYCLE_SCRIPT
    );

    // Well inside the host's 60s per-script timeout: a chain that waited on the
    // nomodule script (which fires neither load nor error) would miss this.
    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["inline ran, Chart=undefined", "DOMContentLoaded", "load"]);
    // Chromium never even fetched it — the premise the host relies on.
    expect(cdn.requestCount()).toBe(0);
  });
});
