import { describe, it, expect, beforeEach } from "@jest/globals"

// Unit tests for the tool-version admin actions (#927). Validates the policy
// rules: deprecation input validation, removal eligibility (code-managed +
// grace-period gating), and that the runtime catalog cache is invalidated after
// a write.

/* eslint-disable no-var */
var mockRequireRole: jest.Mock
var mockGetToolCatalogVersion: jest.Mock
var mockDeprecateToolVersion: jest.Mock
var mockUndeprecateToolVersion: jest.Mock
var mockRemoveToolVersionWithPolicy: jest.Mock
var mockInvalidate: jest.Mock
// The row the transactional-remove mock runs the action's assertRemovable
// callback against (mirrors the real fn reading the FOR UPDATE locked row).
var removeRowFixture: Record<string, unknown> | undefined
/* eslint-enable no-var */

mockRequireRole = jest.fn(() => Promise.resolve({ user: { id: 1 } }))
mockGetToolCatalogVersion = jest.fn()
mockDeprecateToolVersion = jest.fn((p: Record<string, unknown>) =>
  Promise.resolve({ ...p, removalDate: p.removalDate })
)
mockUndeprecateToolVersion = jest.fn(() => Promise.resolve({ id: 1 }))
// Faithfully run the action's assertRemovable policy against the staged row,
// like the real transactional remove (read locked row -> policy -> delete). A
// policy violation throws out of the callback, exactly as in production.
mockRemoveToolVersionWithPolicy = jest.fn(
  (
    _identifier: string,
    _version: string,
    assertRemovable: (existing: unknown) => boolean
  ) => {
    const pastRemoval = assertRemovable(removeRowFixture)
    return Promise.resolve({ removed: removeRowFixture, pastRemoval })
  }
)
mockInvalidate = jest.fn()

jest.mock("@/lib/auth/role-helpers", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  listToolCatalogIdentifiers: jest.fn(() => Promise.resolve([])),
  getToolVersionsWithUsage: jest.fn(() => Promise.resolve([])),
  getToolCatalogVersion: (...args: unknown[]) => mockGetToolCatalogVersion(...args),
  deprecateToolVersion: (...args: unknown[]) => mockDeprecateToolVersion(...args),
  undeprecateToolVersion: (...args: unknown[]) =>
    mockUndeprecateToolVersion(...args),
  removeToolVersionWithPolicy: (...args: unknown[]) =>
    mockRemoveToolVersionWithPolicy(...args),
}))

jest.mock("@/lib/tools/catalog/catalog", () => ({
  toolCatalogInstance: { invalidate: (...args: unknown[]) => mockInvalidate(...args) },
}))

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "req",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({ requestId: "req", userId: undefined }),
}))

import {
  deprecateToolVersionAction,
  undeprecateToolVersionAction,
  removeToolVersionAction,
} from "@/actions/admin/tool-versions.actions"

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    identifier: "documents.create",
    version: "v1",
    source: "assistant",
    deprecatedAt: null,
    removalDate: null,
    replacedBy: null,
    gracePeriodDays: 90,
    ...overrides,
  }
}

describe("deprecateToolVersionAction (#927)", () => {
  beforeEach(() => {
    mockGetToolCatalogVersion.mockReset()
    mockDeprecateToolVersion.mockClear()
    mockInvalidate.mockClear()
  })

  it("deprecates an existing version and invalidates the cache", async () => {
    mockGetToolCatalogVersion.mockResolvedValue(row())
    const result = await deprecateToolVersionAction({
      identifier: "documents.create",
      version: "v1",
      replacedBy: "documents.create@v2",
      gracePeriodDays: 30,
    })
    expect(result.isSuccess).toBe(true)
    expect(mockDeprecateToolVersion).toHaveBeenCalledTimes(1)
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
  })

  it("rejects an invalid grace period", async () => {
    const result = await deprecateToolVersionAction({
      identifier: "documents.create",
      version: "v1",
      gracePeriodDays: 0,
    })
    expect(result.isSuccess).toBe(false)
    expect(mockDeprecateToolVersion).not.toHaveBeenCalled()
  })

  it("rejects a malformed replaced_by pointer", async () => {
    const result = await deprecateToolVersionAction({
      identifier: "documents.create",
      version: "v1",
      replacedBy: "documents.create", // no @version
    })
    expect(result.isSuccess).toBe(false)
  })

  it("rejects replacing a version by itself", async () => {
    const result = await deprecateToolVersionAction({
      identifier: "documents.create",
      version: "v1",
      replacedBy: "documents.create@v1",
    })
    expect(result.isSuccess).toBe(false)
  })

  it("fails when the version does not exist", async () => {
    mockGetToolCatalogVersion.mockResolvedValue(undefined)
    const result = await deprecateToolVersionAction({
      identifier: "documents.create",
      version: "v9",
    })
    expect(result.isSuccess).toBe(false)
    expect(mockDeprecateToolVersion).not.toHaveBeenCalled()
  })
})

describe("undeprecateToolVersionAction (#927)", () => {
  beforeEach(() => {
    mockGetToolCatalogVersion.mockReset()
    mockUndeprecateToolVersion.mockClear()
    mockInvalidate.mockClear()
  })

  it("restores a version and invalidates the cache", async () => {
    mockGetToolCatalogVersion.mockResolvedValue(row())
    const result = await undeprecateToolVersionAction("documents.create", "v1")
    expect(result.isSuccess).toBe(true)
    expect(mockUndeprecateToolVersion).toHaveBeenCalledTimes(1)
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
  })

  it("fails when the version does not exist", async () => {
    mockGetToolCatalogVersion.mockResolvedValue(undefined)
    const result = await undeprecateToolVersionAction("documents.create", "v9")
    expect(result.isSuccess).toBe(false)
    expect(mockUndeprecateToolVersion).not.toHaveBeenCalled()
  })
})

describe("removeToolVersionAction (#927)", () => {
  beforeEach(() => {
    removeRowFixture = undefined
    mockRemoveToolVersionWithPolicy.mockClear()
    mockInvalidate.mockClear()
  })

  it("refuses to remove a code-managed version", async () => {
    removeRowFixture = row({ source: "code" })
    const result = await removeToolVersionAction({
      identifier: "documents.create",
      version: "v1",
    })
    expect(result.isSuccess).toBe(false)
    // Policy rejected inside the transaction -> never reaches cache invalidation.
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("refuses to remove a non-deprecated version without force", async () => {
    removeRowFixture = row({ deprecatedAt: null })
    const result = await removeToolVersionAction({
      identifier: "documents.create",
      version: "v1",
    })
    expect(result.isSuccess).toBe(false)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("refuses to remove a version still within its grace period", async () => {
    removeRowFixture = row({
      deprecatedAt: new Date("2026-06-01"),
      removalDate: new Date("2099-01-01"), // far future
    })
    const result = await removeToolVersionAction({
      identifier: "documents.create",
      version: "v1",
    })
    expect(result.isSuccess).toBe(false)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("removes a deprecated version past its removal date", async () => {
    removeRowFixture = row({
      deprecatedAt: new Date("2026-01-01"),
      removalDate: new Date("2026-02-01"), // past
    })
    const result = await removeToolVersionAction({
      identifier: "documents.create",
      version: "v1",
    })
    expect(result.isSuccess).toBe(true)
    expect(mockRemoveToolVersionWithPolicy).toHaveBeenCalledTimes(1)
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
  })

  it("removes within grace period when force is set", async () => {
    removeRowFixture = row({
      deprecatedAt: new Date("2026-06-01"),
      removalDate: new Date("2099-01-01"),
    })
    const result = await removeToolVersionAction({
      identifier: "documents.create",
      version: "v1",
      force: true,
    })
    expect(result.isSuccess).toBe(true)
    expect(mockRemoveToolVersionWithPolicy).toHaveBeenCalledTimes(1)
  })
})
