/**
 * `readVisibilityForEdit` — the shared grant-list read (#1763).
 *
 * The REST v1 `GET /content/:id/visibility` route and the agent broker's
 * `GET /<id>/visibility` branch both call this one helper, so the property that
 * makes the read safe to expose is pinned ONCE, here, instead of twice in two
 * surface tests that could drift apart: the grant set names every principal
 * with access (including the numeric `users.id` behind a `user` grant), so it
 * is gated on EDIT via `loadForEdit` — which 404-masks a non-viewable object
 * before it 403s a viewer — and a caller who fails that gate never reaches the
 * grant query at all.
 */

const loadForEditMock = jest.fn();
const grantsForMock = jest.fn();

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadForEdit: (...args: unknown[]) => loadForEditMock(...args),
  },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    grantsFor: (...args: unknown[]) => grantsForMock(...args),
  },
}));

import { readVisibilityForEdit } from "@/lib/content/visibility-read";
import type { Requester } from "@/lib/content/types";

const requester = { kind: "user", userId: 7 } as unknown as Requester;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("readVisibilityForEdit (#1763)", () => {
  it("returns the object's level with its ACTUAL grant entries", async () => {
    loadForEditMock.mockResolvedValue({
      id: "obj-1",
      visibilityLevel: "group",
    });
    grantsForMock.mockResolvedValue([
      { kind: "role", value: "staff" },
      { kind: "user", value: "41" },
    ]);

    await expect(readVisibilityForEdit(requester, "some-slug")).resolves.toEqual(
      {
        id: "obj-1",
        visibility: {
          visibilityLevel: "group",
          grants: [
            { kind: "role", value: "staff" },
            { kind: "user", value: "41" },
          ],
        },
      }
    );
    // Resolved by the caller's slug-or-id, then queried by the resolved id.
    expect(loadForEditMock).toHaveBeenCalledWith(requester, "some-slug");
    expect(grantsForMock).toHaveBeenCalledWith("obj-1");
  });

  it("never queries grants when the edit gate rejects the caller", async () => {
    const masked = new Error("Content not found");
    loadForEditMock.mockRejectedValue(masked);

    await expect(readVisibilityForEdit(requester, "obj-1")).rejects.toBe(masked);
    expect(grantsForMock).not.toHaveBeenCalled();
  });

  it("reports an empty audience as an empty list, not a missing field", async () => {
    // A non-group object stores no grants; the shape stays the same so a caller
    // can diff it against what it is about to write without a null check.
    loadForEditMock.mockResolvedValue({
      id: "obj-2",
      visibilityLevel: "internal",
    });
    grantsForMock.mockResolvedValue([]);

    await expect(readVisibilityForEdit(requester, "obj-2")).resolves.toEqual({
      id: "obj-2",
      visibility: { visibilityLevel: "internal", grants: [] },
    });
  });
});
