import { test, expect } from "./fixtures";

test.describe("Rooms management — route auth gate (always-run)", () => {
  test("GET /rooms/manage unauthenticated redirects to sign-in", async ({
    request,
  }) => {
    const response = await request.get("/rooms/manage", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/api/auth/signin");
  });

  test("GET /rooms unauthenticated redirects to sign-in", async ({
    request,
  }) => {
    const response = await request.get("/rooms", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/api/auth/signin");
  });
});
