import { describe, it, expect, beforeEach } from "@jest/globals"

// executeQuery is globally mocked in jest.setup.js; we drive it per-call here.
import {
  queryGraphNodes,
  insertGraphEdge,
  escapeIlikePattern,
  GraphServiceError,
} from "@/lib/graph/graph-service"
import { executeQuery } from "@/lib/db/drizzle-client"

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>

// ============================================
// escapeIlikePattern — ILIKE injection hardening
// ============================================

describe("escapeIlikePattern", () => {
  it("escapes ILIKE wildcards so they match literally", () => {
    expect(escapeIlikePattern("100%")).toBe("100\\%")
    expect(escapeIlikePattern("a_b")).toBe("a\\_b")
  })

  it("escapes backslashes before wildcards (no double-escape)", () => {
    // A single backslash becomes two; a following % becomes \%
    expect(escapeIlikePattern("\\%")).toBe("\\\\\\%")
  })

  it("caps length at 100 characters", () => {
    expect(escapeIlikePattern("x".repeat(250))).toHaveLength(100)
  })

  it("trims surrounding whitespace", () => {
    expect(escapeIlikePattern("  hello  ")).toBe("hello")
  })
})

// ============================================
// queryGraphNodes — cursor pagination
// ============================================

describe("queryGraphNodes cursor pagination", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      name: `node-${i}`,
      nodeType: "decision",
      nodeClass: "decision",
      description: null,
      metadata: {},
      createdBy: 1,
      createdAt: new Date(2026, 0, 1, 0, 0, i),
      updatedAt: new Date(2026, 0, 1, 0, 0, i),
    }))
  }

  it("returns a nextCursor when more rows exist than the limit", async () => {
    // limit=2 -> service fetches limit+1 (3); 3 rows means hasMore.
    mockExecuteQuery.mockResolvedValue(rows(3) as never)
    const result = await queryGraphNodes(undefined, { limit: 2 })

    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).toEqual(expect.any(String))
    expect(result.nextCursor).not.toBe("")
  })

  it("returns nextCursor=null on the last page", async () => {
    mockExecuteQuery.mockResolvedValue(rows(2) as never)
    const result = await queryGraphNodes(undefined, { limit: 5 })

    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).toBeNull()
  })

  it("round-trips a valid cursor without throwing", async () => {
    mockExecuteQuery.mockResolvedValue(rows(3) as never)
    const first = await queryGraphNodes(undefined, { limit: 2 })
    expect(first.nextCursor).toBeTruthy()

    mockExecuteQuery.mockResolvedValue(rows(1) as never)
    const second = await queryGraphNodes(undefined, { limit: 2, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
  })

  it("tolerates a malformed cursor (decodes to null, still queries)", async () => {
    mockExecuteQuery.mockResolvedValue(rows(1) as never)
    const result = await queryGraphNodes(undefined, { limit: 5, cursor: "!!!not-base64!!!" })
    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })
})

// ============================================
// insertGraphEdge — DUPLICATE_EDGE + 23505 race + NODE_NOT_FOUND
// ============================================

describe("insertGraphEdge", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const input = { sourceNodeId: "src", targetNodeId: "tgt", edgeType: "INFORMED" }

  it("throws NODE_NOT_FOUND when a referenced node is missing", async () => {
    // validateNodes returns only 1 of 2 nodes
    mockExecuteQuery.mockResolvedValueOnce([{ id: "src" }] as never)

    await expect(insertGraphEdge(input, 1)).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    })
  })

  it("throws DUPLICATE_EDGE from the pre-insert existence check", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{ id: "src" }, { id: "tgt" }] as never) // validateNodes
      .mockResolvedValueOnce([{ id: "existing-edge" }] as never) // checkDuplicate

    await expect(insertGraphEdge(input, 1)).rejects.toMatchObject({
      code: "DUPLICATE_EDGE",
    })
  })

  it("maps a 23505 race on insert to DUPLICATE_EDGE", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{ id: "src" }, { id: "tgt" }] as never) // validateNodes
      .mockResolvedValueOnce([] as never) // checkDuplicate (none)
      .mockRejectedValueOnce({ code: "23505" }) // insert race

    const error = await insertGraphEdge(input, 1).catch((e) => e)
    expect(error).toBeInstanceOf(GraphServiceError)
    expect(error.code).toBe("DUPLICATE_EDGE")
  })

  it("returns the inserted edge on the happy path", async () => {
    const edge = { id: "edge-1", sourceNodeId: "src", targetNodeId: "tgt", edgeType: "INFORMED" }
    mockExecuteQuery
      .mockResolvedValueOnce([{ id: "src" }, { id: "tgt" }] as never) // validateNodes
      .mockResolvedValueOnce([] as never) // checkDuplicate
      .mockResolvedValueOnce([edge] as never) // insert

    const result = await insertGraphEdge(input, 1)
    expect(result).toMatchObject({ id: "edge-1", edgeType: "INFORMED" })
  })
})
