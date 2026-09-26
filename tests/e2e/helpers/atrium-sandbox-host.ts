import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  buildAtriumSandboxCsp,
  renderAtriumSandboxHostPage,
} from "@/infra/lib/atrium-sandbox-host-page";

/**
 * Shared driver for the always-run Atrium sandbox host specs (#1785, #1787).
 *
 * They load the REAL committed host page (infra/sandbox-host/render.html, with
 * the deploy-time tokens substituted the way the CDK stack does) in Chromium and
 * drive it with `postMessage`, exactly as `ArtifactSandbox` does. Plain functions
 * only — no Playwright fixture — because those specs assert on page lifecycle
 * events that the shared `./fixtures` wrapper registers listeners for.
 */

export const SANDBOX_ORIGIN = "https://atrium-sandbox.test";
export const HOST_URL = `${SANDBOX_ORIGIN}/render.html`;
export const CLOSE_SCRIPT = "</" + "script>";

/**
 * The host page as deployed, allowlisting `cdns`. By default the parent-origin
 * allowlist is the sandbox origin itself, because the host-only specs drive the
 * page at top level (window.parent === window), so a render message it posts to
 * itself carries that origin. `routeAppSandbox` passes the APP origin instead.
 */
export function hostHtml(
  cdns: string[] = [],
  parentOrigins: string[] = [SANDBOX_ORIGIN]
): string {
  const template = fs.readFileSync(
    path.join(process.cwd(), "infra", "sandbox-host", "render.html"),
    "utf8"
  );
  return renderAtriumSandboxHostPage(
    template,
    parentOrigins,
    buildAtriumSandboxCsp({ parentOrigins, cdns })
  );
}

/** Serve the host page at `HOST_URL` for this page. */
export async function routeHost(page: Page, cdns: string[] = []): Promise<void> {
  await page.route(HOST_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: hostHtml(cdns) })
  );
}

/**
 * Serve the host page INSIDE the app (#1839), so `ArtifactSandbox` gets a real
 * cross-origin preview frame with no CloudFront.
 *
 * Needs a server started with `ATRIUM_SANDBOX_ORIGIN` set to `E2E_SANDBOX_ORIGIN`
 * (default `SANDBOX_ORIGIN`), which `scripts/test/e2e-local.sh` does and exports
 * to Playwright: the app then frames `<origin>/render` (never
 * resolvable) and allows it in its CSP `frame-src`, and this route answers it
 * with the committed host page, allowlisting the app as its parent. `page.route`
 * covers the page's frames too.
 */
export async function routeAppSandbox(page: Page, appOrigin: string): Promise<void> {
  // The runner exports the origin it gave the server, so an `E2E_SANDBOX_ORIGIN`
  // override is intercepted too; the default matches the runner's.
  const sandboxOrigin = new URL(process.env.E2E_SANDBOX_ORIGIN || SANDBOX_ORIGIN).origin;
  await page.route(
    (url) => url.origin === sandboxOrigin && url.pathname === "/render",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: hostHtml([], [appOrigin]),
      })
  );
}

/** Post a render message the way the app's ArtifactSandbox does. */
export async function render(page: Page, code: string): Promise<void> {
  await page.evaluate((artifactCode) => {
    window.postMessage({ type: "atrium-render", code: artifactCode }, "*");
  }, code);
}

/** The `window.__artifactLog` the test artifacts push their observations to. */
export function readLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __artifactLog?: string[] }).__artifactLog ?? []
  );
}
