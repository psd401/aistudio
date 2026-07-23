import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium Phase 5 REST v1 content endpoints (#1055) — always-run, CI-safe.
 *
 * Every /api/v1/content route runs under withApiAuth, which authenticates BEFORE
 * any handler logic. With no Authorization header and no session cookie, the
 * unauthenticated `{ request }` fixture deterministically gets 401 — proving the
 * routes are wired and auth-gated without needing a token.
 *
 * The authenticated functional flow (mint an sk- key with content:* → create →
 * version → publish_internal; autonomous identity → publish_content(public_web)
 * returns approval_required) is the gated spec + manual runbook.
 */

const SOME_ID = "00000000-0000-0000-0000-000000000000";

test.describe("Atrium content v1 endpoints — unauthenticated 401 (always-run)", () => {
  test("GET /api/v1/content -> 401", async ({ request }) => {
    expect((await request.get("/api/v1/content")).status()).toBe(401);
  });

  test("GET /api/v1/content/collections -> 401", async ({ request }) => {
    expect(
      (await request.get("/api/v1/content/collections?shape=flat")).status()
    ).toBe(401);
  });

  test("POST /api/v1/content -> 401 (auth before body parse)", async ({ request }) => {
    const res = await request.post("/api/v1/content", {
      data: { kind: "document", title: "probe" },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/v1/content/[id] -> 401", async ({ request }) => {
    expect((await request.get(`/api/v1/content/${SOME_ID}`)).status()).toBe(401);
  });

  test("PATCH /api/v1/content/[id] -> 401", async ({ request }) => {
    const res = await request.patch(`/api/v1/content/${SOME_ID}`, {
      data: { title: "probe" },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/v1/content/[id]/versions -> 401", async ({ request }) => {
    expect(
      (await request.get(`/api/v1/content/${SOME_ID}/versions`)).status()
    ).toBe(401);
  });

  test("POST /api/v1/content/[id]/versions -> 401", async ({ request }) => {
    const res = await request.post(`/api/v1/content/${SOME_ID}/versions`, {
      data: { body: "# probe" },
    });
    expect(res.status()).toBe(401);
  });

  test("PATCH /api/v1/content/[id]/visibility -> 401", async ({ request }) => {
    const res = await request.patch(`/api/v1/content/${SOME_ID}/visibility`, {
      data: { level: "internal" },
    });
    expect(res.status()).toBe(401);
  });

  test("POST /api/v1/content/[id]/publish -> 401", async ({ request }) => {
    const res = await request.post(`/api/v1/content/${SOME_ID}/publish`, {
      data: { destination: "intranet" },
    });
    expect(res.status()).toBe(401);
  });

  test("DELETE /api/v1/content/[id]/publish/[destination] -> 401", async ({ request }) => {
    expect(
      (await request.delete(`/api/v1/content/${SOME_ID}/publish/intranet`)).status()
    ).toBe(401);
  });

  // OKF interoperability (Phase 8, #1103) — export/import are auth-gated before any
  // handler logic (withApiAuth), so unauthenticated requests get 401 without a token.
  test("POST /api/v1/content/export/okf -> 401", async ({ request }) => {
    const res = await request.post("/api/v1/content/export/okf", {
      data: { collectionId: SOME_ID },
    });
    expect(res.status()).toBe(401);
  });

  test("POST /api/v1/content/import/okf -> 401", async ({ request }) => {
    const res = await request.post("/api/v1/content/import/okf", {
      data: { files: [{ path: "a.md", content: "probe" }] },
    });
    expect(res.status()).toBe(401);
  });
});
