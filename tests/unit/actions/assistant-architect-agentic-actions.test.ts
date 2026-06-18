// NOTE: do NOT import `jest` from "@jest/globals" — doing so disables jest.mock
// hoisting and breaks all mocks. Use the global `jest`.
import { describe, it, expect, beforeEach } from "@jest/globals"

// ── Mock heavy infrastructure before any import of the action module ──────────

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(),
}))

jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: jest.fn(),
}))

jest.mock("@/utils/roles", () => ({
  hasRole: jest.fn(() => Promise.resolve(false)),
  hasToolAccess: jest.fn(() => Promise.resolve(false)),
}))

jest.mock("@/lib/tools/catalog/catalog", () => ({
  toolCatalogInstance: {
    list: jest.fn(() => Promise.resolve([])),
  },
}))

jest.mock("@/lib/api-keys/scopes", () => ({
  getScopesForRoles: jest.fn(() => ["mcp:test_tool"]),
}))

jest.mock("@/lib/tools/tool-registry", () => ({
  getAvailableToolsForModel: jest.fn(() => Promise.resolve([])),
  getAllTools: jest.fn(() => []),
}))

// The drizzle module is a large import; mock only the exports the action uses.
jest.mock("@/lib/db/drizzle", () => ({
  getAssistantArchitects: jest.fn(() => Promise.resolve([])),
  getAssistantArchitectById: jest.fn(() => Promise.resolve(null)),
  createAssistantArchitect: jest.fn(),
  updateAssistantArchitect: jest.fn(),
  deleteAssistantArchitect: jest.fn(),
  approveAssistantArchitect: jest.fn(),
  rejectAssistantArchitect: jest.fn(),
  submitForApproval: jest.fn(),
  getPendingAssistantArchitects: jest.fn(() => Promise.resolve([])),
  getToolInputFields: jest.fn(() => Promise.resolve([])),
  getChainPrompts: jest.fn(() => Promise.resolve([])),
  getUserById: jest.fn(() => Promise.resolve(null)),
  createToolInputField: jest.fn(),
  deleteToolInputField: jest.fn(),
  updateToolInputField: jest.fn(),
  createChainPrompt: jest.fn(),
  updateChainPrompt: jest.fn(),
  deleteChainPrompt: jest.fn(),
  getTools: jest.fn(() => Promise.resolve([])),
  getAIModels: jest.fn(() => Promise.resolve([])),
  getAIModelById: jest.fn(() => Promise.resolve(null)),
  getAssistantArchitectsByStatus: jest.fn(() => Promise.resolve([])),
  getRoleByName: jest.fn(() => Promise.resolve(null)),
  assignToolToRole: jest.fn(),
  createNavigationItem: jest.fn(),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
  executeTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: jest.fn() }) }) })
  ),
}))

// Stub drizzle-orm operators to passthrough (action imports eq/and/inArray etc.)
jest.mock("drizzle-orm", () => ({
  eq: jest.fn((...a: unknown[]) => a),
  and: jest.fn((...a: unknown[]) => a),
  inArray: jest.fn((...a: unknown[]) => a),
  desc: jest.fn((a: unknown) => a),
  sql: jest.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals })),
}))

// Stub the schema tables (values don't matter — only shape is referenced)
jest.mock("@/lib/db/schema", () => {
  const table = (name: string) => ({ _: { name }, id: {}, isActive: {}, updatedAt: {} })
  return {
    tools: table("tools"),
    navigationItems: table("navigation_items"),
    toolInputFields: table("tool_input_fields"),
    chainPrompts: table("chain_prompts"),
    assistantArchitects: table("assistant_architects"),
    userRoles: table("user_roles"),
    toolExecutions: table("tool_executions"),
    promptResults: table("prompt_results"),
    capabilities: table("capabilities"),
    roleCapabilities: table("role_capabilities"),
  }
})

jest.mock("@/lib/logger", () => {
  const log = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    createLogger: () => log,
    generateRequestId: () => "test-req-id",
    startTimer: () => jest.fn(),
    sanitizeForLogging: (x: unknown) => x,
  }
})

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  updateAssistantArchitectAction,
  getAvailableAgentToolsAction,
} from "@/actions/db/assistant-architect-actions"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { getScopesForRoles } from "@/lib/api-keys/scopes"

// Grab mock handles
const listMock = toolCatalogInstance.list as jest.Mock
const getScopesMock = getScopesForRoles as jest.Mock
const getServerSessionMock = (
  jest.requireMock("@/lib/auth/server-session") as { getServerSession: jest.Mock }
).getServerSession
const getCurrentUserMock = (
  jest.requireMock("@/actions/db/get-current-user-action") as { getCurrentUserAction: jest.Mock }
).getCurrentUserAction
const hasRoleMock = (
  jest.requireMock("@/utils/roles") as { hasRole: jest.Mock }
).hasRole
const getArchitectByIdMock = (
  jest.requireMock("@/lib/db/drizzle") as { getAssistantArchitectById: jest.Mock }
).getAssistantArchitectById
const updateArchitectMock = (
  jest.requireMock("@/lib/db/drizzle") as { updateAssistantArchitect: jest.Mock }
).updateAssistantArchitect

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AUTHOR_SESSION = { sub: "user-sub", userId: 10 }

const CURRENT_USER_OK = {
  isSuccess: true,
  data: {
    user: { id: 10, email: "author@psd401.net" },
    roles: [{ id: 1, name: "staff" }],
  },
}

function draftArchitect(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "My Architect",
    status: "draft",
    userId: 10,
    mode: "prompt_chain",
    agentEnabledTools: [],
    agentEnabledConnectors: [],
    agentMaxSteps: null,
    agentTimeoutSeconds: null,
    agentCostCapCents: null,
    ...overrides,
  }
}

// ── validateAgentTools (tested via updateAssistantArchitectAction) ─────────────

describe("validateAgentTools — via updateAssistantArchitectAction", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getServerSessionMock.mockResolvedValue(AUTHOR_SESSION)
    getCurrentUserMock.mockResolvedValue(CURRENT_USER_OK)
    hasRoleMock.mockResolvedValue(false) // not admin — author owns the record
    getArchitectByIdMock.mockResolvedValue(draftArchitect())
    updateArchitectMock.mockResolvedValue({ id: 1, name: "My Architect" })
    getScopesMock.mockReturnValue(["mcp:test_tool"])
    listMock.mockResolvedValue([])
  })

  it("rejects tools not in the author's allowed catalog set", async () => {
    // Catalog returns empty allowed set — no tools are available for agentic use
    listMock.mockResolvedValue([])

    const result = await updateAssistantArchitectAction("1", {
      agentEnabledTools: ["decisions.search"],
    })

    expect(result.isSuccess).toBe(false)
    expect(result.message).toMatch(/not available for agentic use/i)
  })

  it("rejects a mix where some tools are valid and at least one is not", async () => {
    // Only decisions.search is in the allowed set; decisions.capture is not
    listMock.mockResolvedValue([
      {
        identifier: "decisions.search",
        name: "search_decisions",
        description: "Search",
        inputSchema: { type: "object" },
        surfaces: ["internal"],
        requiredScopes: ["mcp:test_tool"],
        agentCallable: true,
        source: "code",
        isActive: true,
        version: "v1",
      },
    ])

    const result = await updateAssistantArchitectAction("1", {
      agentEnabledTools: ["decisions.search", "decisions.capture"],
    })

    expect(result.isSuccess).toBe(false)
    expect(result.message).toContain("decisions.capture")
  })

  it("accepts tools that are in the author's allowed catalog set", async () => {
    listMock.mockResolvedValue([
      {
        identifier: "decisions.search",
        name: "search_decisions",
        description: "Search",
        inputSchema: { type: "object" },
        surfaces: ["internal"],
        requiredScopes: ["mcp:test_tool"],
        agentCallable: true,
        source: "code",
        isActive: true,
        version: "v1",
      },
    ])

    const result = await updateAssistantArchitectAction("1", {
      agentEnabledTools: ["decisions.search"],
    })

    expect(result.isSuccess).toBe(true)
    // The validated tool list should have been passed to the DB update
    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentEnabledTools: ["decisions.search"] })
    )
  })

  it("queries the catalog with the author's scopes (not a hardcoded set)", async () => {
    getScopesMock.mockReturnValue(["mcp:special_scope"])
    listMock.mockResolvedValue([])

    await updateAssistantArchitectAction("1", {
      agentEnabledTools: ["some.tool"],
    })

    expect(getScopesMock).toHaveBeenCalledWith(["staff"])
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["mcp:special_scope"] })
    )
  })

  it("queries the catalog on the internal surface with agentOnly:true", async () => {
    listMock.mockResolvedValue([])

    await updateAssistantArchitectAction("1", {
      agentEnabledTools: ["any.tool"],
    })

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "internal", agentOnly: true })
    )
  })

  it("accepts an empty agentEnabledTools array without hitting the catalog", async () => {
    const result = await updateAssistantArchitectAction("1", {
      agentEnabledTools: [],
      mode: "agentic",
    })

    // Empty list is valid — catalog should not have been consulted for validation
    expect(listMock).not.toHaveBeenCalled()
    expect(result.isSuccess).toBe(true)
  })
})

// ── resolveAgenticUpdateFields — mode transition (via updateAssistantArchitectAction) ──

describe("resolveAgenticUpdateFields — mode transition enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getServerSessionMock.mockResolvedValue(AUTHOR_SESSION)
    getCurrentUserMock.mockResolvedValue(CURRENT_USER_OK)
    hasRoleMock.mockResolvedValue(false)
    listMock.mockResolvedValue([])
    updateArchitectMock.mockResolvedValue({ id: 1 })
  })

  it("rejects agentic -> prompt_chain mode reversal", async () => {
    getArchitectByIdMock.mockResolvedValue(draftArchitect({ mode: "agentic" }))

    const result = await updateAssistantArchitectAction("1", {
      mode: "prompt_chain",
    })

    expect(result.isSuccess).toBe(false)
    expect(result.message).toMatch(/cannot convert.*agentic.*back/i)
  })

  it("allows prompt_chain -> agentic transition", async () => {
    getArchitectByIdMock.mockResolvedValue(draftArchitect({ mode: "prompt_chain" }))
    updateArchitectMock.mockResolvedValue({ id: 1, mode: "agentic" })

    const result = await updateAssistantArchitectAction("1", {
      mode: "agentic",
    })

    expect(result.isSuccess).toBe(true)
    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ mode: "agentic" })
    )
  })

  it("allows agentic -> agentic (no-op mode update) without error", async () => {
    getArchitectByIdMock.mockResolvedValue(draftArchitect({ mode: "agentic" }))
    updateArchitectMock.mockResolvedValue({ id: 1, mode: "agentic" })

    const result = await updateAssistantArchitectAction("1", {
      mode: "agentic",
    })

    expect(result.isSuccess).toBe(true)
  })
})

// ── resolveAgenticUpdateFields — limit clamping ───────────────────────────────

describe("resolveAgenticUpdateFields — limit clamping", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getServerSessionMock.mockResolvedValue(AUTHOR_SESSION)
    getCurrentUserMock.mockResolvedValue(CURRENT_USER_OK)
    hasRoleMock.mockResolvedValue(false)
    getArchitectByIdMock.mockResolvedValue(draftArchitect())
    listMock.mockResolvedValue([])
    updateArchitectMock.mockResolvedValue({ id: 1 })
  })

  it("clamps agentMaxSteps above 50 to 50", async () => {
    await updateAssistantArchitectAction("1", { agentMaxSteps: 9999 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentMaxSteps: 50 })
    )
  })

  it("clamps agentMaxSteps below 1 to 1", async () => {
    await updateAssistantArchitectAction("1", { agentMaxSteps: 0 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentMaxSteps: 1 })
    )
  })

  it("clamps agentTimeoutSeconds above 900 to 900", async () => {
    await updateAssistantArchitectAction("1", { agentTimeoutSeconds: 99999 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentTimeoutSeconds: 900 })
    )
  })

  it("clamps agentTimeoutSeconds below 1 to 1", async () => {
    await updateAssistantArchitectAction("1", { agentTimeoutSeconds: -5 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentTimeoutSeconds: 1 })
    )
  })

  it("floors fractional agentMaxSteps", async () => {
    await updateAssistantArchitectAction("1", { agentMaxSteps: 7.9 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentMaxSteps: 7 })
    )
  })

  it("passes through a null agentCostCapCents as null", async () => {
    await updateAssistantArchitectAction("1", { agentCostCapCents: null })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentCostCapCents: null })
    )
  })

  it("clamps a negative agentCostCapCents to 1 (minimum allowed)", async () => {
    await updateAssistantArchitectAction("1", { agentCostCapCents: -100 })

    expect(updateArchitectMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ agentCostCapCents: 1 })
    )
  })
})

// ── getAvailableAgentToolsAction ──────────────────────────────────────────────

describe("getAvailableAgentToolsAction", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getServerSessionMock.mockResolvedValue(AUTHOR_SESSION)
    getCurrentUserMock.mockResolvedValue(CURRENT_USER_OK)
    getScopesMock.mockReturnValue(["mcp:test_tool"])
    listMock.mockResolvedValue([])
  })

  it("returns empty list when catalog has no agent-callable tools for the user", async () => {
    listMock.mockResolvedValue([])

    const result = await getAvailableAgentToolsAction()

    expect(result.isSuccess).toBe(true)
    expect(result.data).toEqual([])
  })

  it("returns available tools shaped as AvailableAgentTool", async () => {
    listMock.mockResolvedValue([
      {
        identifier: "decisions.search",
        name: "search_decisions",
        description: "Search board decisions",
        inputSchema: { type: "object" },
        surfaces: ["internal"],
        requiredScopes: ["mcp:test_tool"],
        agentCallable: true,
        source: "code",
        isActive: true,
        version: "v1",
      },
    ])

    const result = await getAvailableAgentToolsAction()

    expect(result.isSuccess).toBe(true)
    expect(result.data).toEqual([
      {
        identifier: "decisions.search",
        name: "search_decisions",
        description: "Search board decisions",
      },
    ])
  })

  it("queries the catalog with the user's role-derived scopes on internal surface with agentOnly:true", async () => {
    getScopesMock.mockReturnValue(["mcp:scoped"])
    listMock.mockResolvedValue([])

    await getAvailableAgentToolsAction()

    expect(listMock).toHaveBeenCalledWith({
      surface: "internal",
      scopes: ["mcp:scoped"],
      agentOnly: true,
    })
  })

  it("derives scopes from the user's role names", async () => {
    getCurrentUserMock.mockResolvedValue({
      isSuccess: true,
      data: {
        user: { id: 10, email: "x@psd401.net" },
        roles: [{ id: 2, name: "administrator" }],
      },
    })
    getScopesMock.mockReturnValue(["mcp:admin_scope"])
    listMock.mockResolvedValue([])

    await getAvailableAgentToolsAction()

    expect(getScopesMock).toHaveBeenCalledWith(["administrator"])
  })

  it("returns unauthorized when there is no session", async () => {
    getServerSessionMock.mockResolvedValue(null)

    const result = await getAvailableAgentToolsAction()

    expect(result.isSuccess).toBe(false)
    expect(result.message).toMatch(/unauthorized/i)
  })

  it("returns an error when getCurrentUserAction fails", async () => {
    getCurrentUserMock.mockResolvedValue({ isSuccess: false, data: null })

    const result = await getAvailableAgentToolsAction()

    expect(result.isSuccess).toBe(false)
    expect(result.message).toMatch(/user not found/i)
  })
})
