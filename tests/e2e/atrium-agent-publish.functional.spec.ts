import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium agent-bridge publish / unpublish ops (Epic #1059 follow-up).
 *
 * Drives the agent-bridge route as the signed-in OWNER of the seeded editor doc
 * and proves the new publish/unpublish ops go through the SAME publishService gate
 * humans use:
 *   - publish → intranet succeeds (200, applied),
 *   - unpublish → intranet succeeds (200, applied),
 *   - a non-existent object id is existence-masked (404), not 403,
 *   - an invalid destination is rejected (400) without publishing.
 *
 * The §26.4 public-destination APPROVAL path (queuedForApproval / 202) is proven
 * deterministically in the jest unit test (ApprovalRequiredError) — the seeded
 * admin here holds public-publish authority, so it would publish directly.
 *
 * PREREQUISITES (why gated): the authed host :3100 server + the editor seed
 * (tests/e2e/fixtures/atrium-editor-seed.sql — admin-owned doc, canEdit=true).
 */

const OBJ_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";

test.describe("Atrium agent-bridge publish/unpublish (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host :3100 server + the editor seed"
  );

  test("agent bridge can publish then unpublish the owner's doc to intranet, and honors auth/validation", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // default admin = the seeded doc's owner
    try {
      // 1. Publish to the internal reader (default destination when omitted).
      const pub = await context.request.post(`/api/content/${OBJ_ID}/agent-bridge`, {
        headers: { "content-type": "application/json" },
        data: { op: "publish", destination: "intranet" },
      });
      expect(pub.status()).toBe(200);
      const pubBody = await pub.json();
      expect(pubBody).toMatchObject({ applied: true, op: "publish", destination: "intranet" });
      expect(typeof pubBody.publicationId).toBe("string");

      // 2. Unpublish it again.
      const unpub = await context.request.post(`/api/content/${OBJ_ID}/agent-bridge`, {
        headers: { "content-type": "application/json" },
        data: { op: "unpublish", destination: "intranet" },
      });
      expect(unpub.status()).toBe(200);
      expect(await unpub.json()).toMatchObject({ applied: true, op: "unpublish" });

      // 3. A non-existent object id is existence-masked (404, not 403).
      const missing = await context.request.post(
        `/api/content/a7100000-0000-4000-8000-0000deadbeef/agent-bridge`,
        { headers: { "content-type": "application/json" }, data: { op: "publish" } }
      );
      expect(missing.status()).toBe(404);

      // 4. An invalid destination is rejected (400) before any publish.
      const bad = await context.request.post(`/api/content/${OBJ_ID}/agent-bridge`, {
        headers: { "content-type": "application/json" },
        data: { op: "publish", destination: "okf" },
      });
      expect(bad.status()).toBe(400);
    } finally {
      await context.close();
    }
  });
});
