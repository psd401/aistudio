import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): the document editor's "Save a version" completes and commits the
 * author's real markdown, not the base64 transit wrapper (#1714).
 *
 * The library's artifact create had this bug and it reached every deployed
 * environment unseen: the server-action POST carried raw markup, the edge WAF's
 * `CrossSiteScripting_BODY` rule answered with a bare 403, and the rejected
 * action left the UI silent. The document editor posts the same class of body.
 *
 * WHERE THE RAW HTML ACTUALLY COMES FROM — this test corrected an assumption.
 * It is NOT the user typing `<style>`: ProseMirror treats typed angle brackets as
 * literal text and the markdown serializer escapes them to `&lt;`/`&gt;`, which
 * has nothing for the rule to match. The raw HTML is emitted by the editor
 * itself. `authored-mark.ts` renders every authored run as a real
 * `<span data-atrium-authored="" class="atrium-authored" data-by="human:3">`, and
 * `toCleanMarkdown` serializes that verbatim into the markdown body — so EVERY
 * save of a human-edited document posts unescaped HTML tags with quoted
 * attributes, whatever the prose says. Both assertions below are pinned so a
 * future serializer change that alters either behaviour is visible here.
 *
 * No WAF fronts this harness, so this cannot reproduce the 403, and whether the
 * managed rule matches this particular span is unverified. What it pins is the
 * half the fix actually changes: the body now travels base64-encoded, and the
 * action must decode it so the COMMITTED SOURCE is the real markdown rather than
 * the inert wrapper. A missing decode would still "save" — silently storing
 * gibberish — so asserting the caption alone would prove nothing; the source is
 * read back over REST.
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs (the collab WS needs the host dev
 * server; the prod-built container rejects the minted cookie).
 */

const SHOT_DIR = ".verification";

test.describe("Atrium document snapshot is WAF-opaque (#1714)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );
  // Collab connect + a cold editor route are both slow on a first hit.
  test.describe.configure({ timeout: 120_000 });

  test("commits the real markdown, not the base64 wrapper", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context); // admin owns what it creates → canEdit
    let page: import("@playwright/test").Page | undefined;
    let objectId: string | undefined;
    try {
      page = await context.newPage();

      // Seed an owned document. "E2E " prefix so db:cleanup:e2e can reclaim it
      // if teardown is skipped.
      const created = await page.request.post("/api/v1/content", {
        data: {
          kind: "document",
          title: `E2E Snapshot WAF ${Date.now()}`,
          body: "seed line",
          bodyFormat: "markdown",
        },
      });
      expect(created.status()).toBe(201);
      objectId = ((await created.json()) as { data?: { id?: string } }).data?.id;
      expect(objectId).toBeTruthy();
      if (!objectId) throw new TypeError("Create returned no object id");

      await page.goto(`/atrium/${objectId}/edit`);

      // Collab connected as the owner: the editor flips editable, and the byline
      // reports the Y.Doc synced. Typing before that races the sync.
      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", {
        timeout: 60000,
      });
      await expect(page.getByTestId("editor-byline")).toContainText("saved", {
        timeout: 60000,
      });

      // A unique marker so the read-back cannot pass on another document's
      // content, plus angle-bracket markup to pin the escaping behaviour.
      const probe = `WAF-PROBE-${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(` ${probe} <style>.x{}</style>`);
      await expect(pm).toContainText(probe);

      await page.getByTestId("save-version").click();

      // The caption reports the save, not the "your changes are not saved"
      // rejection path this fix added. Captured here, while it is on screen, so
      // the PR evidence shows the confirmation rather than an idle editor.
      const caption = page.locator(".mer-editor-status");
      await expect(caption).toBeVisible({ timeout: 60000 });
      await expect(caption).toContainText("Snapshot saved");
      await expect(caption).not.toContainText("not saved");
      // The caption sits below the sheet, outside the initial viewport — scroll
      // it in, or the evidence shot is an idle editor with no confirmation.
      await caption.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-document-snapshot-waf.png`,
        fullPage: false,
      });

      // The committed source is the decoded markdown. Were the decode missing,
      // this would be the base64 wrapper and the save would still have "worked".
      const source = await page.request.get(
        `/api/v1/content/${objectId}/source`
      );
      expect(source.status()).toBe(200);
      const body = ((await source.json()) as { data?: { body?: unknown } }).data
        ?.body;
      expect(typeof body).toBe("string");
      const committed = body as string;
      // The decode ran: the author's real text survived the base64 round trip.
      expect(committed).toContain(probe);
      // Typed angle brackets are escaped by the serializer — so user prose is
      // NOT what carries raw markup into the POST body.
      expect(committed).toContain("&lt;style&gt;");
      expect(committed).not.toContain("<style>");
      // The authorship mark is: a real unescaped tag with quoted attributes, on
      // every human-edited save. This is the body shape the encoding exists for.
      expect(committed).toContain("<span data-atrium-authored");
    } finally {
      if (page && objectId) {
        try {
          await page.request.delete(`/api/v1/content/${objectId}`);
        } catch {
          // Teardown must never mask the real assertion failure.
        }
      }
      await context.close();
    }
  });
});
