import { test, expect } from "./fixtures";

/**
 * E2E guard: the collection hero-image route (migration 178) — always-run, CI-safe.
 *
 * `GET /api/atrium/collections/[id]/hero` serves a section's header image. It is
 * a NEW public surface, and the interesting thing about it is what it must NOT
 * be: an arbitrary S3-read primitive.
 *
 * Two properties are worth pinning at this tier, both provable without a
 * session or a seeded collection:
 *
 *  1. It never serves bytes to an anonymous caller. Access is decided by the
 *     collection-access snapshot, and a guest passes it for nothing that has an
 *     image (a personal collection's artwork must be as private as the
 *     collection).
 *  2. It EXISTS-MASKS. An absent collection and one the caller may not enter
 *     must be indistinguishable — 404 for both, never 403 — matching the rule
 *     the rest of Atrium follows. An anonymous probe cannot tell the two apart
 *     here, which is exactly the point.
 *
 * What this CANNOT cover is the authenticated path (an editor uploads or
 * generates, a viewer with access gets the bytes). That lives in the
 * authorization unit tests over `collectionAccessSnapshot` and in manual
 * verification, because it needs both a seeded collection and stored S3 bytes.
 */

// Well-formed but absent. The route only needs a UUID-shaped id to reach its
// access check; the id never resolves to a row.
const ABSENT_COLLECTION = "00000000-0000-0000-0000-000000000000";

test.describe("Atrium collection hero image — route guarding (always-run)", () => {
  test("GET the hero of an absent collection -> never serves bytes", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/atrium/collections/${ABSENT_COLLECTION}/hero`,
      { maxRedirects: 0 }
    );

    // 404 (masked) or an auth redirect are both acceptable; a 200 with image
    // bytes is not, and neither is a 403 — that would confirm the collection
    // exists to a caller who may not see it.
    expect(res.status()).not.toBe(200);
    expect(res.status()).not.toBe(403);
    expect([301, 302, 307, 308, 401, 404]).toContain(res.status());
  });

  test("the route does not accept a caller-supplied S3 key", async ({
    request,
  }) => {
    // The key is read from the collection row AFTER the access check, never
    // from the request — otherwise this would be a read primitive scoped only
    // by whatever prefix validation it happened to do. A traversal-shaped id
    // must not escape the route's own path segment.
    const res = await request.get(
      `/api/atrium/collections/${ABSENT_COLLECTION}/hero?key=../../../etc/passwd`,
      { maxRedirects: 0 }
    );
    expect(res.status()).not.toBe(200);

    const body = await res.text().catch(() => "");
    expect(body).not.toContain("root:");
  });
});
