/* eslint-disable security/detect-non-literal-fs-filename --
 * Paths here are all test-created temp dirs by construction.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const putWorkspaceObject = jest.fn()
const createWorkspaceDownloadUrl = jest.fn()

jest.mock("@/lib/agent-workspace/storage-broker", () => ({
  putWorkspaceObject: (...a: unknown[]) => putWorkspaceObject(...a),
  createWorkspaceDownloadUrl: (...a: unknown[]) => createWorkspaceDownloadUrl(...a),
}))

const { executeWorkspaceCommand } = require("@/lib/agent-workspace/command-executor")

/**
 * A stub "gws" that writes download.pdf into its cwd, exactly as the pinned
 * binary does for a binary response, then prints JSON on stdout.
 */
function stubGws(dir: string, body: string): string {
  const script = path.join(dir, "fake-gws.sh")
  // The executor hands the child a scrubbed env (HOME/LANG/NODE_ENV/PATH only),
  // so the payload has to be baked into the script rather than passed through.
  fs.writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s' '${body}' > download.pdf\necho '{"saved_file":"download.pdf"}'\n`,
    { mode: 0o755 }
  )
  return script
}

describe("downloaded media hand-off", () => {
  let dir: string

  beforeEach(() => {
    jest.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"))
    process.env.GWS_EXECUTABLE = stubGws(dir, "%PDF-1.7 fake")
    putWorkspaceObject.mockResolvedValue({ key: "k", bytes: 13 })
    createWorkspaceDownloadUrl.mockResolvedValue({
      downloadUrl: "https://s3.example/presigned",
      contentLength: 13,
      requiredHeaders: { Range: "bytes=0-12" },
    })
  })

  afterEach(() => {
    delete process.env.GWS_EXECUTABLE
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cmd = { scope: "user" as const, argv: ["drive", "files", "get", "--params", "{}"] }

  it("saves the download into the caller's PRIVATE workspace, not public-images", async () => {
    const result = await executeWorkspaceCommand(cmd, "tok", "a@psd401.net", "ws/a@psd401.net")
    expect(putWorkspaceObject).toHaveBeenCalledTimes(1)
    const args = putWorkspaceObject.mock.calls[0][0] as {
      signedWorkspacePrefix: string
      relativePath: string
    }
    expect(args.signedWorkspacePrefix).toBe("ws/a@psd401.net")
    expect(args.relativePath).not.toContain("public-images")
    expect(args.relativePath).toBe("downloads/download.pdf")
    // Exact, not objectContaining: an earlier version of this test used
    // objectContaining and therefore never noticed that requiredHeaders was
    // being dropped, which would have made every documented fetch fail on an
    // S3 signature/range mismatch.
    expect(result.media).toEqual({
      workspacePath: "downloads/download.pdf",
      downloadUrl: "https://s3.example/presigned",
      requiredHeaders: { Range: "bytes=0-12" },
      bytes: 13,
      contentType: "application/pdf",
    })
  })

  it("carries the Range header the presigned URL was signed with", async () => {
    // createWorkspaceDownloadUrl signs a bounded GET; workspace_sync.py
    // re-attaches this same header and treats a mismatch as invalid. Without
    // it on the handoff there is nothing for a caller to re-attach.
    createWorkspaceDownloadUrl.mockResolvedValue({
      downloadUrl: "https://s3.example/presigned",
      contentLength: 13,
      requiredHeaders: { Range: "bytes=0-12" },
    })
    const result = await executeWorkspaceCommand(cmd, "tok", "a@psd401.net", "ws/a@psd401.net")
    expect(result.media?.requiredHeaders).toEqual({ Range: "bytes=0-12" })
  })

  it("does nothing when no workspace prefix is supplied", async () => {
    const result = await executeWorkspaceCommand(cmd, "tok", "a@psd401.net")
    expect(putWorkspaceObject).not.toHaveBeenCalled()
    expect(result.media).toBeUndefined()
  })

  it("keeps the command successful when the hand-off fails", async () => {
    putWorkspaceObject.mockRejectedValue(new Error("S3 exploded"))
    const result = await executeWorkspaceCommand(cmd, "tok", "a@psd401.net", "ws/a@psd401.net")
    expect(result.stdout).toContain("saved_file")
    expect(result.media).toBeUndefined()
    expect(result.mediaError).toContain("S3 exploded")
  })

  it("skips the hand-off when the download is empty", async () => {
    // gws writes download.<ext> even for a JSON-only response, so a zero-byte
    // file must not be published as if it were the user's document.
    process.env.GWS_EXECUTABLE = stubGws(dir, "")
    const result = await executeWorkspaceCommand(cmd, "tok", "a@psd401.net", "ws/a@psd401.net")
    expect(putWorkspaceObject).not.toHaveBeenCalled()
    expect(result.media).toBeUndefined()
  })
})

describe("run.js forwards the hand-off to the agent", () => {
  // The broker returning `media` is useless if the CLI the agent actually
  // invokes never prints it. run.js wrote only stdout/stderr, so the whole
  // path was unreachable through the documented invocation and the unit tests
  // above — which call the executor directly — could not see that.
  const runJs = fs.readFileSync(
    path.join(process.cwd(), "infra/agent-image/skills/psd-workspace/run.js"),
    "utf8"
  )

  it("prints media and mediaError, not just stdout/stderr", () => {
    expect(runJs).toContain("result.media")
    expect(runJs).toContain("result.mediaError")
  })
})
