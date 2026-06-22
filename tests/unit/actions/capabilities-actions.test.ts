import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks for the capability admin server actions. We verify the SECURITY rule:
// source='code' capabilities reject name/description edits server-side, while
// manual capabilities allow them. Also verify create validation + role assign.
// ============================================

/* eslint-disable no-var */
var mockRequireRole: jest.Mock
var mockGetCapabilityById: jest.Mock
var mockGetCapabilityByIdentifier: jest.Mock
var mockCreateCapability: jest.Mock
var mockUpdateCapability: jest.Mock
var mockSetCapabilityActive: jest.Mock
var mockAssignCapabilityToRole: jest.Mock
var mockRemoveCapabilityFromRole: jest.Mock
var mockGetCapabilityRoleIds: jest.Mock
/* eslint-enable no-var */

mockRequireRole = jest.fn(() => Promise.resolve({ user: { id: 1 } }))
mockGetCapabilityById = jest.fn()
mockGetCapabilityByIdentifier = jest.fn(() => Promise.resolve(undefined))
mockCreateCapability = jest.fn()
mockUpdateCapability = jest.fn((id: number, updates: Record<string, unknown>) =>
  Promise.resolve({ id, ...updates })
)
mockSetCapabilityActive = jest.fn((id: number, isActive: boolean) =>
  Promise.resolve({ id, isActive })
)
mockAssignCapabilityToRole = jest.fn(() => Promise.resolve(true))
mockRemoveCapabilityFromRole = jest.fn(() => Promise.resolve(true))
mockGetCapabilityRoleIds = jest.fn(() => Promise.resolve([]))

jest.mock("@/lib/auth/role-helpers", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  getCapabilities: jest.fn(() => Promise.resolve([])),
  getCapabilityById: (...args: unknown[]) => mockGetCapabilityById(...args),
  getCapabilityByIdentifier: (...args: unknown[]) =>
    mockGetCapabilityByIdentifier(...args),
  createCapability: (...args: unknown[]) => mockCreateCapability(...args),
  updateCapability: (...args: unknown[]) => mockUpdateCapability(...args),
  setCapabilityActive: (...args: unknown[]) => mockSetCapabilityActive(...args),
  getRoleCapabilities: jest.fn(() => Promise.resolve([])),
  getCapabilityRoleIds: (...args: unknown[]) => mockGetCapabilityRoleIds(...args),
  assignCapabilityToRole: (...args: unknown[]) =>
    mockAssignCapabilityToRole(...args),
  removeCapabilityFromRole: (...args: unknown[]) =>
    mockRemoveCapabilityFromRole(...args),
}))

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "test-id",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({ requestId: "test-id", userId: undefined }),
}))

import {
  createCapabilityAction,
  updateCapabilityAction,
  setCapabilityRoleAssignmentAction,
} from "@/actions/admin/capabilities.actions"

const CODE_CAP = {
  id: 10,
  identifier: "assistant-architect",
  name: "Assistant Architect",
  description: "Build assistants",
  isActive: true,
  source: "code" as const,
  promptChainToolId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const MANUAL_CAP = {
  id: 11,
  identifier: "legacy-gate",
  name: "Legacy Gate",
  description: "Old gate",
  isActive: true,
  source: "manual" as const,
  promptChainToolId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("capability admin actions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireRole.mockResolvedValue({ user: { id: 1 } })
    mockGetCapabilityByIdentifier.mockResolvedValue(undefined)
  })

  describe("createCapabilityAction", () => {
    it("creates a manual capability with a valid identifier", async () => {
      mockCreateCapability.mockResolvedValue({ ...MANUAL_CAP })
      const result = await createCapabilityAction({
        identifier: "new-gate",
        name: "New Gate",
        description: "x",
      })
      expect(result.isSuccess).toBe(true)
      expect(mockCreateCapability).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: "new-gate", source: "manual" })
      )
    })

    it("rejects an invalid identifier", async () => {
      const result = await createCapabilityAction({
        identifier: "Bad Identifier!",
        name: "X",
      })
      expect(result.isSuccess).toBe(false)
      expect(mockCreateCapability).not.toHaveBeenCalled()
    })

    it("rejects a duplicate identifier", async () => {
      mockGetCapabilityByIdentifier.mockResolvedValue({ ...MANUAL_CAP })
      const result = await createCapabilityAction({
        identifier: "legacy-gate",
        name: "X",
      })
      expect(result.isSuccess).toBe(false)
      expect(mockCreateCapability).not.toHaveBeenCalled()
    })
  })

  describe("updateCapabilityAction — source:code immutability (SECURITY)", () => {
    it("rejects a name change on a code capability", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...CODE_CAP })
      const result = await updateCapabilityAction(CODE_CAP.id, {
        name: "Renamed",
      })
      expect(result.isSuccess).toBe(false)
      expect(mockUpdateCapability).not.toHaveBeenCalled()
    })

    it("rejects a description change on a code capability", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...CODE_CAP })
      const result = await updateCapabilityAction(CODE_CAP.id, {
        description: "changed",
      })
      expect(result.isSuccess).toBe(false)
      expect(mockUpdateCapability).not.toHaveBeenCalled()
    })

    it("allows toggling is_active on a code capability", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...CODE_CAP })
      const result = await updateCapabilityAction(CODE_CAP.id, {
        isActive: false,
      })
      expect(result.isSuccess).toBe(true)
      expect(mockUpdateCapability).toHaveBeenCalledWith(CODE_CAP.id, {
        isActive: false,
      })
    })

    it("allows passing the SAME name on a code capability (no-op, not a change)", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...CODE_CAP })
      const result = await updateCapabilityAction(CODE_CAP.id, {
        name: CODE_CAP.name,
      })
      expect(result.isSuccess).toBe(true)
      // No name in updates since it didn't change.
      expect(mockUpdateCapability).toHaveBeenCalledWith(CODE_CAP.id, {})
    })
  })

  describe("updateCapabilityAction — manual capability editing", () => {
    it("allows name + description edits on a manual capability", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...MANUAL_CAP })
      const result = await updateCapabilityAction(MANUAL_CAP.id, {
        name: "Updated Name",
        description: "Updated desc",
      })
      expect(result.isSuccess).toBe(true)
      expect(mockUpdateCapability).toHaveBeenCalledWith(MANUAL_CAP.id, {
        name: "Updated Name",
        description: "Updated desc",
      })
    })

    it("rejects an empty name on a manual capability", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...MANUAL_CAP })
      const result = await updateCapabilityAction(MANUAL_CAP.id, { name: "   " })
      expect(result.isSuccess).toBe(false)
      expect(mockUpdateCapability).not.toHaveBeenCalled()
    })
  })

  describe("setCapabilityRoleAssignmentAction", () => {
    it("assigns a code capability to a role (role assignment always editable)", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...CODE_CAP })
      const result = await setCapabilityRoleAssignmentAction(
        CODE_CAP.id,
        2,
        true
      )
      expect(result.isSuccess).toBe(true)
      expect(mockAssignCapabilityToRole).toHaveBeenCalledWith(2, CODE_CAP.id)
    })

    it("removes a capability from a role", async () => {
      mockGetCapabilityById.mockResolvedValue({ ...MANUAL_CAP })
      const result = await setCapabilityRoleAssignmentAction(
        MANUAL_CAP.id,
        2,
        false
      )
      expect(result.isSuccess).toBe(true)
      expect(mockRemoveCapabilityFromRole).toHaveBeenCalledWith(2, MANUAL_CAP.id)
    })
  })
})
