/**
 * Unit tests for the shared Atrium people-search query (#1860).
 *
 * `lib/content/people-search.ts` is the ONE query behind both the web visibility
 * editor's picker and the agent broker's `GET /people`, so the rules it enforces
 * are the rules both surfaces get: the minimum query length, the row cap, the
 * truthfulness of the `truncated` signal, and the exclusion of rows whose email is
 * NULL (a person the caller cannot confirm is the intended grantee).
 *
 * The DB is mocked — these assert the module's own decisions, not Postgres's.
 */

const executeQueryMock = jest.fn()
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}))

import {
  searchPeople,
  PEOPLE_SEARCH_MIN_QUERY_LENGTH,
  PEOPLE_SEARCH_RESULT_LIMIT,
} from "@/lib/content/people-search"

function fakeRows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1 + offset,
    name: `Person ${index + offset}`,
    email: `person${index + offset}@psd401.net`,
  }))
}

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockResolvedValue([])
})

describe("searchPeople bounding", () => {
  it("returns an empty result WITHOUT querying below the minimum length", async () => {
    for (const query of ["", "   ", "a", " b "]) {
      const result = await searchPeople(query)
      expect(result).toEqual({ people: [], truncated: false })
    }
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("queries once the term reaches the minimum length", async () => {
    expect(PEOPLE_SEARCH_MIN_QUERY_LENGTH).toBe(2)
    await searchPeople("st")
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
  })

  it("reports truncated ONLY when a match exists beyond the cap", async () => {
    // The query asks for one row past the cap precisely so this flag means
    // "there is more", not "the result happens to be exactly cap-length".
    executeQueryMock.mockResolvedValue(fakeRows(PEOPLE_SEARCH_RESULT_LIMIT))
    const exact = await searchPeople("person")
    expect(exact.people).toHaveLength(PEOPLE_SEARCH_RESULT_LIMIT)
    expect(exact.truncated).toBe(false)

    executeQueryMock.mockResolvedValue(fakeRows(PEOPLE_SEARCH_RESULT_LIMIT + 1))
    const more = await searchPeople("person")
    // The extra probe row is never handed to the caller.
    expect(more.people).toHaveLength(PEOPLE_SEARCH_RESULT_LIMIT)
    expect(more.truncated).toBe(true)
  })
})

describe("searchPeople projection", () => {
  it("drops a row with no email instead of asserting one exists", async () => {
    // `users.email` is nullable. A row with no email cannot be confirmed as the
    // right grantee, and must not reach a caller that types `email` as a string.
    executeQueryMock.mockResolvedValue([
      { id: 1, name: "No Email", email: null },
      { id: 2, name: "Has Email", email: "has@psd401.net" },
    ])
    const result = await searchPeople("email")
    expect(result.people).toEqual([
      { id: 2, name: "Has Email", email: "has@psd401.net" },
    ])
    expect(result.truncated).toBe(false)
  })

  it("returns only id, name and email — never other user columns", async () => {
    executeQueryMock.mockResolvedValue([
      { id: 9, name: "Jane Doe", email: "doej@psd401.net" },
    ])
    const result = await searchPeople("doe")
    expect(Object.keys(result.people[0]).sort()).toEqual([
      "email",
      "id",
      "name",
    ])
  })
})
