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
    expect(result.media).toEqual(
      expect.objectContaining({
        workspacePath: "downloads/download.pdf",
        downloadUrl: "https://s3.example/presigned",
        contentType: "application/pdf",
      })
    )
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
