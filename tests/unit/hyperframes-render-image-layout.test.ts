/** @jest-environment node */

import { dirname, join, posix } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const repoRoot = join(__dirname, "..", "..")
const dockerfile = validatedFs.readFileSync(
  join(repoRoot, "infra", "hyperframes-render", "Dockerfile"),
  "utf8",
)
const construct = validatedFs.readFileSync(
  join(
    repoRoot,
    "infra",
    "lib",
    "constructs",
    "compute",
    "hyperframes-render-function.ts",
  ),
  "utf8",
)
const handler = validatedFs.readFileSync(
  join(repoRoot, "infra", "hyperframes-render", "handler.js"),
  "utf8",
)
const readme = validatedFs.readFileSync(
  join(repoRoot, "infra", "hyperframes-render", "README.md"),
  "utf8",
)

describe("HyperFrames Lambda image ships the filesystem guard", () => {
  it("copies the canonical guard where the deployed handler resolves it", () => {
    const requirePath =
      handler.match(/require\((["'])(\.\.\/validated-fs\.cjs)\1\)/)?.[2]

    expect(requirePath).toBe("../validated-fs.cjs")
    expect(
      posix.normalize(posix.join(dirname("/var/task/handler.js"), requirePath!)),
    ).toBe("/var/validated-fs.cjs")
    expect(dockerfile).toContain(
      "COPY validated-fs.cjs /var/validated-fs.cjs",
    )
  })

  it("uses the infra root as a narrow CDK context containing both sources", () => {
    expect(construct).toContain(
      'const imageAssetRoot = path.join(__dirname, "..", "..", "..")',
    )
    expect(construct).toContain('file: "hyperframes-render/Dockerfile"')
    expect(construct).toContain('"!validated-fs.cjs"')
    expect(construct).toContain('"!hyperframes-render/"')
    expect(construct).toContain('"!hyperframes-render/handler.js"')
    expect(construct).toContain('"hyperframes-render/README.md"')
    expect(construct).toContain('"hyperframes-render/handler.test.js"')
    expect(construct).toContain('"hyperframes-render/sample-events"')
    expect(dockerfile).toContain("COPY hyperframes-render/handler.js ./")
  })

  it("documents the task root required by RIE outside Lambda", () => {
    expect(readme).toContain("-e LAMBDA_TASK_ROOT=/var/task")
  })
})
