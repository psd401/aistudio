/**
 * Directory identity resolution (#1239) — server-side.
 *
 * This logic moved out of the agent container after #1353: the model runtime
 * must never hold a Google token, so the People API calls happen here and the
 * container receives only a shaped person record.
 *
 * These tests pin the properties that would produce a WRONG identity silently
 * rather than a visible failure — which is the whole risk of this feature,
 * since the agent uses these answers to decide who it is talking about. Every
 * defect found in review on PR #1351 was of that shape.
 */

import {
  DirectoryError,
  __clearDirectoryCache,
  addressesOf,
  classifyError,
  normalizeEmail,
  normalizePersonId,
  resolveEmail,
  resolvePersonId,
  shapePerson,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  type FetchLike,
} from "@/lib/agent-workspace/directory-lookup"

const OWNER = "agnt_hagelk@psd401.net"

beforeEach(() => {
  __clearDirectoryCache()
})

interface StubResponse {
  status?: number
  body?: unknown
  unparseable?: boolean
}

function stubFetch(responder: (url: string) => StubResponse) {
  const calls: string[] = []
  const impl: FetchLike = async (url) => {
    calls.push(url)
    const { status = 200, body = {}, unparseable = false } = responder(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (unparseable) throw new SyntaxError("Unexpected token < in JSON")
        return body
      },
    }
  }
  return Object.assign(impl, { calls })
}

const person = (
  id: string,
  name: string | null,
  email: string | null,
  org?: Record<string, string>,
) => ({
  resourceName: `people/${id}`,
  names: name ? [{ metadata: { primary: true }, displayName: name }] : [],
  emailAddresses: email ? [{ metadata: { primary: true }, value: email }] : [],
  organizations: org ? [{ metadata: { primary: true }, ...org }] : [],
})

describe("normalizePersonId", () => {
  it("accepts users/, people/ and bare numeric forms", () => {
    expect(normalizePersonId("users/12345")).toBe("12345")
    expect(normalizePersonId("people/12345")).toBe("12345")
    expect(normalizePersonId("  users/12345  ")).toBe("12345")
  })

  it("rejects anything that is not a bare id", () => {
    // The id is interpolated into the request path, so this is the
    // input-validation boundary, not a cosmetic check.
    expect(normalizePersonId("users/../../etc/passwd")).toBeNull()
    expect(normalizePersonId("me")).toBeNull()
    expect(normalizePersonId(null)).toBeNull()
  })
})

describe("resolveEmail", () => {
  it("returns the person, with title and department, on an exact match", async () => {
    const fetchImpl = stubFetch(() => ({
      body: {
        people: [
          person("116", "Kris Hagel", "hagelk@psd401.net", {
            title: "Chief",
            department: "Multiple Locations",
            name: "Peninsula School District",
          }),
        ],
      },
    }))
    const r = await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(true)
    if (!r.found) throw new Error("unreachable")
    expect(r.displayName).toBe("Kris Hagel")
    expect(r.title).toBe("Chief")
    expect(r.department).toBe("Multiple Locations")
  })

  it("does NOT report a near-miss search result as the person", async () => {
    // searchDirectoryPeople is a prefix/substring search, so one query can
    // return several people. Taking [0] would make the agent confidently
    // attribute a message to the WRONG human — worse than resolving nobody.
    const fetchImpl = stubFetch(() => ({
      body: {
        people: [
          person("1", "Kristen Hagelin", "hagelink@psd401.net"),
          person("2", "Kris Hagelund", "hagelund@psd401.net"),
        ],
      },
    }))
    const r = await resolveEmail("hagel@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(false)
    if (r.found) throw new Error("unreachable")
    expect(r.reason).toBe("no exact address match")
  })

  it("resolves an ALIAS address to the person and flags it", async () => {
    // A profile can carry aliases (a firstname.lastname form, or a
    // pre-name-change address), and those are exactly what a human hands the
    // agent. Matching only the primary would report found:false for someone
    // Google already returned correctly.
    const rec = person("116", "Kris Hagel", "hagelk@psd401.net")
    rec.emailAddresses.push({
      metadata: { primary: false },
      value: "kris.hagel@psd401.net",
    })
    const fetchImpl = stubFetch(() => ({ body: { people: [rec] } }))
    const r = await resolveEmail("kris.hagel@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(true)
    if (!r.found) throw new Error("unreachable")
    expect(r.email).toBe("hagelk@psd401.net")
    expect(r.matchedAlias).toBe("kris.hagel@psd401.net")
  })

  it("keeps the exact-match rule when widening to aliases", async () => {
    const other = person("2", "Someone Else", "else@psd401.net")
    other.emailAddresses.push({ metadata: { primary: false }, value: "se@psd401.net" })
    const fetchImpl = stubFetch(() => ({ body: { people: [other] } }))
    const r = await resolveEmail("hagel@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(false)
  })

  it("requests only the DOMAIN_PROFILE source", async () => {
    const fetchImpl = stubFetch(() => ({ body: { people: [] } }))
    await resolveEmail("x@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(fetchImpl.calls[0]).toContain("sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE")
    expect(fetchImpl.calls[0]).toContain("/people:searchDirectoryPeople")
  })

  it("rejects input that cannot be an address", async () => {
    await expect(resolveEmail("not-an-address", "tok")).rejects.toThrow(/valid email/i)
  })
})

describe("resolvePersonId", () => {
  it("resolves a Chat users/{id} via people.get", async () => {
    const fetchImpl = stubFetch(() => ({
      body: person("116264913639920976203", "Kris Hagel", "hagelk@psd401.net"),
    }))
    const r = await resolvePersonId("users/116264913639920976203", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(true)
    expect(fetchImpl.calls[0]).toContain("/people/116264913639920976203")
  })

  it("treats an empty-field response as a MISS, not a nameless person", async () => {
    // This is the exact failure mode #1239 feared for the service-account
    // context, and the trigger for the Option B admin-role escalation. If it
    // ever starts happening it must be visible.
    const fetchImpl = stubFetch(() => ({ body: { resourceName: "people/999" } }))
    const r = await resolvePersonId("users/999", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(false)
    if (r.found) throw new Error("unreachable")
    expect(r.reason).toBe("directory returned no usable fields")
  })

  it("treats a 404 as a miss rather than an error", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 404,
      body: { error: { message: "Requested entity was not found." } },
    }))
    const r = await resolvePersonId("users/404", "tok", { fetchImpl, ownerKey: OWNER })
    expect(r.found).toBe(false)
  })
})

describe("error classification", () => {
  it("distinguishes the admin-console 403 from a scope 403", () => {
    // These demand completely different remedies — an admin action versus a
    // token fix. Collapsing them is what made #1239 expensive to diagnose.
    expect(
      classifyError(403, {
        error: { message: "The G Suite domain admin has disabled external directory sharing." },
      }).code,
    ).toBe("DIRECTORY_SHARING_DISABLED")
    expect(
      classifyError(403, { error: { message: "Request had insufficient authentication scopes." } })
        .code,
    ).toBe("INSUFFICIENT_SCOPE")
  })

  it("classifies 5xx as TRANSPORT so callers retry", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyError(status, {}).code).toBe("TRANSPORT")
    }
  })

  it("classifies a 502 on STATUS even when the body is HTML", async () => {
    // A load-balancer 502 carries HTML, so the parsed message is empty and the
    // status is the only signal. Classifying on the body would make infra
    // errors indistinguishable from app errors.
    const fetchImpl = stubFetch(() => ({ status: 502, unparseable: true }))
    await expect(resolveEmail("x@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })).rejects.toMatchObject({
      code: "TRANSPORT",
    })
  })

  it("fails a 2xx with an unparseable body instead of returning a false miss", async () => {
    // Degrading to {} would shape into found:false — reporting "not in the
    // directory" for a person who is in it, and caching that miss.
    const fetchImpl = stubFetch(() => ({ status: 200, unparseable: true }))
    await expect(resolveEmail("x@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })).rejects.toMatchObject({
      code: "LOOKUP_FAILED",
    })
  })

  it("raises DirectoryError instances so the route can map them", async () => {
    const fetchImpl = stubFetch(() => ({ status: 503, body: {} }))
    await expect(resolveEmail("x@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })).rejects.toBeInstanceOf(
      DirectoryError,
    )
  })
})

describe("caching", () => {
  it("serves a repeat lookup without calling the API", async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    const second = await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    expect(second.cached).toBe(true)
    expect(fetchImpl.calls.length).toBe(1)
  })

  it("honours noCache", async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl, ownerKey: OWNER })
    await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl, noCache: true })
    expect(fetchImpl.calls.length).toBe(2)
  })

  it("expires misses far sooner than hits", async () => {
    // A miss is usually a race with account provisioning; caching it for the
    // positive TTL would make a new hire look permanently unresolvable.
    expect(NEGATIVE_TTL_MS).toBeLessThan(POSITIVE_TTL_MS)
    const fetchImpl = stubFetch(() => ({ body: { people: [] } }))
    const t0 = 2_000_000
    await resolveEmail("ghost@psd401.net", "tok", { fetchImpl, ownerKey: OWNER, now: t0 })
    await resolveEmail("ghost@psd401.net", "tok", {
      fetchImpl,
      ownerKey: OWNER,
      now: t0 + NEGATIVE_TTL_MS + 1,
    })
    expect(fetchImpl.calls.length).toBe(2)
  })

  it("a cache HIT costs no token mint (codex round 2)", async () => {
    // Minting runs WIF -> signJwt -> token exchange through the mint Lambda.
    // Minting BEFORE the cache is consulted means a fully-cached lookup still
    // pays that cost, and fails outright when the mint boundary is down
    // despite a valid cached answer being in hand.
    //
    // This exact bug was fixed once in the container implementation and then
    // reintroduced when the lookup moved server-side — hence the test.
    let mints = 0
    const mintToken = async () => {
      mints += 1
      return "tok"
    }
    const fetchImpl = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))

    await resolveEmail("hagelk@psd401.net", mintToken, { fetchImpl, ownerKey: OWNER })
    expect(mints).toBe(1)

    await resolveEmail("hagelk@psd401.net", mintToken, { fetchImpl, ownerKey: OWNER })
    await resolveEmail("hagelk@psd401.net", mintToken, { fetchImpl, ownerKey: OWNER })
    expect(mints).toBe(1)
    expect(fetchImpl.calls.length).toBe(1)
  })

  it("a cached id lookup mints nothing either", async () => {
    let mints = 0
    const mintToken = async () => {
      mints += 1
      return "tok"
    }
    const fetchImpl = stubFetch(() => ({
      body: person("999", "Someone", "someone@psd401.net"),
    }))
    await resolvePersonId("users/999", mintToken, { fetchImpl, ownerKey: OWNER })
    await resolvePersonId("users/999", mintToken, { fetchImpl, ownerKey: OWNER })
    expect(mints).toBe(1)
  })

  it("a mint failure never happens for a cached answer", async () => {
    // The operational point of laziness: an outage in the mint boundary must
    // not take down lookups the cache can already answer.
    const fetchImpl = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    await resolveEmail("hagelk@psd401.net", async () => "tok", {
      fetchImpl,
      ownerKey: OWNER,
    })
    const brokenMint = async () => {
      throw new Error("mint lambda unavailable")
    }
    const cached = await resolveEmail("hagelk@psd401.net", brokenMint, {
      fetchImpl,
      ownerKey: OWNER,
    })
    expect(cached.found).toBe(true)
    expect(cached.cached).toBe(true)
  })

  it("NEVER serves one owner's cached result to another (codex P1)", async () => {
    // The cache is process-global — one Next.js instance serves every agent —
    // so an unpartitioned key would let owner B receive owner A's authorized
    // result without B's token ever being used. Directory visibility is
    // per-account and this directory contains STUDENT records, so that is a
    // cross-account disclosure, not a staleness bug.
    //
    // It is also a regression created by moving the cache server-side: the
    // previous per-container cache was partitioned by construction.
    const fetchA = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    const fetchB = stubFetch(() => ({ body: { people: [] } }))

    const a = await resolveEmail("hagelk@psd401.net", "tok-a", {
      fetchImpl: fetchA,
      ownerKey: "agnt_owner-a@psd401.net",
    })
    expect(a.found).toBe(true)

    // Owner B has no visibility of that person. B must get their OWN answer,
    // which means B's token has to be used — not A's cached hit.
    const b = await resolveEmail("hagelk@psd401.net", "tok-b", {
      fetchImpl: fetchB,
      ownerKey: "agnt_owner-b@psd401.net",
    })
    expect(b.found).toBe(false)
    expect(b.cached).toBeUndefined()
    expect(fetchB.calls.length).toBe(1)
  })

  it("partitions the id cache by owner too", async () => {
    const fetchA = stubFetch(() => ({
      body: person("999", "Someone", "someone@psd401.net"),
    }))
    const fetchB = stubFetch(() => ({ body: { resourceName: "people/999" } }))
    const a = await resolvePersonId("users/999", "tok-a", {
      fetchImpl: fetchA,
      ownerKey: "agnt_owner-a@psd401.net",
    })
    expect(a.found).toBe(true)
    const b = await resolvePersonId("users/999", "tok-b", {
      fetchImpl: fetchB,
      ownerKey: "agnt_owner-b@psd401.net",
    })
    expect(b.found).toBe(false)
    expect(fetchB.calls.length).toBe(1)
  })

  it("skips caching entirely when there is no owner to partition by", async () => {
    // Fails closed: no shared fallback bucket.
    const fetchImpl = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl })
    const second = await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl })
    expect(second.cached).toBeUndefined()
    expect(fetchImpl.calls.length).toBe(2)
  })

  it("does not collide email and id lookups", async () => {
    const fetchEmail = stubFetch(() => ({
      body: { people: [person("116", "Kris Hagel", "hagelk@psd401.net")] },
    }))
    const fetchId = stubFetch(() => ({ body: person("999", "Someone Else", "else@psd401.net") }))
    await resolveEmail("hagelk@psd401.net", "tok", { fetchImpl: fetchEmail, ownerKey: OWNER })
    const byId = await resolvePersonId("users/999", "tok", { fetchImpl: fetchId, ownerKey: OWNER })
    expect(byId.found).toBe(true)
    if (!byId.found) throw new Error("unreachable")
    expect(byId.displayName).toBe("Someone Else")
  })
})

describe("no enumeration surface", () => {
  it("exposes no directory-listing entry point", async () => {
    // The district directory contains ClassLink-provisioned STUDENT records.
    // A list/enumerate helper reachable from the agent would be a
    // student-directory dumper one prompt away, so its absence is a
    // deliberate safety property, asserted rather than left to memory.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const src = fs
      .readFileSync(
        path.join(process.cwd(), "lib/agent-workspace/directory-lookup.ts"),
        "utf8",
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
    expect(src).not.toContain("listDirectoryPeople")
  })
})

describe("shapePerson", () => {
  it("returns null when there is no usable identity", () => {
    expect(shapePerson({ resourceName: "people/1" })).toBeNull()
    expect(shapePerson(null)).toBeNull()
  })

  it("collects every address, primary and alias", () => {
    const rec = person("1", "A", "a@psd401.net")
    rec.emailAddresses.push({ metadata: { primary: false }, value: "B@psd401.net" })
    expect(addressesOf(rec)).toEqual(["a@psd401.net", "b@psd401.net"])
  })
})

describe("normalizeEmail", () => {
  it("lowercases and trims a real address", () => {
    expect(normalizeEmail("  HagelK@PSD401.net ")).toBe("hagelk@psd401.net")
    expect(normalizeEmail("a.b@sub.psd401.net")).toBe("a.b@sub.psd401.net")
  })

  it("rejects anything that cannot be an address", () => {
    for (const bad of [
      "nope",
      "",
      "@psd401.net",
      "a@",
      "a@psd401",
      "a@.net",
      "a@psd401.",
      "a@psd401.net.",
      "a@b.c.",
      "a@b@psd401.net",
      "a b@psd401.net",
      "a@psd 401.net",
      null,
      42,
    ]) {
      expect(normalizeEmail(bad)).toBeNull()
    }
  })

  it("handles CodeQL's ReDoS witness string without misparsing it", () => {
    // Not a timing assertion: the regex this replaced evaluates the same
    // witness in under 0.1 ms in V8, so a timing test would pass either way
    // and prove nothing. What is worth pinning is that the linear parse still
    // REJECTS this input rather than accidentally accepting it — the domain
    // ends in "." and so is not a valid address.
    expect(normalizeEmail(`!@!.${"!.".repeat(20_000)}`)).toBeNull()
  })
})
