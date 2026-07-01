/**
 * Unit tests for resolveCollectionId (Issue #1055 — correctness review fix).
 *
 * Guards the fix for the bug where a uuid-shaped collection id was returned
 * unvalidated: `contentService.create` skips its own collection check when an
 * explicit `visibility.level` is supplied, so an unvalidated id reached the
 * INSERT and surfaced as an opaque FK-violation 500 instead of a 400. The helper
 * now validates existence (id-first, slug-fallback) and throws ValidationError.
 *
 * executeQuery is mocked with a per-call result queue: the first call is the id
 * lookup (for uuid input), the second the slug lookup.
 */

let queue: Array<Array<{ id: string }>> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => queue.shift() ?? []),
}));

jest.mock("@/lib/db/schema", () => ({
  contentCollections: { id: "id", slug: "slug" },
}));

jest.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));

const mockHasCapabilityAccess = jest.fn(async (..._args: unknown[]) => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => mockHasCapabilityAccess(...args),
}));

import {
  assertContentAuthoringCapability,
  ATRIUM_CONTENT_CAPABILITY,
  resolveCollectionId,
} from "@/lib/content/surface-helpers";
import { ForbiddenError, ValidationError } from "@/lib/content/errors";

const UUID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  queue = [];
  jest.clearAllMocks();
  mockHasCapabilityAccess.mockResolvedValue(true);
});

describe("resolveCollectionId", () => {
  it("returns undefined when no collection is supplied", async () => {
    expect(await resolveCollectionId(undefined)).toBeUndefined();
    expect(await resolveCollectionId(null)).toBeUndefined();
    expect(await resolveCollectionId("")).toBeUndefined();
  });

  it("resolves a uuid that exists as an id", async () => {
    queue = [[{ id: UUID }]];
    expect(await resolveCollectionId(UUID)).toBe(UUID);
  });

  it("falls back to a slug lookup when a uuid-shaped value is not an id", async () => {
    // First call (id lookup) empty, second call (slug lookup) hits — a slug can
    // itself be uuid-shaped.
    queue = [[], [{ id: "c-2" }]];
    expect(await resolveCollectionId(UUID)).toBe("c-2");
  });

  it("throws ValidationError (not a raw FK 500) when a uuid matches nothing", async () => {
    queue = [[], []];
    await expect(resolveCollectionId(UUID)).rejects.toThrow(ValidationError);
  });

  it("resolves a slug that exists", async () => {
    queue = [[{ id: "c-3" }]];
    expect(await resolveCollectionId("high-school")).toBe("c-3");
  });

  it("throws ValidationError when a slug matches nothing", async () => {
    queue = [[]];
    await expect(resolveCollectionId("nope")).rejects.toThrow(ValidationError);
  });
});

describe("assertContentAuthoringCapability", () => {
  const sub = "cognito-sub-123";

  it("gates a session caller WITHOUT the atrium-content capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);
    await expect(
      assertContentAuthoringCapability({ authType: "session", cognitoSub: sub })
    ).rejects.toThrow(ForbiddenError);
    expect(mockHasCapabilityAccess).toHaveBeenCalledWith(
      ATRIUM_CONTENT_CAPABILITY,
      sub
    );
  });

  it("allows a session caller WITH the atrium-content capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(true);
    await expect(
      assertContentAuthoringCapability({ authType: "session", cognitoSub: sub })
    ).resolves.toBeUndefined();
  });

  it("does NOT gate an api_key caller (scoped by explicit grant), even without the capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);
    await expect(
      assertContentAuthoringCapability({ authType: "api_key", cognitoSub: sub })
    ).resolves.toBeUndefined();
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled();
  });

  it("does NOT gate a jwt (OIDC) caller, even without the capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);
    await expect(
      assertContentAuthoringCapability({ authType: "jwt", cognitoSub: sub })
    ).resolves.toBeUndefined();
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled();
  });

  it("does NOT gate an internal caller with no authType (agent runtime)", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);
    await expect(
      assertContentAuthoringCapability({ cognitoSub: sub })
    ).resolves.toBeUndefined();
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled();
  });
});
