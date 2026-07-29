/** @jest-environment node */


import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"

import { executeWorkspaceCommand } from "@/lib/agent-workspace/command-executor"
import { validatedFs, validatedFsPromises } from "@/lib/filesystem/validated-fs";

let fixtureDirectory = ""
let executable = ""
const originalExecutable = process.env.GWS_EXECUTABLE

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "workspace-cli-fixture-"))
  executable = join(fixtureDirectory, "gws")
  process.env.GWS_EXECUTABLE = executable
})

afterEach(async () => {
  if (originalExecutable === undefined) {
    delete process.env.GWS_EXECUTABLE
  } else {
    process.env.GWS_EXECUTABLE = originalExecutable
  }
  await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("trusted Workspace command runtime", () => {
  it("contains implicit binary downloads in a private disposable directory", async () => {
    await validatedFsPromises.writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs")',
        'fs.writeFileSync("download.bin", "drive-controlled bytes")',
        "process.stdout.write(JSON.stringify({",
        "  cwd: process.cwd(),",
        "  home: process.env.HOME,",
        "}))",
      ].join("\n"),
      { mode: 0o700 },
    )

    const result = await executeWorkspaceCommand(
      {
        scope: "user",
        argv: [
          "drive",
          "files",
          "export",
          "--params",
          '{"fileId":"file-1","mimeType":"text/plain"}',
        ],
      },
      "owner-bound-access-token",
    )
    const execution = JSON.parse(result.stdout) as {
      cwd: string
      home: string
    }

    expect(isAbsolute(execution.cwd)).toBe(true)
    expect(basename(execution.cwd)).toMatch(/^aistudio-workspace-cli-/)
    expect(isAbsolute(execution.home)).toBe(true)
    expect(basename(execution.home)).toBe(basename(execution.cwd))
    expect(validatedFs.existsSync(execution.cwd)).toBe(false)
  })

  it("removes the disposable directory after a CLI failure", async () => {
    await validatedFsPromises.writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs")',
        'fs.writeFileSync("execution-directory", process.cwd())',
        'process.stderr.write(`denied:${process.cwd()}`)',
        "process.exit(1)",
      ].join("\n"),
      { mode: 0o700 },
    )

    let message = ""
    try {
      await executeWorkspaceCommand(
        {
          scope: "user",
          argv: ["drive", "files", "get", "--params", '{"fileId":"file-1"}'],
        },
        "owner-bound-access-token",
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/^Workspace CLI failed: denied:/)
    const executionDirectory = message.slice(message.indexOf("denied:") + 7)
    expect(isAbsolute(executionDirectory)).toBe(true)
    expect(basename(executionDirectory)).toMatch(/^aistudio-workspace-cli-/)
    expect(validatedFs.existsSync(executionDirectory)).toBe(false)
  })
})
