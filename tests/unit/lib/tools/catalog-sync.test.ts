import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Stateful in-memory fake for the tool_catalog table. We mock executeTransaction
// to drive the sync's chained Drizzle calls against this fake so we can assert
// insert/update/deactivate/idempotency precisely. Mirrors the capabilities sync
// test (tests/unit/lib/capabilities/sync.test.ts).
// ============================================

interface FakeTool {
  id: number
  identifier: string
  version: string
  name: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
  surfaces: string[]
  requiredScopes: string[]
  agentCallable: boolean
  handlerRef: string | null
  source: "code" | "assistant" | "skill" | "retired"
  isActive: boolean
}

/* eslint-disable no-var */
var fakeTools: FakeTool[]
var nextToolId: number
/* eslint-enable no-var */

jest.mock("@/lib/db/schema", () => ({
  toolCatalog: {
    table: "tool_catalog",
    id: "tool_catalog.id",
    identifier: "tool_catalog.identifier",
    version: "tool_catalog.version",
    source: "tool_catalog.source",
    isActive: "tool_catalog.isActive",
  },
}))

jest.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
  ne: (...args: unknown[]) => ({ op: "ne", args }),
  sql: (() => {
    const fn = (...args: unknown[]) => ({ op: "sql", args })
    return fn
  })(),
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
}))

// sync.ts imports the manifest (-> tool-handlers -> DB layer). Mock the handlers
// so the manifest builds without pulling the real DB modules. The sync test
// drives its own manifest via runSync(), so handler identity is irrelevant here.
jest.mock("@/lib/mcp/tool-handlers", () => ({
  TOOL_HANDLERS: {
    search_decisions: jest.fn(),
    capture_decision: jest.fn(),
    execute_assistant: jest.fn(),
    list_assistants: jest.fn(),
    get_decision_graph: jest.fn(),
  },
}))

function snapshotRow(t: FakeTool) {
  return {
    id: t.id,
    identifier: t.identifier,
    version: t.version,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    surfaces: t.surfaces,
    requiredScopes: t.requiredScopes,
    agentCallable: t.agentCallable,
    handlerRef: t.handlerRef,
    source: t.source,
    isActive: t.isActive,
  }
}

function makeTx() {
  // Track which select() the sync is issuing. The sync issues two selects:
  //  1. snapshot of manifest identifiers (.from().where())
  //  2. orphan candidates (.from().where()) — distinguished by being the 2nd
  //     select call in the run.
  let selectCount = 0
  return {
    execute: jest.fn(() => Promise.resolve([])),

    select() {
      const which = selectCount++
      return {
        from() {
          return {
            where() {
              if (which === 0) {
                // snapshot of all rows (sync filters by identifier in SQL; the
                // fake returns all and the sync matches by composite key).
                return Promise.resolve(fakeTools.map(snapshotRow))
              }
              // orphan candidates: active code rows.
              return Promise.resolve(
                fakeTools
                  .filter((t) => t.source === "code" && t.isActive)
                  .map((t) => ({
                    id: t.id,
                    identifier: t.identifier,
                    version: t.version,
                  }))
              )
            },
          }
        },
      }
    },

    insert() {
      return {
        values(vals: Record<string, unknown>) {
          const row: FakeTool = {
            id: nextToolId++,
            identifier: String(vals.identifier),
            version: String(vals.version ?? "v1"),
            name: String(vals.name),
            description: String(vals.description),
            inputSchema: vals.inputSchema ?? null,
            outputSchema: vals.outputSchema ?? null,
            surfaces: (vals.surfaces as string[]) ?? [],
            requiredScopes: (vals.requiredScopes as string[]) ?? [],
            agentCallable: vals.agentCallable !== false,
            handlerRef: (vals.handlerRef as string | null) ?? null,
            source: (vals.source as FakeTool["source"]) ?? "code",
            isActive: vals.isActive !== false,
          }
          fakeTools.push(row)
          return Promise.resolve(undefined)
        },
      }
    },

    update() {
      return {
        set(vals: Record<string, unknown>) {
          const applyVals = (row: FakeTool) => {
            if (vals.name !== undefined) row.name = String(vals.name)
            if (vals.description !== undefined)
              row.description = String(vals.description)
            if (vals.inputSchema !== undefined)
              row.inputSchema = vals.inputSchema
            if (vals.outputSchema !== undefined)
              row.outputSchema = vals.outputSchema
            if (vals.surfaces !== undefined)
              row.surfaces = vals.surfaces as string[]
            if (vals.requiredScopes !== undefined)
              row.requiredScopes = vals.requiredScopes as string[]
            if (vals.agentCallable !== undefined)
              row.agentCallable = Boolean(vals.agentCallable)
            if (vals.handlerRef !== undefined)
              row.handlerRef = vals.handlerRef as string | null
            if (vals.source !== undefined)
              row.source = vals.source as FakeTool["source"]
            if (vals.isActive !== undefined)
              row.isActive = Boolean(vals.isActive)
          }
          return {
            where(cond: { op: string; args: unknown[] }) {
              if (cond?.op === "eq") {
                const id = Number((cond.args as unknown[])[1])
                const row = fakeTools.find((t) => t.id === id)
                if (row) applyVals(row)
              } else if (cond?.op === "inArray") {
                // Batch deactivation: args[1] is the array of ids.
                const ids = (cond.args as unknown[])[1] as number[]
                const idSet = new Set(ids.map((n) => Number(n)))
                for (const row of fakeTools) {
                  if (idSet.has(row.id)) applyVals(row)
                }
              }
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  }
}

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
  executeTransaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
    cb(makeTx())
  ),
}))

import { syncToolCatalogManifest } from "@/lib/tools/catalog/sync"
import type { ToolManifestEntry } from "@/lib/tools/catalog/types"

function resetState() {
  fakeTools = []
  nextToolId = 100
}

function runSync(manifest: ToolManifestEntry[]) {
  return syncToolCatalogManifest(manifest)
}

function entry(over: Partial<ToolManifestEntry> = {}): ToolManifestEntry {
  return {
    identifier: "decisions.search",
    version: "v1",
    name: "search_decisions",
    description: "Search decisions",
    inputSchema: { type: "object", properties: {} },
    surfaces: ["mcp"],
    requiredScopes: ["mcp:search_decisions"],
    agentCallable: true,
    ...over,
  }
}

describe("syncToolCatalogManifest", () => {
  beforeEach(() => {
    resetState()
  })

  it("inserts new tools that are not in the DB", async () => {
    const result = await runSync([entry()])
    expect(result.inserted).toEqual(["decisions.search@v1"])
    expect(result.updated).toEqual([])
    expect(fakeTools).toHaveLength(1)
    expect(fakeTools[0]).toMatchObject({
      identifier: "decisions.search",
      version: "v1",
      source: "code",
      isActive: true,
      handlerRef: "decisions.search",
    })
  })

  it("is idempotent — a second sync with no changes is a no-op", async () => {
    await runSync([entry()])
    const second = await runSync([entry()])
    expect(second.inserted).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.deactivated).toEqual([])
    expect(fakeTools).toHaveLength(1)
  })

  it("updates only when a manifest field changes", async () => {
    await runSync([entry()])
    const result = await runSync([entry({ description: "New description" })])
    expect(result.updated).toEqual(["decisions.search@v1"])
    expect(fakeTools[0].description).toBe("New description")
  })

  it("deactivates and demotes a code tool removed from the manifest", async () => {
    await runSync([entry(), entry({ identifier: "decisions.capture", name: "capture_decision" })])
    expect(fakeTools).toHaveLength(2)

    // Drop decisions.capture from the manifest.
    const result = await runSync([entry()])
    expect(result.deactivated).toEqual(["decisions.capture@v1"])
    const dropped = fakeTools.find((t) => t.identifier === "decisions.capture")!
    expect(dropped.isActive).toBe(false)
    expect(dropped.source).toBe("retired") // demoted/released
  })

  it("never touches assistant/skill-derived rows during deactivation", async () => {
    await runSync([entry()])
    // Simulate an assistant-derived row in the DB.
    fakeTools.push({
      id: 999,
      identifier: "assistants.custom",
      version: "v1",
      name: "custom",
      description: "x",
      inputSchema: null,
      outputSchema: null,
      surfaces: ["mcp"],
      requiredScopes: [],
      agentCallable: true,
      handlerRef: "assistant:7",
      source: "assistant",
      isActive: true,
    })
    await runSync([entry()])
    const assistantRow = fakeTools.find((t) => t.id === 999)!
    expect(assistantRow.isActive).toBe(true)
    expect(assistantRow.source).toBe("assistant")
  })

  it("re-claims ownership of a previously-released row (reactivates)", async () => {
    await runSync([entry()])
    // Release it by removing from manifest.
    await runSync([])
    // Empty manifest is a guarded no-op, so manually release for the test
    // (mirrors deactivateOrphans demoting a removed code row to 'retired').
    const row = fakeTools[0]
    row.isActive = false
    row.source = "retired"

    const result = await runSync([entry()])
    expect(result.updated).toContain("decisions.search@v1")
    expect(fakeTools[0].isActive).toBe(true)
    expect(fakeTools[0].source).toBe("code")
  })

  it("throws on duplicate (identifier, version) pairs", async () => {
    await expect(runSync([entry(), entry()])).rejects.toThrow(
      /duplicate \(identifier, version\)/
    )
  })

  it("skips an empty manifest to avoid mass deactivation", async () => {
    await runSync([entry()])
    const result = await runSync([])
    expect(result.inserted).toEqual([])
    expect(result.deactivated).toEqual([])
    expect(fakeTools[0].isActive).toBe(true)
  })
})
