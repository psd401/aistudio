/** @jest-environment node */

import { join } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { readFileSync } = validatedFs
const repoRoot = join(__dirname, "..", "..")
const imageDir = join(repoRoot, "infra", "agent-image")
const dockerfile = readFileSync(join(imageDir, "Dockerfile"), "utf8")
const runtimePatch = readFileSync(
  join(imageDir, "openclaw_runtime_patch.mjs"),
  "utf8"
)

describe("pinned OpenClaw runtime backports", () => {
  it("ships and executes the patch before making /app immutable", () => {
    expect(dockerfile).toContain("COPY *.py *.mjs /app/")
    expect(dockerfile).toContain(
      "RUN node /app/openclaw_runtime_patch.mjs /app/dist"
    )
    expect(dockerfile.indexOf("node /app/openclaw_runtime_patch.mjs")).toBeLessThan(
      dockerfile.indexOf("chmod -R a-w /app")
    )
  })

  it("is fail-closed and pinned to the exact affected host release", () => {
    expect(runtimePatch).toContain(
      'const EXPECTED_OPENCLAW_VERSION = "2026.7.2-beta.5"'
    )
    expect(runtimePatch).toContain(
      "expected one bundle, found ${matches.length}"
    )
    expect(runtimePatch).toContain("expected anchor occurred more than once")
  })

  it("contains every transcript-ownership fix required by the backport", () => {
    expect(runtimePatch).toContain("reuse ingress transcript recorder")
    expect(runtimePatch).toContain("detach ingress user before orphan repair")
    expect(runtimePatch).toContain("adopt ingress-persisted user turn")
    expect(runtimePatch).toContain("suppress duplicate transcript update")
    expect(runtimePatch).toContain("preserve setup inference session manager")
  })
})
