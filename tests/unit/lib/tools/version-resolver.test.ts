import { describe, it, expect } from "@jest/globals"
import {
  parseToolRef,
  formatToolRef,
  isDeprecated,
  isPastRemovalDate,
  pickLatestNonDeprecated,
  resolveVersion,
  computeRemovalDate,
  type VersionedEntry,
} from "@/lib/tools/catalog/version-resolver"

// Small factory for building VersionedEntry fixtures.
function entry(
  identifier: string,
  version: string,
  opts: Partial<Pick<VersionedEntry, "deprecatedAt" | "removalDate" | "replacedBy">> = {}
): VersionedEntry {
  return { identifier, version, ...opts }
}

describe("parseToolRef", () => {
  it("parses an unpinned identifier", () => {
    expect(parseToolRef("documents.create")).toEqual({
      identifier: "documents.create",
      version: null,
    })
  })

  it("parses a pinned identifier@version", () => {
    expect(parseToolRef("documents.create@v2")).toEqual({
      identifier: "documents.create",
      version: "v2",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(parseToolRef("  nexus.chat@v1  ")).toEqual({
      identifier: "nexus.chat",
      version: "v1",
    })
  })

  it("rejects an empty / whitespace-only ref", () => {
    expect(parseToolRef("")).toBeNull()
    expect(parseToolRef("   ")).toBeNull()
  })

  it("rejects a malformed version (not a vN token)", () => {
    expect(parseToolRef("documents.create@2")).toBeNull()
    expect(parseToolRef("documents.create@v")).toBeNull()
    expect(parseToolRef("documents.create@latest")).toBeNull()
  })

  it("rejects v0, zero-padded, and dotted versions (strict vN grammar, epic #922 audit)", () => {
    // versionRank is /^v[1-9]\d*$/: versions start at v1, no leading zeros.
    expect(parseToolRef("x@v0")).toBeNull()
    expect(parseToolRef("x@v01")).toBeNull()
    expect(parseToolRef("x@v1.2")).toBeNull()
  })

  it("rejects a trailing/empty @ part", () => {
    expect(parseToolRef("documents.create@")).toBeNull()
    expect(parseToolRef("@v1")).toBeNull()
  })

  it("rejects multiple @ separators", () => {
    expect(parseToolRef("a@v1@v2")).toBeNull()
  })

  it("rejects a non-string input", () => {
    // @ts-expect-error — deliberately passing a non-string to assert the guard
    expect(parseToolRef(null)).toBeNull()
  })
})

describe("formatToolRef", () => {
  it("joins identifier and version with @", () => {
    expect(formatToolRef("documents.create", "v3")).toBe("documents.create@v3")
  })
})

describe("isDeprecated", () => {
  it("is false when deprecatedAt is null/undefined", () => {
    expect(isDeprecated(entry("a", "v1"))).toBe(false)
    expect(isDeprecated(entry("a", "v1", { deprecatedAt: null }))).toBe(false)
  })

  it("is true when deprecatedAt is set", () => {
    expect(isDeprecated(entry("a", "v1", { deprecatedAt: new Date() }))).toBe(true)
  })
})

describe("isPastRemovalDate", () => {
  const now = new Date("2026-06-18T00:00:00Z")

  it("is false for a non-deprecated entry", () => {
    expect(isPastRemovalDate(entry("a", "v1"), now)).toBe(false)
  })

  it("is false for a deprecated entry with no removalDate", () => {
    expect(
      isPastRemovalDate(entry("a", "v1", { deprecatedAt: new Date("2026-01-01") }), now)
    ).toBe(false)
  })

  it("is false before the removal date", () => {
    expect(
      isPastRemovalDate(
        entry("a", "v1", {
          deprecatedAt: new Date("2026-06-01"),
          removalDate: new Date("2026-09-01"),
        }),
        now
      )
    ).toBe(false)
  })

  it("is true on/after the removal date", () => {
    expect(
      isPastRemovalDate(
        entry("a", "v1", {
          deprecatedAt: new Date("2026-01-01"),
          removalDate: new Date("2026-04-01"),
        }),
        now
      )
    ).toBe(true)
  })
})

describe("pickLatestNonDeprecated", () => {
  it("returns undefined for an empty list", () => {
    expect(pickLatestNonDeprecated([])).toBeUndefined()
  })

  it("picks the highest non-deprecated version", () => {
    const result = pickLatestNonDeprecated([
      entry("a", "v1"),
      entry("a", "v3", { deprecatedAt: new Date() }),
      entry("a", "v2"),
    ])
    expect(result?.version).toBe("v2")
  })

  it("falls back to the latest deprecated version when all are deprecated", () => {
    const result = pickLatestNonDeprecated([
      entry("a", "v1", { deprecatedAt: new Date() }),
      entry("a", "v2", { deprecatedAt: new Date() }),
    ])
    expect(result?.version).toBe("v2")
  })
})

describe("resolveVersion", () => {
  const candidates = [
    entry("documents.create", "v1", { deprecatedAt: new Date() }),
    entry("documents.create", "v2"),
  ]

  it("returns unknown_identifier when there are no candidates", () => {
    const r = resolveVersion({ identifier: "x", version: null }, [])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe("unknown_identifier")
  })

  it("resolves unpinned to the latest non-deprecated version", () => {
    const r = resolveVersion({ identifier: "documents.create", version: null }, candidates)
    expect(r.ok).toBe(true)
    expect(r.ok && r.entry.version).toBe("v2")
    expect(r.ok && r.deprecated).toBe(false)
  })

  it("resolves a pinned existing version exactly", () => {
    const r = resolveVersion({ identifier: "documents.create", version: "v1" }, candidates)
    expect(r.ok).toBe(true)
    expect(r.ok && r.entry.version).toBe("v1")
    // v1 is deprecated in this fixture; the flag must reflect that.
    expect(r.ok && r.deprecated).toBe(true)
  })

  it("returns unknown_version for a removed/never-existed pin", () => {
    const r = resolveVersion({ identifier: "documents.create", version: "v9" }, candidates)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe("unknown_version")
  })
})

describe("computeRemovalDate", () => {
  it("adds gracePeriodDays to deprecatedAt", () => {
    const deprecatedAt = new Date("2026-06-18T00:00:00Z")
    const removal = computeRemovalDate(deprecatedAt, 90)
    // 90 days later.
    expect(removal.toISOString()).toBe("2026-09-16T00:00:00.000Z")
  })

  it("supports a custom grace period", () => {
    const deprecatedAt = new Date("2026-01-01T00:00:00Z")
    expect(computeRemovalDate(deprecatedAt, 30).toISOString()).toBe(
      "2026-01-31T00:00:00.000Z"
    )
  })
})
