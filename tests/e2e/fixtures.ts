import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Shared E2E test fixture.
 *
 * Strips the Next.js dev error overlay from every page. In `next dev`, a
 * console.error (e.g. a React dev warning) renders an error overlay that is itself
 * a `[role="dialog"]`/`<nextjs-portal>`. Tests that assert on a real app dialog via
 * `locator('[role="dialog"]')` then hit Playwright strict-mode violations ("resolved
 * to 2 elements"). The overlay is a dev tool, not app UI, so we remove it from the
 * DOM continuously. Production builds never render it (but the auth harness only
 * works against a dev server — see scripts/test/e2e-local.sh), hence this shim.
 *
 * Specs import { test, expect } from this file instead of '@playwright/test'.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const strip = () => {
        for (const n of document.querySelectorAll(
          "nextjs-portal, [data-nextjs-dialog-overlay], [data-nextjs-toast]"
        )) {
          n.remove();
        }
      };
      const startObserving = () => {
        strip();
        new MutationObserver(strip).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };
      if (document.documentElement) startObserving();
      else addEventListener("DOMContentLoaded", startObserving);
    });
    await use(page);
  },
});

export { expect };
export type { Page, BrowserContext };
