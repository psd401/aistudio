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
 * The host page as deployed, allowlisting `cdns`. The parent-origin allowlist
 * is the sandbox origin itself because the specs drive the page at top level
 * (window.parent === window), so a render message it posts to itself carries
 * that origin.
 */
export function hostHtml(cdns: string[] = []): string {
  const template = fs.readFileSync(
    path.join(process.cwd(), "infra", "sandbox-host", "render.html"),
    "utf8"
  );
  const parentOrigins = [SANDBOX_ORIGIN];
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
