import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  CLOSE_SCRIPT,
  HOST_URL,
  readLog,
  render,
  routeHost,
} from "./helpers/atrium-sandbox-host";

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

const CHART_CDN_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
/** How long the stubbed CDN "takes"; long enough that force-async would lose. */
const CDN_DELAY_MS = 300;

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
  await routeHost(page, ["https://cdnjs.cloudflare.com"]);
  await page.route(CHART_CDN_URL, async (route) => {
    requestCount += 1;
    markRequested();
    await new Promise((resolve) => setTimeout(resolve, CDN_DELAY_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      // Stands in for Chart.js: the point is that the symbol exists, plus a
      // count of how many times the library actually executed.
      body:
        "window.Chart = function Chart(){}; window.Chart.defaults = {};" +
        "window.__chartExecutions = (window.__chartExecutions || 0) + 1;",
    });
  });
  await page.goto(HOST_URL);
  await page.waitForLoadState("load");
  return { requested, requestCount: () => requestCount };
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

test.describe("Atrium sandbox host — re-renders while a chain is in flight (#1785)", () => {
  test("a render that supersedes one still waiting on a CDN abandons the stale chain", async ({
    page,
  }) => {
    const cdn = await openHost(page);
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    await render(
      page,
      // The lifecycle handlers are registered BEFORE the script that parks the
      // chain, so they are live when the supersession lands. Abandoning the
      // chain cannot unregister them; if the replacement chain does not drop
      // them first, its synthetic dispatch re-enters this dead artifact.
      "<script>" +
        'document.addEventListener("DOMContentLoaded", function () {' +
        ' window.__artifactLog.push("STALE DOMContentLoaded"); });' +
        'window.addEventListener("load", function () {' +
        ' window.__artifactLog.push("STALE load"); });' +
        CLOSE_SCRIPT +
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
    // any (incorrect) resumed stale chain time to act; it must stay dead. The
    // absence of the STALE entries is the #1795-review assertion: the
    // superseded render's lifecycle handlers were unregistered, not merely
    // left unreachable by the abandoned chain.
    await expect.poll(() => chartType(page)).toBe("function");
    await page.waitForTimeout(500);
    expect(await readLog(page)).toEqual([
      "second artifact",
      "DOMContentLoaded",
      "load",
    ]);
  });

  test("a duplicate post of the same code while a CDN is in flight is acked, not re-rendered", async ({
    page,
  }) => {
    const cdn = await openHost(page);
    await page.evaluate(() => {
      (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
    });

    // Handlers registered BEFORE the pending script, then inline code after it
    // — the shape a re-render would duplicate.
    const code =
      '<div id="out"></div>' +
      LIFECYCLE_SCRIPT +
      `<script src="${CHART_CDN_URL}">` +
      CLOSE_SCRIPT +
      "<script>" +
      'window.__artifactLog.push("inline sees Chart: " + typeof Chart);' +
      CLOSE_SCRIPT;

    await render(page, code);
    // The parent's retry loop re-posts identical code before it sees the ack.
    await cdn.requested;
    await render(page, code);

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["inline sees Chart: function", "DOMContentLoaded", "load"]);
    await page.waitForTimeout(500);
    expect(await readLog(page)).toEqual([
      "inline sees Chart: function",
      "DOMContentLoaded",
      "load",
    ]);
    // A re-render would insert a second copy of the library alongside the
    // first, still-in-flight one — and both would execute.
    expect(
      await page.evaluate(
        () => (window as { __chartExecutions?: number }).__chartExecutions
      )
    ).toBe(1);
    expect(cdn.requestCount()).toBe(1);
  });
});
