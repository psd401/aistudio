import { withSharedDriveSupport } from "@/lib/agent-workspace/command-executor"

/**
 * Drive v3 hides shared-drive items from clients that do not declare support
 * for them, and hides them as 404 File not found rather than 403 — so a file
 * the caller genuinely has access to reads as if it does not exist.
 *
 * A user shared a supervision schedule with their agent account, confirmed it
 * twice, and `drive files get` returned `error[api]: File not found` on both
 * scopes. Re-sharing it as a native Google Doc produced the same 404. Nine
 * attempts, then the turn was abandoned (agent_failures 8289 + 8322, prod
 * broker logs 2026-08-14T19:52-20:00).
 */
describe("withSharedDriveSupport", () => {
  const params = (argv: string[]): Record<string, unknown> | null => {
    const index = argv.indexOf("--params")
    if (index === -1 || index === argv.length - 1) return null
    return JSON.parse(argv[index + 1]) as Record<string, unknown>
  }

  it("adds supportsAllDrives to the exact call that failed in production", () => {
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "get",
      "--params",
      JSON.stringify({ fileId: "1uTG1cDjFSzuvhoC7TBsvp9BNkC75VaIO" }),
    ])

    expect(params(out)).toEqual({
      fileId: "1uTG1cDjFSzuvhoC7TBsvp9BNkC75VaIO",
      supportsAllDrives: true,
    })
  })

  it("adds a --params flag when the command carried none", () => {
    const out = withSharedDriveSupport(["drive", "files", "get"])
    expect(params(out)).toEqual({ supportsAllDrives: true })
  })

  it("also sets includeItemsFromAllDrives on a listing", () => {
    // supportsAllDrives alone still omits shared-drive items from list
    // results; Drive requires both before it will return them.
    const out = withSharedDriveSupport(["drive", "files", "list"])
    expect(params(out)).toEqual({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  })

  it("does not set includeItemsFromAllDrives on a non-list call", () => {
    const out = withSharedDriveSupport(["drive", "files", "get"])
    expect(params(out)).not.toHaveProperty("includeItemsFromAllDrives")
  })

  it("preserves every other parameter and the surrounding argv", () => {
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "get",
      "--scope",
      "agent",
      "--params",
      JSON.stringify({ fileId: "F", fields: "id,name,mimeType" }),
    ])

    expect(out.slice(0, 5)).toEqual([
      "drive",
      "files",
      "get",
      "--scope",
      "agent",
    ])
    expect(params(out)).toEqual({
      fileId: "F",
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    })
  })

  it("leaves an explicit value from the model alone", () => {
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "get",
      "--params",
      JSON.stringify({ fileId: "F", supportsAllDrives: false }),
    ])
    expect(params(out)).toEqual({ fileId: "F", supportsAllDrives: false })
  })

  it("matches an explicit value case-insensitively rather than duplicating it", () => {
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "get",
      "--params",
      JSON.stringify({ fileId: "F", supportsalldrives: false }),
    ])
    expect(params(out)).toEqual({ fileId: "F", supportsalldrives: false })
  })

  it("leaves non-Drive services untouched", () => {
    // supportsAllDrives is a Drive v3 parameter; Sheets/Docs/Slides reject
    // unknown query parameters, so adding it there would break the call.
    for (const service of ["sheets", "docs", "gmail", "calendar", "slides"]) {
      const argv = [service, "spreadsheets", "get", "--params", "{}"]
      expect(withSharedDriveSupport(argv)).toEqual(argv)
    }
  })

  /**
   * #1801 — the transform used to merge its flags into `{}` whenever
   * --params did not parse, then write that object back over the caller's
   * value. A Drive `q` whose single quotes were eaten by the skill tokenizer
   * therefore reached gws as
   * `{"supportsAllDrives":true,"includeItemsFromAllDrives":true}`: an
   * unfiltered listing the agent read as search results. At least 8 users hit
   * it between 2026-08-19 and 2026-09-01 (agent_failures 10764, 11787).
   */
  it.each([
    // What `splitCommand` produces from the shell idiom `'\''`.
    String.raw`{"q":"name contains \Classified\"}`,
    String.raw`{"q":"\<folderId>\ in parents","pageSize":50}`,
    "not json at all",
    // Valid JSON, but not an object — gws takes an object here.
    '["q"]',
    '"q"',
  ])("never replaces an unparseable --params: %s", (value) => {
    const argv = ["drive", "files", "list", "--params", value]
    expect(withSharedDriveSupport(argv)).toEqual(argv)
  })

  it("does not append a second --params flag to an unparseable one", () => {
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "list",
      "--params",
      "{oops",
    ])
    expect(out.filter((token) => token === "--params")).toHaveLength(1)
  })

  it("keeps a q whose values are single-quoted, as Drive requires", () => {
    // The only transport that gets this shape through the skill is
    // --params-file; once here it must round-trip byte-identical.
    const q = "name contains 'Classified' and trashed = false"
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({ q, pageSize: 50 }),
    ])
    expect(params(out)).toEqual({
      q,
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  })

  it("keeps a folder-children query intact", () => {
    const q = "'1AbCfolderId' in parents and trashed = false"
    const out = withSharedDriveSupport([
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({ q }),
    ])
    expect((params(out) as { q: string }).q).toBe(q)
  })

  it("returns a copy rather than mutating the caller's argv", () => {
    const argv = ["drive", "files", "get"]
    const out = withSharedDriveSupport(argv)
    expect(argv).toEqual(["drive", "files", "get"])
    expect(out).not.toBe(argv)
  })
})
