/**
 * The Freshservice broker's (method, path) allowlist.
 *
 * psd-freshservice used to read the owner's API key in plaintext and call
 * Freshservice from inside the model runtime. #1353 removed plaintext
 * credential access and deleted psd-credentials/get.js, but this skill was
 * never migrated — every command has been dead since, and the failure blamed
 * the user's credentials rather than the broken skill.
 *
 * The key now stays server-side. That makes the path allowlist THE security
 * boundary: the model composes the path, so without it this broker would sign
 * arbitrary Freshservice requests with the owner's key — including admin
 * endpoints the skill never uses. These tests pin exactly what is reachable.
 */

import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../../../helpers/strip-ts-comments"

const getUserOnly = jest.fn()
const fetchMock = jest.fn()

jest.mock("@/lib/agent-credentials/broker", () => ({
  AgentCredentialBroker: jest.fn().mockImplementation(() => ({ getUserOnly })),
}))

import { executeFreshserviceOperation } from "@/lib/agent-credentials/owner-operation-broker"

const OWNER = { ownerEmail: "hagelk@psd401.net", sessionId: "sess-1" }

/**
 * Build a Response with headers that are actually readable.
 *
 * This environment's Response constructor silently DROPS a `headers` init —
 * both a plain object and a `Headers` instance read back as undefined — while
 * `headers.set()` after construction works. Passing them via init would make
 * every header-dependent assertion here test the polyfill instead of the
 * broker, and the rate-limit and content-type paths would look broken when
 * they are not.
 */
function mkResponse(
  status: number,
  body = "",
  headers: Record<string, string> = {}
): Response {
  const response = new Response(body, { status })
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value)
  }
  return response
}

const jsonResponse = (status: number, payload: unknown) =>
  mkResponse(status, JSON.stringify(payload), {
    "content-type": "application/json",
  })

beforeEach(() => {
  getUserOnly.mockReset().mockResolvedValue({
    name: "freshservice_api_key",
    value: "fs-key",
    scope: "user",
  })
  fetchMock.mockReset().mockResolvedValue(jsonResponse(200, { tickets: [] }))
  global.fetch = fetchMock as unknown as typeof fetch
})

const call = (path: string, method?: string, body?: unknown) =>
  executeFreshserviceOperation({ ...OWNER, path, method, body })

describe("Freshservice broker allowlist", () => {
  it.each([
    ["GET", "/tickets"],
    ["GET", "/tickets?per_page=30&page=1"],
    ["POST", "/tickets"],
    ["GET", "/tickets/12345"],
    ["GET", "/tickets/12345?include=conversations,requester"],
    ["PUT", "/tickets/12345"],
    ["POST", "/tickets/12345/notes"],
    ["GET", "/tickets/12345/requested_items"],
    ["GET", "/agents?email=someone%40psd401.net"],
    ["GET", "/agents/99"],
    ["GET", "/requesters/77"],
    ["GET", "/workspaces"],
    ["GET", "/workspaces/2"],
    ["GET", "/approvals?approver_id=5&status=pending&parent=true"],
  ])("allows %s %s (used by the skill)", async (method, path) => {
    await expect(call(path, method)).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    // Endpoints the skill does not use — the owner's key must not reach them.
    ["GET", "/agents/99/permissions"],
    ["DELETE", "/tickets/12345"],
    ["POST", "/agents"],
    ["GET", "/solutions/articles"],
    ["GET", "/products"],
    // Method/path mismatches: read routes must not become write routes.
    ["PUT", "/tickets"],
    ["POST", "/workspaces"],
    ["PUT", "/agents/99"],
    // Traversal and smuggling.
    ["GET", "/tickets/../admin"],
    ["GET", "/tickets/12345/../../admin"],
    ["GET", "/tickets?x=1/../../admin"],
    ["GET", "/tickets/abc"],
    // Absolute URLs must not escape the fixed host.
    ["GET", "//evil.example/tickets"],
  ])("rejects %s %s", async (method, path) => {
    await expect(call(path, method)).rejects.toThrow(/not allowed|Invalid/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a non-relative path outright", async () => {
    await expect(call("https://evil.example/tickets", "GET")).rejects.toThrow(
      "Invalid Freshservice path"
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects control characters in the path", async () => {
    await expect(call("/tickets\n/admin", "GET")).rejects.toThrow(
      "Invalid Freshservice path"
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Freshservice broker behaviour", () => {
  it("never returns the API key to the caller", async () => {
    const result = await call("/tickets")
    expect(JSON.stringify(result)).not.toContain("fs-key")
  })

  it("sends the key as a server-side Basic auth header", async () => {
    await call("/tickets")
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("fs-key:X").toString("base64")}`
    )
  })

  it("reports a missing credential distinctly, without calling Freshservice", async () => {
    // A user who never registered a key is in a NORMAL state — the skill turns
    // this into the "paste your key" prompt. Throwing here would surface it as
    // a broken skill, which is the exact confusion this rewrite removes.
    getUserOnly.mockResolvedValue(null)

    await expect(call("/tickets")).resolves.toEqual({
      status: 0,
      ok: false,
      code: "credential_missing",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("surfaces rate limiting as its own code with retry-after", async () => {
    fetchMock.mockResolvedValue(mkResponse(429, "", { "retry-after": "30" }))

    await expect(call("/tickets")).resolves.toEqual({
      status: 429,
      ok: false,
      code: "rate_limited",
      retryAfter: "30",
    })
  })

  it("returns upstream failures instead of throwing", async () => {
    // The skill maps 404 to "no such ticket"; collapsing statuses into a
    // generic throw is what made the old client's errors unreadable.
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "not found" }))

    const result = (await call("/tickets/1")) as { status: number; ok: boolean }
    expect(result.status).toBe(404)
    expect(result.ok).toBe(false)
  })

  it("tolerates an empty body on a successful update", async () => {
    fetchMock.mockResolvedValue(mkResponse(204))

    const result = (await call("/tickets/1", "PUT", { status: 5 })) as {
      ok: boolean
      data: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.data).toBeNull()
  })

  it("fetches a REBUILT path, not the caller's string", async () => {
    // The allowlist reconstructs the path from literals + Number(), so no
    // caller-supplied character reaches the URL. A padded id proves it: the
    // request that goes out is the canonical form, not what was passed in.
    await call("/tickets/000123")

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://psd401.freshservice.com/api/v2/tickets/123"
    )
  })

  it("re-serializes the query from an allowlisted key set", async () => {
    await call("/tickets?per_page=30&page=2")

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://psd401.freshservice.com/api/v2/tickets?per_page=30&page=2"
    )
  })

  it.each([
    // Unknown keys cannot ride along into the upstream request.
    "/tickets?evil=1",
    // A "/" in a value could otherwise smuggle a path segment.
    "/tickets?include=a/b",
    // Malformed pairs are rejected rather than silently dropped.
    "/tickets?noequals",
  ])("rejects query %s", async (path) => {
    await expect(call(path)).rejects.toThrow("not allowed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("permits @ in a query value, which the agent lookup needs", async () => {
    // "@" is required by /agents?email=... and is safe here: it appears after
    // "?", so no URL parser can read it as authority userinfo. The host is
    // already fixed by the time the query is appended.
    await call("/agents?email=someone@psd401.net")

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://psd401.freshservice.com/api/v2/agents?email=someone%40psd401.net"
    )
  })

  it("is not gated behind a capability that cannot be granted", async () => {
    // REGRESSION PIN. The route case briefly checked `skill.freshservice`,
    // copied from a case that gated a SHARED district credential. That
    // identifier existed nowhere else, so no role could hold it and every call
    // 403'd forever — and the message ("access is not granted for this
    // account") pointed debugging at account provisioning rather than at the
    // gate that had just been invented.
    //
    // Shared-credential cases are not a precedent: gating who may borrow the
    // district's account is meaningful. Freshservice uses the caller's OWN
    // per-user key, so the credential is already the authorization.
    // Comment-stripped: the prose above the case explains WHY the gate was
    // removed and names the identifier, so a raw substring check would fail on
    // correct source.
    const routeSource = stripComments(
      fs.readFileSync(
        path.join(process.cwd(), "app/api/agent/credentials/route.ts"),
        "utf8",
      ),
    )
    const freshserviceCase = routeSource.slice(
      routeSource.indexOf('case "freshservice"'),
      routeSource.indexOf('case "put"'),
    )

    // Guard the slice, so the assertions below cannot pass on an empty string.
    expect(freshserviceCase).toContain("executeFreshserviceOperation")
    expect(freshserviceCase).not.toContain("canAccessSkill")
    expect(routeSource).not.toContain("skill.freshservice")

    // Shared-credential cases KEEP their gate; openai-image is the live one.
    expect(routeSource).toContain("skill.image-gen")

    // psd-redrover was removed in #1396 — Red Rover data is served through
    // psd-data now, so neither the case nor its capability may come back.
    expect(routeSource).not.toContain("skill.redrover")
    expect(routeSource).not.toContain('case "redrover"')
  })

  it("refuses to follow redirects", async () => {
    // A redirect would replay the owner's Authorization header to whatever
    // host Freshservice pointed at.
    await call("/tickets")
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error")
  })
})
