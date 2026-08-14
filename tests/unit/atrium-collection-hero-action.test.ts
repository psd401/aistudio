/** @jest-environment node */

/**
 * `setCollectionHeroImageAction` — ORDERING tests.
 *
 * Both properties this file pins are about WHEN things happen, not whether. A
 * refactor that keeps every call but reorders them reintroduces the exact bugs
 * these cover, and nothing else in the suite would notice:
 *
 *  1. Authorization runs BEFORE the S3 write and the image-generation call.
 *     Checking afterwards still lets any signed-in account burn storage and
 *     paid model spend against any collection id — the rejection arrives after
 *     the cost.
 *  2. The superseded S3 object is deleted only AFTER the row points at its
 *     replacement. Every hero write uses a new key, so until the update
 *     commits the old object is still the live image.
 */

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

// One shared call log, so ORDER across modules is observable.
const calls: string[] = [];

const assertMaySetSectionCopyMock = jest.fn();
const updateMock = jest.fn();
jest.mock("@/lib/content/collection-management-service", () => ({
  collectionManagementService: {
    assertMaySetSectionCopy: (...a: unknown[]) => {
      calls.push("authorize");
      return assertMaySetSectionCopyMock(...a);
    },
    update: (...a: unknown[]) => {
      calls.push("update");
      return updateMock(...a);
    },
  },
}));

const storeMock = jest.fn();
const generateMock = jest.fn();
jest.mock("@/lib/content/collection-hero-service", () => ({
  MAX_HERO_IMAGE_BYTES: 8 * 1024 * 1024,
  storeHeroImageFromDataUrl: (...a: unknown[]) => {
    calls.push("store");
    return storeMock(...a);
  },
  generateHeroImage: (...a: unknown[]) => {
    calls.push("generate");
    return generateMock(...a);
  },
}));

const deleteKeyMock = jest.fn();
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    deleteKey: (...a: unknown[]) => {
      calls.push("delete");
      return deleteKeyMock(...a);
    },
  },
}));

import { setCollectionHeroImageAction } from "@/actions/db/atrium/collection-hero";

const COLLECTION = "11111111-1111-4111-8111-111111111111";
const USER = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

beforeEach(() => {
  calls.length = 0;
  getUserRequesterMock.mockReset().mockResolvedValue(USER);
  assertMaySetSectionCopyMock
    .mockReset()
    .mockResolvedValue({ previousHeroImageKey: null });
  updateMock.mockReset().mockResolvedValue({ id: COLLECTION });
  storeMock
    .mockReset()
    .mockResolvedValue({ key: "atrium/collections/x/hero/new.png", byteLength: 10 });
  generateMock
    .mockReset()
    .mockResolvedValue({ key: "atrium/collections/x/hero/gen.png", byteLength: 10 });
  deleteKeyMock.mockReset().mockResolvedValue(undefined);
});

describe("hero image — authorize before spending", () => {
  it("does not store an upload when the caller may not edit the section", async () => {
    assertMaySetSectionCopyMock.mockRejectedValue(new Error("forbidden"));

    const result = await setCollectionHeroImageAction(COLLECTION, {
      dataUrl: "data:image/png;base64,aGk=",
      alt: "A header",
    });

    expect(result.isSuccess).toBe(false);
    expect(storeMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not call the image model when the caller may not edit the section", async () => {
    // The expensive one: this is a paid provider call.
    assertMaySetSectionCopyMock.mockRejectedValue(new Error("forbidden"));

    const result = await setCollectionHeroImageAction(COLLECTION, {
      prompt: "a calm library",
      alt: "A header",
    });

    expect(result.isSuccess).toBe(false);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("authorizes first even on the happy path", async () => {
    await setCollectionHeroImageAction(COLLECTION, {
      dataUrl: "data:image/png;base64,aGk=",
      alt: "A header",
    });

    expect(calls.indexOf("authorize")).toBeLessThan(calls.indexOf("store"));
    expect(calls.indexOf("store")).toBeLessThan(calls.indexOf("update"));
  });
});

describe("hero image — superseded object cleanup", () => {
  it("deletes the previous image only after the row points at the new one", async () => {
    assertMaySetSectionCopyMock.mockResolvedValue({
      previousHeroImageKey: "atrium/collections/x/hero/old.png",
    });

    await setCollectionHeroImageAction(COLLECTION, {
      dataUrl: "data:image/png;base64,aGk=",
      alt: "A header",
    });

    expect(deleteKeyMock).toHaveBeenCalledWith("atrium/collections/x/hero/old.png");
    // Deleting BEFORE the update would break a live section if the update then
    // failed — the old object is the live image until the row moves.
    expect(calls.indexOf("update")).toBeLessThan(calls.indexOf("delete"));
  });

  it("deletes nothing when the section had no image", async () => {
    await setCollectionHeroImageAction(COLLECTION, {
      dataUrl: "data:image/png;base64,aGk=",
      alt: "A header",
    });
    expect(deleteKeyMock).not.toHaveBeenCalled();
  });

  it("still reports success when the cleanup delete fails", async () => {
    // Leaking one object is strictly better than failing a change the user can
    // already see applied.
    assertMaySetSectionCopyMock.mockResolvedValue({
      previousHeroImageKey: "atrium/collections/x/hero/old.png",
    });
    deleteKeyMock.mockRejectedValue(new Error("S3 down"));

    const result = await setCollectionHeroImageAction(COLLECTION, {
      dataUrl: "data:image/png;base64,aGk=",
      alt: "A header",
    });

    expect(result.isSuccess).toBe(true);
  });

  it("clears the row and then deletes, on remove", async () => {
    assertMaySetSectionCopyMock.mockResolvedValue({
      previousHeroImageKey: "atrium/collections/x/hero/old.png",
    });

    const result = await setCollectionHeroImageAction(COLLECTION, {
      clear: true,
    });

    expect(result.isSuccess).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(USER, COLLECTION, {
      heroImageKey: null,
    });
    expect(calls.indexOf("update")).toBeLessThan(calls.indexOf("delete"));
  });

  it("authorizes a remove too", async () => {
    assertMaySetSectionCopyMock.mockRejectedValue(new Error("forbidden"));

    const result = await setCollectionHeroImageAction(COLLECTION, {
      clear: true,
    });

    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteKeyMock).not.toHaveBeenCalled();
  });
});
