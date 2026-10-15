/**
 * Issue #1907 — MCP repository write tools (`repositories_create`,
 * `repositories_add_item`).
 *
 * These are the FIRST repository tools that mutate state, so the tests pin the
 * authorization order rather than just the happy path:
 *
 * 1. argument validation happens before any authorization lookup (a malformed
 *    call must not even probe whether a repository exists);
 * 2. the live `knowledge-repositories` capability is re-checked on every call —
 *    an OAuth access token's scopes come from the grant, not the caller's roles,
 *    so the scope gate alone would let a student who connected the first-party
 *    agent client create repositories;
 * 3. `repositories_add_item` additionally requires owner/administrator rights on
 *    a durable, user-managed repository, and masks everything else as
 *    "Repository not found" so the tool never confirms an id the caller cannot
 *    touch.
 */

import { beforeEach, describe, expect, it } from "@jest/globals"

/* eslint-disable no-var */
var mockCreateRepository = jest.fn()
var mockHasCapabilityAccess = jest.fn()
var mockCanModify = jest.fn()
var mockCreateRepositoryTextItem = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/db/drizzle", () => ({
  __esModule: true,
  createRepository: (...args: unknown[]) => mockCreateRepository(...args),
  hasCapabilityAccess: (...args: unknown[]) => mockHasCapabilityAccess(...args),
}))
jest.mock("@/lib/repositories/repository-permissions", () => ({
  __esModule: true,
  canModifyUserManagedDurableRepository: (...args: unknown[]) =>
    mockCanModify(...args),
}))
// Only the write call is stubbed; the BOUNDS come from the real module so a
// change to a cap is reflected here instead of being shadowed by a mock value.
jest.mock("@/lib/repositories/repository-write-service", () => ({
  __esModule: true,
  ...jest.requireActual<
    typeof import("@/lib/repositories/repository-write-service")
  >("@/lib/repositories/repository-write-service"),
  createRepositoryTextItem: (...args: unknown[]) =>
    mockCreateRepositoryTextItem(...args),
}))
jest.mock("@/lib/repositories/repository-catalog-service", () => ({
  __esModule: true,
  describeRepository: jest.fn(),
  getRepositorySource: jest.fn(),
  listRepositoryCatalog: jest.fn(),
  listRepositoryChanges: jest.fn(),
  searchRepositoryCatalog: jest.fn(),
}))
jest.mock("@/lib/graph/decision-retrieval", () => ({
  __esModule: true,
  getDecisionPackage: jest.fn(),
  semanticSearchNodes: jest.fn(),
}))
jest.mock("@/lib/graph/graph-service", () => ({
  __esModule: true,
  queryGraphNodes: jest.fn(),
}))
jest.mock("@/lib/graph/decision-capture-service", () => ({
  __esModule: true,
  captureStructuredDecision: jest.fn(),
  createDecisionSchema: { safeParse: jest.fn() },
  describeDecisionError: jest.fn(),
}))
jest.mock("@/lib/api/assistant-execution-service", () => ({
  __esModule: true,
  executeAssistantForJobCompletion: jest.fn(),
  validateExecutionInputs: jest.fn(),
}))
jest.mock("@/lib/api/assistant-service", () => ({
  __esModule: true,
  listAccessibleAssistants: jest.fn(),
}))
jest.mock("@/lib/api/route-helpers", () => ({
  __esModule: true,
  checkAssistantResourceGrants: jest.fn(),
  isAdminByUserId: jest.fn(),
}))
jest.mock("@/actions/db/assistant-architect-actions", () => ({
  __esModule: true,
  getAssistantArchitectByIdAction: jest.fn(),
}))
jest.mock("@/lib/agents/agent-tools", () => ({
  __esModule: true,
  AGENT_TOOL_HANDLERS: {},
}))
jest.mock("@/lib/mcp/content-tool-handlers", () => ({
  __esModule: true,
  CONTENT_TOOL_HANDLERS: {},
}))
jest.mock("@/lib/capabilities/capability-catalog", () => ({
  __esModule: true,
  buildCapabilityCatalog: jest.fn(() => ({})),
}))

import fs from "node:fs"
import path from "node:path"

import { TOOL_HANDLERS } from "@/lib/mcp/tool-handlers"
import { MCP_TOOLS } from "@/lib/mcp/tool-registry"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"
import { API_SCOPES, ROLE_SCOPES } from "@/lib/api-keys/scopes"
import { AISTUDIO_OPENCLAW_SCOPES } from "@/lib/oauth/openclaw-client"
import { REPOSITORY_INLINE_TEXT_MAX_BYTES } from "@/lib/repositories/repository-write-service"

const CONTEXT = {
  userId: 7,
  cognitoSub: "user-sub",
  scopes: ["repositories:create", "repositories:write"],
  requestId: "request-1",
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "")
}

beforeEach(() => {
  jest.clearAllMocks()
  mockHasCapabilityAccess.mockResolvedValue(true)
  mockCanModify.mockResolvedValue(true)
})

describe("MCP repositories_create (#1907)", () => {
  it("creates a PRIVATE repository owned by the caller", async () => {
    mockCreateRepository.mockResolvedValue({
      id: 42,
      name: "Transportation SOPs",
      description: "Routing",
      isPublic: false,
      repositoryKind: "durable",
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
    })

    const result = await TOOL_HANDLERS.repositories_create(
      { name: "  Transportation SOPs  ", description: " Routing " },
      CONTEXT
    )

    expect(result.isError).toBeUndefined()
    expect(mockCreateRepository).toHaveBeenCalledWith({
      name: "Transportation SOPs",
      description: "Routing",
      ownerId: 7,
      isPublic: false,
    })
    expect(payload(result).repository).toEqual({
      id: 42,
      name: "Transportation SOPs",
      description: "Routing",
      visibility: "private",
      repositoryKind: "durable",
      createdAt: "2026-10-14T00:00:00.000Z",
    })
  })

  it("treats a blank description as absent, matching the Repository Manager UI", async () => {
    mockCreateRepository.mockResolvedValue({
      id: 44,
      name: "Notes",
      description: null,
      isPublic: false,
      repositoryKind: "durable",
      createdAt: null,
    })

    const result = await TOOL_HANDLERS.repositories_create(
      { name: "Notes", description: "   " },
      CONTEXT
    )

    // The UI's create form accepts a blank description; rejecting it here would
    // make the two surfaces disagree over a field the caller just left empty.
    expect(result.isError).toBeUndefined()
    expect(mockCreateRepository).toHaveBeenCalledWith(
      expect.objectContaining({ description: null })
    )
  })

  it("omits an absent description rather than storing an empty string", async () => {
    mockCreateRepository.mockResolvedValue({
      id: 43,
      name: "Notes",
      description: null,
      isPublic: false,
      repositoryKind: "durable",
      createdAt: null,
    })

    await TOOL_HANDLERS.repositories_create({ name: "Notes" }, CONTEXT)

    expect(mockCreateRepository).toHaveBeenCalledWith(
      expect.objectContaining({ description: null })
    )
  })

  it("refuses a caller without the knowledge-repositories capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false)

    const result = await TOOL_HANDLERS.repositories_create(
      { name: "Transportation SOPs" },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(mockHasCapabilityAccess).toHaveBeenCalledWith(
      "user-sub",
      "knowledge-repositories"
    )
    expect(mockCreateRepository).not.toHaveBeenCalled()
  })

  it("rejects a blank or oversized name before any authorization lookup", async () => {
    for (const name of ["", "   ", "x".repeat(501), 5]) {
      const result = await TOOL_HANDLERS.repositories_create({ name }, CONTEXT)
      expect(result.isError).toBe(true)
    }
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled()
    expect(mockCreateRepository).not.toHaveBeenCalled()
  })

  it("rejects an oversized description", async () => {
    const result = await TOOL_HANDLERS.repositories_create(
      { name: "Notes", description: "x".repeat(2001) },
      CONTEXT
    )
    expect(result.isError).toBe(true)
    expect(mockCreateRepository).not.toHaveBeenCalled()
  })
})

describe("MCP repositories_add_item (#1907)", () => {
  const item = {
    id: 900,
    repositoryId: 42,
    name: "Bell times",
    type: "text",
    processingStatus: "pending",
    processingError: null,
    createdAt: new Date("2026-10-14T00:00:00.000Z"),
    writePath: "canonical",
  }

  it("adds the item once the capability and repository ACL both pass", async () => {
    mockCreateRepositoryTextItem.mockResolvedValue(item)

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: " Bell times ", content: "7:45 AM" },
      CONTEXT
    )

    expect(result.isError).toBeUndefined()
    expect(mockCanModify).toHaveBeenCalledWith(42, 7)
    expect(mockCreateRepositoryTextItem).toHaveBeenCalledWith({
      repositoryId: 42,
      userId: 7,
      name: "Bell times",
      content: "7:45 AM",
      traceId: "request-1",
      // Distinct from the Server Action's "addTextItem" so the shared write
      // service's logs and DB operation label still say which surface wrote.
      callerAction: "repositories_add_item",
    })
    expect(payload(result).item).toEqual({
      id: 900,
      repositoryId: 42,
      name: "Bell times",
      type: "text",
      processingStatus: "pending",
      processingError: null,
      createdAt: "2026-10-14T00:00:00.000Z",
    })
  })

  it("masks a repository the caller cannot modify as not found", async () => {
    mockCanModify.mockResolvedValue(false)

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("Repository not found")
    expect(mockCreateRepositoryTextItem).not.toHaveBeenCalled()
  })

  it("refuses a caller without the knowledge-repositories capability before touching the ACL", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false)

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(mockCanModify).not.toHaveBeenCalled()
    expect(mockCreateRepositoryTextItem).not.toHaveBeenCalled()
  })

  it("rejects an invalid repositoryId, blank name, or blank content", async () => {
    const bad = [
      { repositoryId: 0, name: "n", content: "c" },
      { repositoryId: -1, name: "n", content: "c" },
      { repositoryId: 1.5, name: "n", content: "c" },
      { repositoryId: "42", name: "n", content: "c" },
      { repositoryId: 42, name: "   ", content: "c" },
      { repositoryId: 42, name: "n", content: "   " },
      { repositoryId: 42, name: "n", content: 7 },
    ]
    for (const args of bad) {
      const result = await TOOL_HANDLERS.repositories_add_item(args, CONTEXT)
      expect(result.isError).toBe(true)
    }
    expect(mockCreateRepositoryTextItem).not.toHaveBeenCalled()
  })

  it("reports an accepted item as processing and NOT searchable", async () => {
    mockCreateRepositoryTextItem.mockResolvedValue(item)

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(payload(result).ingestion).toBe("processing")
    expect(payload(result).searchable).toBe("no")
    expect(payload(result).note).toContain("NOT searchable yet")
  })

  it("reports the legacy path as keyword-searchable, not processing", async () => {
    // `completed` at this point can only be the legacy path (content dual-write
    // off). Its chunk's `search_vector` is a GENERATED column and retrieval v2's
    // legacy-compatibility candidates (on by default for repositories_search)
    // match it by keyword at once. Nothing ever embeds it (no canonical
    // generation for embedding-recovery or dense retrieval to reach), so it is
    // keyword-only, and the note must not promise semantic search later. No
    // background ingestion is in flight, so "processing" would be a misreport.
    mockCreateRepositoryTextItem.mockResolvedValue({
      ...item,
      processingStatus: "completed",
      writePath: "legacy",
    })

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(payload(result).ingestion).toBe("completed")
    expect(payload(result).searchable).toBe("keyword")
    expect(payload(result).note).toContain("by keyword match only")
    // An untargeted search only covers the first 50 catalog repositories, so
    // the note steers to a search filtered to the item's repository (which the
    // catalog search exempts from the readiness gate for legacy-only repos).
    expect(payload(result).note).toContain("pass repositoryIds")
    expect(payload(result).note).not.toMatch(/backfill|start once/i)
  })

  it("does not mistake a canonical item the worker already published for legacy", async () => {
    // Race: the canonical worker can publish the item (`completed`) before the
    // handler's re-read. Readiness comes from the write path, not the status,
    // so this must NOT be reported as keyword-only legacy content.
    mockCreateRepositoryTextItem.mockResolvedValue({
      ...item,
      processingStatus: "completed",
      writePath: "canonical",
    })

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(payload(result).searchable).toBe("no")
    expect(payload(result).ingestion).toBe("processing")
    expect(payload(result).note).not.toContain("keyword match only")
  })

  it("tells the agent to RETRY, not poll, when ingestion already failed", async () => {
    // The row is re-read after the canonical shadow-write, so `failed` means
    // registration already failed and nothing is in flight. "Check back later"
    // would make an agent poll forever.
    mockCreateRepositoryTextItem.mockResolvedValue({
      ...item,
      processingStatus: "failed",
      processingError: "Canonical content registration failed. Retry this item.",
    })

    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "Bell times", content: "7:45 AM" },
      CONTEXT
    )

    expect(payload(result).ingestion).toBe("failed")
    expect(payload(result).searchable).toBe("no")
    expect(payload(result).note).toContain("Do NOT wait or poll")
    expect(payload(result).item.processingError).toContain("Retry this item")
  })

  it("preserves content verbatim while rejecting whitespace-only content", async () => {
    mockCreateRepositoryTextItem.mockResolvedValue(item)

    await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "n", content: "  indented\n  lines  " },
      CONTEXT
    )

    // The name is trimmed; the body is stored exactly as sent, so Markdown
    // indentation and trailing newlines survive.
    expect(mockCreateRepositoryTextItem).toHaveBeenCalledWith(
      expect.objectContaining({ content: "  indented\n  lines  " })
    )
  })

  it("bounds content by UTF-8 BYTES, not characters", async () => {
    // 600k 2-byte characters is 1.2 MB — under a 1 MiB *character* count but
    // over the byte budget the stored column and S3 object actually pay for.
    const result = await TOOL_HANDLERS.repositories_add_item(
      { repositoryId: 42, name: "n", content: "é".repeat(600_000) },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("bytes")
    expect(mockCreateRepositoryTextItem).not.toHaveBeenCalled()
  })
})

const WRITE_TOOLS = [
  ["repositories_create", "repositories:create"],
  ["repositories_add_item", "repositories:write"],
] as const

describe("repository write catalog + scope wiring (#1907)", () => {
  it.each(WRITE_TOOLS)(
    "publishes %s on the MCP surface requiring %s",
    (name, scope) => {
      expect(MCP_TOOLS.some((tool) => tool.name === name)).toBe(true)
      const entry = TOOL_MANIFEST.find((tool) => tool.name === name)
      expect(entry).toBeDefined()
      expect(entry?.requiredScopes).toEqual([scope])
      expect(entry?.surfaces).toContain("mcp")
      // Both mutate durable state, so an agent loop must confirm first (#926).
      expect(entry?.destructive).toBe(true)
    }
  )

  it.each(WRITE_TOOLS)(
    "grants %s's scope %s to staff and administrators only",
    (_name, scope) => {
      expect(ROLE_SCOPES.staff).toContain(scope)
      expect(ROLE_SCOPES.administrator).toContain(scope)
      expect(ROLE_SCOPES.student).not.toContain(scope)
    }
  )

  it("defines the new repositories:create scope", () => {
    expect(API_SCOPES["repositories:create"]).toBe(
      "Create repositories owned by the API principal"
    )
  })

  it("bounds the item name by UTF-8 bytes, like the content", async () => {
    // 200 four-byte emoji is 800 bytes — under a 500-CHARACTER cap but over the
    // 500-BYTE one the unbounded text column actually pays for.
    const result = await TOOL_HANDLERS.repositories_create(
      { name: "\u{1F600}".repeat(200) },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("bytes")
  })

  it("keeps the agent skill's local byte cap equal to the server's", () => {
    // run.js is a standalone CJS script in the agent image: it cannot import
    // from the Next.js tree, so its cap is a copy. Without this check the copy
    // drifts silently and the skill accepts payloads the server then rejects.
    const runJs = fs.readFileSync(
      path.join(
        process.cwd(),
        "infra/agent-image/skills/psd-aistudio/run.js"
      ),
      "utf8"
    )
    const declared = /REPOSITORY_ITEM_MAX_BYTES = (\d+) \* (\d+);/.exec(runJs)
    expect(declared).not.toBeNull()
    expect(Number(declared?.[1]) * Number(declared?.[2])).toBe(
      REPOSITORY_INLINE_TEXT_MAX_BYTES
    )
  })

  it("lets the first-party OpenClaw client request the write scopes", () => {
    // Must stay in step with the client's allowed_scopes column
    // (infra/database/schema/189-openclaw-repository-write-scopes.sql) — the
    // OIDC provider rejects a scope the registered client does not allow.
    expect(AISTUDIO_OPENCLAW_SCOPES).toContain("repositories:create")
    expect(AISTUDIO_OPENCLAW_SCOPES).toContain("repositories:write")
  })
})
