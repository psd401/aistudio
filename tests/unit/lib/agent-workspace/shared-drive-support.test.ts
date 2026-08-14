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

  it("returns a copy rather than mutating the caller's argv", () => {
    const argv = ["drive", "files", "get"]
    const out = withSharedDriveSupport(argv)
    expect(argv).toEqual(["drive", "files", "get"])
    expect(out).not.toBe(argv)
  })
})
