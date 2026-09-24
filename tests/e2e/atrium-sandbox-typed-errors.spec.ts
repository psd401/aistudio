import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  buildAtriumSandboxCsp,
  renderAtriumSandboxHostPage,
} from "@/infra/lib/atrium-sandbox-host-page";

/**
 * Atrium sandbox host — typed bridge failures and forwarded frame errors
 * (#1787). Always-run, CI-safe: no app server, no session, no network.
 *
 * Loads the REAL committed host page (infra/sandbox-host/render.html, with the
 * deploy-time tokens substituted the way the CDK stack does) in Chromium and
 * drives it with `postMessage`, exactly as `ArtifactSandbox` does.
 *
 * Why a real browser and not only the jsdom smoke: the two behaviours here are
 * browser-runtime behaviours. `err.code` has to survive a genuine promise
 * rejection through the artifact's own `catch`, and the frame-error forwarder
 * depends on the browser actually firing `error` / `unhandledrejection` for an
 * uncaught exception inside a recreated `<script>` node — which jsdom does not
 * reproduce faithfully.
 *
 * Imports @playwright/test directly rather than ./fixtures, for the same reason
 * the #1785 spec does: the shared fixture registers its own lifecycle listeners.
 *
 * Run: bunx playwright test tests/e2e/atrium-sandbox-typed-errors.spec.ts
 */

const SANDBOX_ORIGIN = "https://atrium-sandbox.test";
const HOST_URL = `${SANDBOX_ORIGIN}/render.html`;
const CLOSE_SCRIPT = "</" + "script>";

function hostHtml(): string {
  const template = fs.readFileSync(
    path.join(process.cwd(), "infra", "sandbox-host", "render.html"),
    "utf8"
  );
  // The page is driven at TOP LEVEL here (window.parent === window), so the
  // render message it posts to itself carries the sandbox origin — which is
  // therefore the allowlisted parent origin.
  const parentOrigins = [SANDBOX_ORIGIN];
  return renderAtriumSandboxHostPage(
    template,
    parentOrigins,
    buildAtriumSandboxCsp({ parentOrigins, cdns: [] })
  );
}

async function openHost(page: Page): Promise<void> {
  await page.route(HOST_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: hostHtml() })
  );
  await page.goto(HOST_URL);
  await page.waitForLoadState("load");
  await page.evaluate(() => {
    (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
  });
}

function readLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __artifactLog?: string[] }).__artifactLog ?? []
  );
}

async function render(page: Page, code: string): Promise<void> {
  await page.evaluate((artifactCode) => {
    window.postMessage({ type: "atrium-render", code: artifactCode }, "*");
  }, code);
}

/**
 * Stand in for `ArtifactSandbox`: answer the frame's data requests with the
 * typed failure the server action would have produced.
 */
async function installFailingBridge(
  page: Page,
  failure: { code: string; error: string; retryAfterSeconds?: number }
): Promise<void> {
  await page.evaluate((reply) => {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string; requestId?: string };
      if (data?.type !== "atrium-artifact-data-request") return;
      window.postMessage(
        {
          type: "atrium-artifact-data-response",
          requestId: data.requestId,
          ok: false,
          ...reply,
        },
        "*"
      );
    });
  }, failure);
}

test.describe("Atrium sandbox host — typed bridge failures (#1787)", () => {
  test("a rejected query reaches artifact code as err.code, not one generic string", async ({
    page,
  }, testInfo) => {
    await openHost(page);
    await installFailingBridge(page, {
      code: "query_error",
      error: 'column "school_name" does not exist',
    });

    // The artifact branches on err.code exactly as the authoring guidance now
    // tells models to: a no-access state ONLY for forbidden/unauthenticated,
    // the message for query_error.
    await render(
      page,
      '<div id="out" style="font:16px/1.6 system-ui;padding:32px;color:#111">' +
        "loading…</div>" +
        "<script>" +
        "AtriumData.query('select school_name from devices').then(function () {" +
        '  window.__artifactLog.push("unexpected success");' +
        "}).catch(function (err) {" +
        '  window.__artifactLog.push("code=" + err.code);' +
        '  document.getElementById("out").textContent =' +
        '    err.code === "forbidden" || err.code === "unauthenticated"' +
        '      ? "You do not have access to this data."' +
        '      : "Query failed: " + err.message;' +
        "});" +
        CLOSE_SCRIPT
    );

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["code=query_error"]);
    await expect(page.locator("#out")).toHaveText(
      'Query failed: column "school_name" does not exist'
    );

    fs.mkdirSync(path.join(process.cwd(), ".verification"), { recursive: true });
    await page.screenshot({
      path: path.join(
        process.cwd(),
        ".verification",
        "atrium-sandbox-query-error-code.png"
      ),
    });
    await testInfo.attach("sandbox-typed-error", {
      body: JSON.stringify(await readLog(page)),
      contentType: "application/json",
    });
  });

  test("rate_limited carries retryAfterSeconds so a page can back off", async ({
    page,
  }) => {
    await openHost(page);
    await installFailingBridge(page, {
      code: "rate_limited",
      error: "Too many data requests. Try again in a moment.",
      retryAfterSeconds: 30,
    });

    await render(
      page,
      "<script>" +
        "AtriumData.query('select 1').catch(function (err) {" +
        '  window.__artifactLog.push(err.code + ":" + err.retryAfterSeconds);' +
        "});" +
        CLOSE_SCRIPT
    );

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual(["rate_limited:30"]);
  });

  test("an uncaught artifact error is forwarded to the parent", async ({
    page,
  }, testInfo) => {
    await openHost(page);
    // Collect what the host posts "to its parent" — which is this same window,
    // because the spec drives the page at top level.
    await page.evaluate(() => {
      window.addEventListener("message", (event) => {
        const data = event.data as { type?: string; message?: string };
        if (data?.type !== "atrium-artifact-error") return;
        (window as unknown as { __artifactLog: string[] }).__artifactLog.push(
          "forwarded=" + data.message
        );
      });
    });

    // The single most common authoring failure: a bootstrap that references a
    // library the CSP never let load. Before #1787 it existed only in a console
    // nobody had open.
    await render(
      page,
      '<div id="out">chart goes here</div>' +
        "<script>new Chart(document.getElementById('out'));" +
        CLOSE_SCRIPT
    );

    await expect
      .poll(() => readLog(page), { timeout: 10_000 })
      .toEqual([expect.stringContaining("forwarded=") as unknown as string]);
    expect((await readLog(page))[0]).toMatch(/Chart is not defined/);

    fs.mkdirSync(path.join(process.cwd(), ".verification"), { recursive: true });
    await page.screenshot({
      path: path.join(
        process.cwd(),
        ".verification",
        "atrium-sandbox-frame-error-forwarded.png"
      ),
    });
    await testInfo.attach("sandbox-frame-error", {
      body: JSON.stringify(await readLog(page)),
      contentType: "application/json",
    });
  });
});
