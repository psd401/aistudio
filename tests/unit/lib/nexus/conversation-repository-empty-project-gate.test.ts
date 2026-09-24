/** @jest-environment node */

/**
 * Regression cover for FS#165251 / #1733.
 *
 * Every Nexus project auto-creates a private "project files" repository with
 * zero items. That repository derives readiness "empty", and the pre-turn
 * readiness gate used to reject the whole chat turn with REPOSITORY_NOT_READY —
 * so a freshly created project was chat-dead until a document finished
 * indexing. An empty repository must bind and be skipped, never block; a
 * half-built or broken one must still fail closed.
 */

jest.mock("server-only", () => ({}))

const mockExecuteQuery = jest.fn()
const mockAccessibleIds = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  executeTransaction: jest.fn(),
  toPgRows: (value: unknown) => value,
}))
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoryIds: (...args: unknown[]) =>
    mockAccessibleIds(...args),
}))

import { loadValidatedConversationRepositoryContext } from "@/lib/nexus/conversation-repository-service"
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service"
import { readinessRow } from "../repositories/readiness-fixtures"

const CONVERSATION_ID = "f96ad581-7b5a-4611-9c24-ca75ae92ca97"
const USER_ID = 42
const PROJECT_REPOSITORY_ID = 501
const CONNECTED_REPOSITORY_ID = 502

function searchableRow(repositoryId: number) {
  return readinessRow({
    repository_id: repositoryId,
    active_generation_id: "2b4e9f10-0d41-4a2b-9f1f-7b2a5f0c19ad",
    active_generation_status: "active",
    active_item_count: 3,
    indexed_item_count: 3,
    segment_count: 120,
  })
}

/**
 * Drive both queries the loader makes: the binding lookup and the readiness
 * snapshot. Keyed on the operation label so the test never depends on call
 * ordering.
 */
function wireQueries(input: {
  bindings: Array<{ repositoryId: number; source: string; sourceId: string }>
  readinessRows: unknown[]
}) {
  mockExecuteQuery.mockImplementation(
    async (_builder: unknown, label: string) => {
      if (label === "getConversationRepositoryBindings") {
        return input.bindings.map((binding) => ({
          conversationId: CONVERSATION_ID,
          repositoryId: binding.repositoryId,
          source: binding.source,
          sourceId: binding.sourceId,
        }))
      }
      if (label === "repositoryReadiness.load") return input.readinessRows
      throw new Error(`Unexpected query: ${label}`)
    }
  )
}

describe("Nexus conversation repository readiness gate", () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset()
    mockAccessibleIds.mockReset()
    mockAccessibleIds.mockImplementation(async (ids: number[]) => ids)
  })

  it("lets a brand-new project chat even though its repository is empty", async () => {
    wireQueries({
      bindings: [
        {
          repositoryId: PROJECT_REPOSITORY_ID,
          source: "project",
          sourceId: "e4238c5f-1414-4dc0-9a0a-2236a1db76f6",
        },
      ],
      readinessRows: [readinessRow({ repository_id: PROJECT_REPOSITORY_ID })],
    })

    const context = await loadValidatedConversationRepositoryContext({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
    })

    expect(context.repositoryIds).toEqual([PROJECT_REPOSITORY_ID])
    // Bound, but nothing to search — so no retrieval tool is scoped to it.
    expect(context.searchableRepositoryIds).toEqual([])
    expect(context.readiness[0]?.readiness).toBe("empty")
  })

  it("keeps searching the repositories that do have content", async () => {
    wireQueries({
      bindings: [
        {
          repositoryId: PROJECT_REPOSITORY_ID,
          source: "project",
          sourceId: "e4238c5f-1414-4dc0-9a0a-2236a1db76f6",
        },
        {
          repositoryId: CONNECTED_REPOSITORY_ID,
          source: "project",
          sourceId: "e4238c5f-1414-4dc0-9a0a-2236a1db76f6",
        },
      ],
      readinessRows: [
        readinessRow({ repository_id: PROJECT_REPOSITORY_ID }),
        searchableRow(CONNECTED_REPOSITORY_ID),
      ],
    })

    const context = await loadValidatedConversationRepositoryContext({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
    })

    expect(context.repositoryIds).toEqual([
      PROJECT_REPOSITORY_ID,
      CONNECTED_REPOSITORY_ID,
    ])
    expect(context.searchableRepositoryIds).toEqual([CONNECTED_REPOSITORY_ID])
  })

  it("still fails closed while a bound repository is mid-ingestion", async () => {
    wireQueries({
      bindings: [
        {
          repositoryId: PROJECT_REPOSITORY_ID,
          source: "project",
          sourceId: "e4238c5f-1414-4dc0-9a0a-2236a1db76f6",
        },
      ],
      readinessRows: [
        readinessRow({
          repository_id: PROJECT_REPOSITORY_ID,
          active_item_count: 1,
          pending_item_count: 1,
          building_generation_count: 1,
        }),
      ],
    })

    await expect(
      loadValidatedConversationRepositoryContext({
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
      })
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" })
  })

  it("still fails closed when a bound repository is broken", async () => {
    wireQueries({
      bindings: [
        {
          repositoryId: PROJECT_REPOSITORY_ID,
          source: "project",
          sourceId: "e4238c5f-1414-4dc0-9a0a-2236a1db76f6",
        },
      ],
      readinessRows: [
        readinessRow({
          repository_id: PROJECT_REPOSITORY_ID,
          active_item_count: 4,
        }),
      ],
    })

    await expect(
      loadValidatedConversationRepositoryContext({
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
      })
    ).rejects.toBeInstanceOf(RepositoryReadinessError)
  })
})
