/**
 * Unit tests for the Atrium publish adapters + destination classification
 * (Issue #1057, Phase 7).
 *
 * Covers:
 *  - `isPublicDestination` / `PUBLIC_DESTINATIONS` — the single source of truth
 *    the §26.4 gate uses to decide which destinations need publish_public.
 *  - `publicWebAdapter` — LIVE, reader-backed: returns the anonymous `/p/{slug}`
 *    reader URL as external_ref, absolute when ATRIUM_PUBLIC_BASE_URL is set and a
 *    relative same-origin path when it is not.
 *  - `schoologyAdapter` / `googleAdapter` — governed connector STUBS: flagged
 *    `implemented: false` (so the publish service blocks before the tx) and their
 *    `publish` throws a ValidationError rather than silently succeeding.
 *
 * surface-helpers (imported transitively by the public-web adapter for
 * `publicReaderLink`) pulls DB + roles modules at import time; those are mocked so
 * this stays a pure, DB-free unit test (publicReaderLink itself only reads env).
 */

jest.mock("@/utils/roles", () => ({ hasCapabilityAccess: jest.fn() }));
jest.mock("@/lib/db/drizzle-client", () => ({ executeQuery: jest.fn() }));
jest.mock("@/lib/db/schema", () => ({ contentCollections: {} }));
jest.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));

import {
  isPublicDestination,
  PUBLIC_DESTINATIONS,
  type PublishDestination,
} from "@/lib/content/publish-adapters/types";
import { publicWebAdapter } from "@/lib/content/publish-adapters/public-web";
import { schoologyAdapter } from "@/lib/content/publish-adapters/schoology";
import { googleAdapter } from "@/lib/content/publish-adapters/google";
import { ValidationError } from "@/lib/content/errors";

const PUBLISH_INPUT = {
  objectId: "obj-1",
  slug: "my-doc",
  versionId: "ver-1",
  title: "My Doc",
  collectionId: null,
};

describe("isPublicDestination / PUBLIC_DESTINATIONS", () => {
  it("classifies intranet as internal and public_web/schoology/google as public", () => {
    expect(isPublicDestination("intranet")).toBe(false);
    expect(isPublicDestination("public_web")).toBe(true);
    expect(isPublicDestination("schoology")).toBe(true);
    expect(isPublicDestination("google")).toBe(true);
  });

  it("PUBLIC_DESTINATIONS is exactly the three family-facing destinations", () => {
    expect([...PUBLIC_DESTINATIONS].sort()).toEqual(
      ["google", "public_web", "schoology"].sort()
    );
    // intranet is the only destination that is NOT public.
    const all: PublishDestination[] = [
      "intranet",
      "public_web",
      "schoology",
      "google",
    ];
    expect(all.filter((d) => !isPublicDestination(d))).toEqual(["intranet"]);
  });
});

describe("publicWebAdapter", () => {
  const original = process.env.ATRIUM_PUBLIC_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.ATRIUM_PUBLIC_BASE_URL;
    else process.env.ATRIUM_PUBLIC_BASE_URL = original;
  });

  it("is live (no implemented:false flag) and targets public_web", () => {
    expect(publicWebAdapter.destination).toBe("public_web");
    // A LIVE adapter must not be flagged as a stub, or the service would block it
    // before the tx.
    expect(publicWebAdapter.implemented).not.toBe(false);
  });

  it("returns the absolute /p/{slug} reader URL when ATRIUM_PUBLIC_BASE_URL is set", async () => {
    process.env.ATRIUM_PUBLIC_BASE_URL = "https://aistudio.example.edu/";
    const result = await publicWebAdapter.publish(PUBLISH_INPUT);
    // Trailing slash on the base is stripped; the path is /p/{slug}.
    expect(result).toEqual({
      externalRef: "https://aistudio.example.edu/p/my-doc",
    });
  });

  it("degrades to a relative /p/{slug} path when the base URL is unset", async () => {
    delete process.env.ATRIUM_PUBLIC_BASE_URL;
    const result = await publicWebAdapter.publish(PUBLISH_INPUT);
    expect(result).toEqual({ externalRef: "/p/my-doc" });
  });

  it("has no unpublish teardown (reader gates on live status, nothing external to undo)", () => {
    expect(publicWebAdapter.unpublish).toBeUndefined();
  });
});

describe("schoology / google connector stubs", () => {
  it("are flagged implemented:false so the publish service blocks before the tx", () => {
    expect(schoologyAdapter.implemented).toBe(false);
    expect(googleAdapter.implemented).toBe(false);
    expect(schoologyAdapter.destination).toBe("schoology");
    expect(googleAdapter.destination).toBe("google");
  });

  it("throw ValidationError on publish (never silently succeed)", async () => {
    await expect(schoologyAdapter.publish(PUBLISH_INPUT)).rejects.toThrow(
      ValidationError
    );
    await expect(googleAdapter.publish(PUBLISH_INPUT)).rejects.toThrow(
      ValidationError
    );
  });
});
