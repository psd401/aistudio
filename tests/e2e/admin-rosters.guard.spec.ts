import { test, expect } from "./fixtures";

test.describe("Admin rosters — route auth gate (always-run)", () => {
  test("GET /admin/rosters unauthenticated redirects to sign-in", async ({
    request,
  }) => {
    const response = await request.get("/admin/rosters", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/api/auth/signin");
  });
});
