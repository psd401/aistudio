/**
 * `contentSurfaceLink` — the link a caller is handed for a content object.
 *
 * `/c/{slug}` is served only when the object has a LIVE INTRANET PUBLICATION.
 * Without one the reader calls `notFound()`, and because it masks existence
 * rather than returning 403, it 404s for the OWNER too. Returning that URL for
 * every object therefore handed API and skill callers a dead link for anything
 * they had just created.
 *
 * That is not hypothetical: psd-morning-brief creates a private artifact and
 * never publishes it, so every morning-brief DM linked to a page that 404'd
 * for its own recipient — every user, every day, until this was fixed. One
 * user reported it twice (agent_failures 13503 and 13998, 2026-08-26).
 */

const BASE = "https://aistudio.psd401.ai";

describe("contentSurfaceLink", () => {
  let contentSurfaceLink: typeof import(
    "@/lib/content/reader-links"
  )["contentSurfaceLink"];
  let contentDeepLink: typeof import(
    "@/lib/content/reader-links"
  )["contentDeepLink"];
  const originalBase = process.env.ATRIUM_PUBLIC_BASE_URL;

  beforeAll(() => {
    process.env.ATRIUM_PUBLIC_BASE_URL = BASE;
    // The module reads the env var per call, but require after setting it so
    // this suite is order-independent.
    ({ contentSurfaceLink, contentDeepLink } = jest.requireActual<
      typeof import("@/lib/content/reader-links")
    >("@/lib/content/reader-links"));
  });

  afterAll(() => {
    if (originalBase === undefined) delete process.env.ATRIUM_PUBLIC_BASE_URL;
    else process.env.ATRIUM_PUBLIC_BASE_URL = originalBase;
  });

  it("uses the reader deep link once the object is published", () => {
    expect(
      contentSurfaceLink({
        id: "obj-1",
        slug: "staff-handbook",
        kind: "document",
        status: "published",
      })
    ).toBe(contentDeepLink("staff-handbook"));
    expect(
      contentSurfaceLink({
        id: "obj-1",
        slug: "staff-handbook",
        kind: "document",
        status: "published",
      })
    ).toBe(`${BASE}/c/staff-handbook`);
  });

  it("sends a draft ARTIFACT to the full-screen view, not the reader", () => {
    // The morning brief's exact shape: a private, never-published artifact.
    expect(
      contentSurfaceLink({
        id: "obj-2",
        slug: "morning-brief-2026-08-26",
        kind: "artifact",
        status: "draft",
      })
    ).toBe(`${BASE}/atrium/obj-2/view`);
  });

  it("sends a draft DOCUMENT to its authoring page", () => {
    expect(
      contentSurfaceLink({
        id: "obj-3",
        slug: "new-document",
        kind: "document",
        status: "draft",
      })
    ).toBe(`${BASE}/atrium/obj-3/edit`);
  });

  it("keeps an ARCHIVED object off the reader too", () => {
    // Archiving retracts publications, so `/c/` would 404 exactly as a draft
    // does. Only `published` earns the reader link.
    expect(
      contentSurfaceLink({
        id: "obj-4",
        slug: "retired-policy",
        kind: "document",
        status: "archived",
      })
    ).toBe(`${BASE}/atrium/obj-4/edit`);
  });
});
