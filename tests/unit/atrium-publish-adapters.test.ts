/**
 * Unit tests for the Atrium publish adapters + destination classification
 * (Issue #1057, Phase 7).
 *
 * Covers:
 *  - `isPublicDestination` / `PUBLIC_DESTINATIONS` / `normalizeLiveDestination`
 *    — the single source of truth
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
  normalizeLiveDestination,
  LIVE_DESTINATION,
  LIVE_SURFACE_DESTINATIONS,
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
  it("classifies ONLY the connectors as public (#1726)", () => {
    // The live switch changes no audience — who may read a live page is the
    // object's Level, gated by visibilityService.setLevel. Gating the live
    // switch gated the STATE rather than the exposure, which is what made the
    // old widen prompt both wrong (it fired for a group-scoped intranet
    // publish) and bypassable (narrow one save later).
    expect(isPublicDestination("intranet")).toBe(false);
    // `public_web` is now only a legacy ALIAS for the live row, not a second
    // exposure — `normalizeLiveDestination` folds it before it reaches a gate.
    expect(isPublicDestination("public_web")).toBe(false);
    // The connectors push a copy into an external family-facing system, which IS
    // an exposure whatever the Level says.
    expect(isPublicDestination("schoology")).toBe(true);
    expect(isPublicDestination("google")).toBe(true);
    // OKF export (Phase 8, #1103) is NOT public: a single-object bundle carries the
    // internal-publish authority; the §26.4 public gate applies to the COLLECTION
    // exporter's `public` audience, not the destination.
    expect(isPublicDestination("okf")).toBe(false);
  });

  it("PUBLIC_DESTINATIONS is exactly the two connectors", () => {
    expect([...PUBLIC_DESTINATIONS].sort()).toEqual(
      ["google", "schoology"].sort()
    );
    const all: PublishDestination[] = [
      "intranet",
      "public_web",
      "schoology",
      "google",
      "okf",
    ];
    expect(all.filter((d) => !isPublicDestination(d))).toEqual([
      "intranet",
      "public_web",
      "okf",
    ]);
  });
});

describe("normalizeLiveDestination", () => {
  it("folds `public_web` onto the single live row and leaves everything else alone", () => {
    // One live row is the whole point: a publish and an unpublish issued under
    // different aliases must touch the SAME row, or an Unpublish leaves a second
    // live row serving readers after the author was told it was taken down.
    expect(normalizeLiveDestination("public_web")).toBe("intranet");
    expect(normalizeLiveDestination("intranet")).toBe("intranet");
    expect(normalizeLiveDestination("schoology")).toBe("schoology");
    expect(normalizeLiveDestination("google")).toBe("google");
    expect(normalizeLiveDestination("okf")).toBe("okf");
  });

  it("LIVE_SURFACE_DESTINATIONS still accepts a pre-migration public_web row", () => {
    // Migration 180 folds those rows in, but the reader gates accept either so
    // the migration and the image deploy can land in any order.
    expect([...LIVE_SURFACE_DESTINATIONS].sort()).toEqual(
      ["intranet", "public_web"].sort()
    );
    expect(LIVE_DESTINATION).toBe("intranet");
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
