/* eslint-disable security/detect-non-literal-fs-filename --
 * This suite exists to exercise path validation, so every fs call takes a
 * computed path by design. The paths are all test-created temp dirs.
 */
import fs from "node:fs"
import path from "node:path"

/**
 * Path-validation boundary for the image-staged validated-fs used by every
 * skill. The OPENCLAW_HOME root was added because the same command succeeded
 * or failed purely on where the process happened to start (two users lost
 * their morning brief to it), and this is the guard that also refuses
 * /etc/hosts, /root/.ssh and `../` traversal — so widening it needs a test
 * that the widening did not become an escape.
 */
function loadValidatedFs(workspace: string, cwd: string) {
  const modulePath = path.join(process.cwd(), "infra/validated-fs.cjs")
  delete require.cache[require.resolve(modulePath)]
  const previousHome = process.env.OPENCLAW_HOME
  const previousCwd = process.cwd()
  process.env.OPENCLAW_HOME = workspace
  process.chdir(cwd)
  const { validatedFs } = require(modulePath)
  return {
    validatedFs,
    restore: () => {
      process.chdir(previousCwd)
      if (previousHome === undefined) delete process.env.OPENCLAW_HOME
      else process.env.OPENCLAW_HOME = previousHome
    },
  }
}

describe("image validated-fs allowed roots", () => {
  let workspace: string
  let elsewhere: string
  let cleanup: string
  let harness: ReturnType<typeof loadValidatedFs>

  beforeEach(() => {
    // Deliberately NOT under os.tmpdir(): that is already an allowed root, so
    // a workspace placed there is reachable with or without the OPENCLAW_HOME
    // root and the test would pass either way. Jest also ignores TMPDIR, so
    // narrowing os.tmpdir() is not an option. A repo-local scratch dir is
    // outside every root except the one under test.
    const base = fs.mkdtempSync(path.join(process.cwd(), ".vfs-roots-"))
    workspace = path.join(base, "openclaw")
    elsewhere = path.join(base, "elsewhere")
    for (const dir of [workspace, elsewhere]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(path.join(workspace, "config.json"), "{}")
    // cwd deliberately NOT the workspace — the shape that used to fail.
    harness = loadValidatedFs(workspace, elsewhere)
    cleanup = base
  })

  afterEach(() => {
    harness.restore()
    fs.rmSync(cleanup, { recursive: true, force: true })
  })

  it("allows a workspace read when cwd is somewhere else", () => {
    expect(() =>
      harness.validatedFs.readFileSync(path.join(workspace, "config.json"), "utf8")
    ).not.toThrow()
  })

  it("allows a workspace write when cwd is somewhere else", () => {
    expect(() =>
      harness.validatedFs.writeFileSync(path.join(workspace, "out.json"), "{}")
    ).not.toThrow()
  })

  it("still refuses absolute paths outside every root", () => {
    for (const target of ["/etc/hosts", "/root/.ssh/id_rsa", "/var/lib/secret"]) {
      expect(() => harness.validatedFs.readFileSync(target, "utf8")).toThrow(
        /Refusing read outside/
      )
    }
  })

  it("still refuses traversal out of the workspace", () => {
    expect(() =>
      harness.validatedFs.readFileSync(
        path.join(workspace, "..", "..", "..", "etc", "hosts"),
        "utf8"
      )
    ).toThrow(/Refusing read outside/)
  })

  it("keeps /opt readable but not writable", () => {
    // /opt carries the skills; a skill may read its own files, never write them.
    expect(() =>
      harness.validatedFs.writeFileSync("/opt/psd-skills/evil.js", "x")
    ).toThrow(/Refusing write outside/)
  })
})
