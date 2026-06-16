import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Stateful in-memory fake for the capabilities/role_capabilities tables.
// We mock executeTransaction to drive the sync's chained Drizzle calls against
// this fake so we can assert insert/update/deactivate/idempotency precisely.
// ============================================

interface FakeCapability {
  id: number
  identifier: string
  name: string
  description: string | null
  isActive: boolean
  source: "code" | "manual"
  promptChainToolId: number | null
}

interface FakeRoleCapability {
  roleId: number
  capabilityId: number
}

interface FakeRole {
  id: number
  name: string
}

/* eslint-disable no-var */
var fakeCapabilities: FakeCapability[]
var fakeRoleCapabilities: FakeRoleCapability[]
var fakeRoles: FakeRole[]
var nextCapabilityId: number
/* eslint-enable no-var */

// Column sentinels used by the sync; we only need identity, not real columns.
// Defined inside the mock factory because jest.mock is hoisted above this point.
jest.mock("@/lib/db/schema", () => ({
  capabilities: {
    table: "capabilities",
    id: "capabilities.id",
    identifier: "capabilities.identifier",
    source: "capabilities.source",
    isActive: "capabilities.isActive",
    promptChainToolId: "capabilities.promptChainToolId",
  },
  roleCapabilities: { table: "role_capabilities" },
  roles: { table: "roles", id: "roles.id", name: "roles.name" },
}))

// drizzle-orm operators return inert descriptors; the fake tx ignores them and
// applies fixed semantics based on which query the sync issues.
jest.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
  notInArray: (...args: unknown[]) => ({ op: "notInArray", args }),
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

// The fake transaction implements only the chained shapes the sync uses.
function makeTx() {
  return {
    execute: jest.fn(() => Promise.resolve([])),

    // SELECT { id, identifier } FROM capabilities WHERE inArray(identifier, [...])
    // and SELECT { id, name } FROM roles
    select(columns: Record<string, unknown>) {
      return {
        from(table: { table: string }) {
          if (table.table === "roles") {
            return Promise.resolve(
              fakeRoles.map((r) => ({ id: r.id, name: r.name }))
            )
          }
          // capabilities select is always followed by .where(inArray)
          return {
            where() {
              return Promise.resolve(
                fakeCapabilities.map((c) => ({
                  id: c.id,
                  identifier: c.identifier,
                }))
              )
            },
          }
          // columns param intentionally unused beyond shaping
          void columns
        },
      }
    },

    // INSERT INTO <table> VALUES(...).returning() / .onConflictDoNothing()
    insert(table: { table: string }) {
      return {
        values(vals: Record<string, unknown>) {
          if (table.table === "capabilities") {
            return {
              returning() {
                const row: FakeCapability = {
                  id: nextCapabilityId++,
                  identifier: String(vals.identifier),
                  name: String(vals.name),
                  description:
                    vals.description === undefined
                      ? null
                      : (vals.description as string | null),
                  isActive: vals.isActive !== false,
                  source: (vals.source as "code" | "manual") ?? "manual",
                  promptChainToolId: null,
                }
                fakeCapabilities.push(row)
                return Promise.resolve([{ id: row.id }])
              },
            }
          }
          // role_capabilities insert
          return {
            onConflictDoNothing() {
              const roleId = Number(vals.roleId)
              const capabilityId = Number(vals.capabilityId)
              const exists = fakeRoleCapabilities.some(
                (rc) => rc.roleId === roleId && rc.capabilityId === capabilityId
              )
              const insertedRows: { id: number }[] = []
              if (!exists) {
                fakeRoleCapabilities.push({ roleId, capabilityId })
                insertedRows.push({ id: fakeRoleCapabilities.length })
              }
              // grantDefaultRoles chains .returning() after onConflictDoNothing.
              return {
                returning: () => Promise.resolve(insertedRows),
              }
            },
          }
        },
      }
    },

    // UPDATE capabilities SET(...) WHERE(...) [.returning()]
    update() {
      return {
        set(vals: Record<string, unknown>) {
          return {
            // Update-by-id path (existing capability): where() returns void-ish.
            where(cond: { op: string; args: unknown[] }) {
              // Heuristic: an eq(capabilities.id, X) update targets one row;
              // the deactivate update uses and(...) and calls .returning().
              const result = {
                returning: () => {
                  // Deactivate orphans: source=code, active, ptci null, not in manifest.
                  // We approximate "not in manifest" by deactivating any active
                  // code capability whose identifier is NOT among those just
                  // upserted in this sync run (tracked via vals only — instead we
                  // deactivate based on the recorded manifest identifiers set).
                  const deactivated: { identifier: string }[] = []
                  for (const c of fakeCapabilities) {
                    if (
                      c.source === "code" &&
                      c.isActive &&
                      c.promptChainToolId === null &&
                      !manifestIdentifiersForRun.has(c.identifier)
                    ) {
                      c.isActive = false
                      deactivated.push({ identifier: c.identifier })
                    }
                  }
                  return Promise.resolve(deactivated)
                },
              }

              // Apply the single-row update (by id) when cond is a simple eq.
              if (cond?.op === "eq") {
                const id = Number((cond.args as unknown[])[1])
                const row = fakeCapabilities.find((c) => c.id === id)
                if (row) {
                  if (vals.name !== undefined) row.name = String(vals.name)
                  if (vals.description !== undefined) {
                    row.description = vals.description as string | null
                  }
                  if (vals.source !== undefined) {
                    row.source = vals.source as "code" | "manual"
                  }
                  if (vals.isActive !== undefined) {
                    row.isActive = Boolean(vals.isActive)
                  }
                }
              }

              return result
            },
          }
        },
      }
    },
  }
}

// Track which identifiers belong to the current manifest run (set by the test
// via the sync's manifest argument) so the fake deactivate logic can mimic
// "code-source capabilities not in manifest".
let manifestIdentifiersForRun = new Set<string>()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
  executeTransaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
    cb(makeTx())
  ),
}))

import { syncCapabilityManifest } from "@/lib/capabilities/sync"
import type { CapabilityManifestEntry } from "@/lib/capabilities/manifest"

function resetState() {
  fakeCapabilities = []
  fakeRoleCapabilities = []
  fakeRoles = [
    { id: 1, name: "administrator" },
    { id: 2, name: "staff" },
    { id: 3, name: "student" },
  ]
  nextCapabilityId = 100
  manifestIdentifiersForRun = new Set()
}

function runSync(manifest: CapabilityManifestEntry[]) {
  manifestIdentifiersForRun = new Set(manifest.map((m) => m.identifier))
  return syncCapabilityManifest(manifest)
}

describe("syncCapabilityManifest", () => {
  beforeEach(() => {
    resetState()
  })

  it("inserts new capabilities and grants default roles on first insert", async () => {
    const manifest: CapabilityManifestEntry[] = [
      {
        identifier: "feature-a",
        name: "Feature A",
        description: "desc a",
        defaultRoles: ["administrator", "staff"],
      },
    ]

    const result = await runSync(manifest)

    expect(result.inserted).toEqual(["feature-a"])
    expect(result.updated).toEqual([])
    expect(result.rolesGranted).toBe(2)

    const inserted = fakeCapabilities.find((c) => c.identifier === "feature-a")
    expect(inserted).toBeDefined()
    expect(inserted?.source).toBe("code")
    expect(inserted?.isActive).toBe(true)

    // administrator (1) + staff (2) grants for the new capability id.
    const capId = inserted!.id
    expect(fakeRoleCapabilities).toEqual(
      expect.arrayContaining([
        { roleId: 1, capabilityId: capId },
        { roleId: 2, capabilityId: capId },
      ])
    )
  })

  it("updates name/description/source and reactivates existing capabilities", async () => {
    // Seed a backfilled manual capability with stale name.
    fakeCapabilities.push({
      id: 5,
      identifier: "feature-b",
      name: "Old Name",
      description: "old",
      isActive: false,
      source: "manual",
      promptChainToolId: null,
    })

    const manifest: CapabilityManifestEntry[] = [
      {
        identifier: "feature-b",
        name: "Feature B",
        description: "new desc",
        defaultRoles: ["administrator"],
      },
    ]

    const result = await runSync(manifest)

    expect(result.inserted).toEqual([])
    expect(result.updated).toEqual(["feature-b"])
    // No role grants on update (only on first insert).
    expect(result.rolesGranted).toBe(0)
    expect(fakeRoleCapabilities).toHaveLength(0)

    const row = fakeCapabilities.find((c) => c.identifier === "feature-b")
    expect(row?.name).toBe("Feature B")
    expect(row?.description).toBe("new desc")
    expect(row?.source).toBe("code") // flipped manual -> code
    expect(row?.isActive).toBe(true) // reactivated
  })

  it("deactivates code-source capabilities no longer in the manifest", async () => {
    // An orphaned code capability not present in the new manifest.
    fakeCapabilities.push({
      id: 7,
      identifier: "removed-feature",
      name: "Removed",
      description: null,
      isActive: true,
      source: "code",
      promptChainToolId: null,
    })

    const result = await runSync([
      { identifier: "feature-c", name: "Feature C", description: "c" },
    ])

    expect(result.deactivated).toContain("removed-feature")
    const orphan = fakeCapabilities.find(
      (c) => c.identifier === "removed-feature"
    )
    expect(orphan?.isActive).toBe(false)
  })

  it("never deactivates manual capabilities or AA-lifecycle rows", async () => {
    fakeCapabilities.push({
      id: 8,
      identifier: "manual-gate",
      name: "Manual Gate",
      description: null,
      isActive: true,
      source: "manual",
      promptChainToolId: null,
    })
    fakeCapabilities.push({
      id: 9,
      identifier: "aa-tool",
      name: "AA Tool",
      description: null,
      isActive: true,
      source: "code",
      promptChainToolId: 42, // AA-lifecycle row
    })

    const result = await runSync([
      { identifier: "feature-d", name: "Feature D", description: "d" },
    ])

    expect(result.deactivated).not.toContain("manual-gate")
    expect(result.deactivated).not.toContain("aa-tool")
    expect(
      fakeCapabilities.find((c) => c.identifier === "manual-gate")?.isActive
    ).toBe(true)
    expect(
      fakeCapabilities.find((c) => c.identifier === "aa-tool")?.isActive
    ).toBe(true)
  })

  it("is idempotent: a second sync produces no inserts and no new grants", async () => {
    const manifest: CapabilityManifestEntry[] = [
      {
        identifier: "feature-e",
        name: "Feature E",
        description: "e",
        defaultRoles: ["administrator"],
      },
    ]

    const first = await runSync(manifest)
    expect(first.inserted).toEqual(["feature-e"])
    expect(first.rolesGranted).toBe(1)
    const grantsAfterFirst = fakeRoleCapabilities.length

    const second = await runSync(manifest)
    expect(second.inserted).toEqual([])
    expect(second.updated).toEqual(["feature-e"])
    expect(second.rolesGranted).toBe(0)
    // No duplicate grants.
    expect(fakeRoleCapabilities.length).toBe(grantsAfterFirst)
  })

  it("treats an empty manifest as a no-op (does NOT mass-deactivate)", async () => {
    // Seed an active code capability that would be wiped by an unguarded sync.
    fakeCapabilities.push({
      id: 20,
      identifier: "critical-feature",
      name: "Critical",
      description: null,
      isActive: true,
      source: "code",
      promptChainToolId: null,
    })

    const result = await runSync([])

    expect(result.inserted).toEqual([])
    expect(result.updated).toEqual([])
    expect(result.deactivated).toEqual([])
    // The critical capability must remain active.
    expect(
      fakeCapabilities.find((c) => c.identifier === "critical-feature")?.isActive
    ).toBe(true)
  })

  it("acquires the advisory lock inside the transaction", async () => {
    const txSpy = jest.fn(() => Promise.resolve([]))
    // Re-mock executeTransaction for this test to capture the execute call.
    const drizzleClient = jest.requireMock("@/lib/db/drizzle-client") as {
      executeTransaction: jest.Mock
    }
    drizzleClient.executeTransaction.mockImplementationOnce(
      (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = makeTx()
        tx.execute = txSpy
        return cb(tx)
      }
    )

    await runSync([{ identifier: "feature-f", name: "Feature F", description: "f" }])
    expect(txSpy).toHaveBeenCalled()
  })
})
