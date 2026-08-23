/** @jest-environment node */

import { join } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { readFileSync } = validatedFs
const repoRoot = join(__dirname, "..", "..")
const imageDir = join(repoRoot, "infra", "agent-image")
const dockerfile = readFileSync(join(imageDir, "Dockerfile"), "utf8")
const buildScript = readFileSync(
  join(imageDir, "build-and-push.sh"),
  "utf8",
)
const runtimePatch = readFileSync(
  join(imageDir, "openclaw_runtime_patch.mjs"),
  "utf8"
)

describe("pinned OpenClaw runtime backports", () => {
  it("ships and executes the patch before making /app immutable", () => {
    expect(dockerfile).toContain(
      "COPY *.py *.mjs workspace_policy.json /app/",
    )
    expect(buildScript).toContain(
      'cp "${CANONICAL_WORKSPACE_POLICY}" "${STAGED_WORKSPACE_POLICY}"',
    )
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

  it("stops a no-op file mutation from ending the whole run", () => {
    // A quartile report died 484s in, 53 model calls deep, because the agent
    // issued an `edit` whose replacement matched what was already there.
    // That returns `terminate: true`, and agent-core ends the run when every
    // call in the batch terminated — while the model's own stopReason was
    // still `toolUse`. Worst exactly where it is most likely: repairing a file
    // means writing content that may already be correct.
    expect(runtimePatch).toContain("edit no-op must not terminate the run")
    expect(runtimePatch).toContain(
      "edit identical-content must not terminate the run",
    )
    expect(runtimePatch).toContain("write no-op must not terminate the run")
    expect(runtimePatch).toContain("patch no-op must not terminate the run")
  })

  it("leaves the client-delegated terminate alone", () => {
    // "Tool execution delegated to client" is a real pause, not a no-op, and
    // must keep terminating. Named here so a future sweep for `terminate:
    // true` does not take it out with the others.
    expect(runtimePatch).toContain("Tool execution delegated to client")
    expect(runtimePatch).not.toContain(
      "delegated to client must not terminate",
    )
  })

  it("contains every transcript-ownership fix required by the backport", () => {
    expect(runtimePatch).toContain("reuse ingress transcript recorder")
    expect(runtimePatch).toContain("detach ingress user before orphan repair")
    expect(runtimePatch).toContain("adopt ingress-persisted user turn")
    expect(runtimePatch).toContain("suppress duplicate transcript update")
    expect(runtimePatch).toContain("preserve setup inference session manager")
  })
})
