/** @jest-environment node */

/**
 * Guards the deployment contract behind the ONE canonical personal-data
 * pattern file (#1886).
 *
 * The regexes are written once, in lib/safety/personal-data-patterns.json,
 * because three runtimes have to refuse the same things: the Next.js storage
 * broker's public-link check, chat-chart's QuickChart gate, and psd-tts's
 * narration gate. The agent image is built from a SEPARATE Docker context
 * (infra/agent-image), so build-and-push.sh stages that exact committed file
 * into skills/_shared/, where the existing `COPY skills` ships it to
 * /opt/psd-skills/_shared/.
 *
 * Without the staging step, `_shared/personal-data.js` throws at module load
 * on the next image build — taking chat-chart's gate down with it — and
 * psd-tts refuses every narration with `gate_unavailable`, because the
 * narration check deliberately fails CLOSED.
 *
 * It is also why the staged copy must never be committed: two copies drift,
 * and a privacy gate that disagrees with itself across runtimes is worse than
 * one rule applied everywhere.
 */

import { join } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { existsSync, readFileSync } = validatedFs

const repoRoot = join(__dirname, "..", "..")
const agentImageDir = join(repoRoot, "infra", "agent-image")
const canonicalPath = join(
  repoRoot,
  "lib",
  "safety",
  "personal-data-patterns.json"
)
const stagedRelative = "infra/agent-image/skills/_shared/personal-data-patterns.json"

const buildScript = readFileSync(
  join(agentImageDir, "build-and-push.sh"),
  "utf8"
)
const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8")
const dockerignore = readFileSync(join(agentImageDir, ".dockerignore"), "utf8")
const agentPlatformStack = readFileSync(
  join(repoRoot, "infra", "lib", "agent-platform-stack.ts"),
  "utf8"
)

describe("agent-image ships the canonical personal-data patterns", () => {
  it("build-and-push.sh stages the committed file into the build context", () => {
    expect(buildScript).toContain(
      'CANONICAL_PERSONAL_DATA_PATTERNS="${REPO_ROOT}/lib/safety/personal-data-patterns.json"'
    )
    expect(buildScript).toContain(
      'STAGED_PERSONAL_DATA_PATTERNS="${SCRIPT_DIR}/skills/_shared/personal-data-patterns.json"'
    )
    expect(buildScript).toContain(
      'cp "${CANONICAL_PERSONAL_DATA_PATTERNS}" "${STAGED_PERSONAL_DATA_PATTERNS}"'
    )
  })

  it("removes the staged copy again, including on an aborted build", () => {
    // Twice: once in cleanup_build (the EXIT trap) and once after the build.
    const removals = buildScript.match(
      /rm -f "\$\{STAGED_PERSONAL_DATA_PATTERNS\}"/g
    )
    expect(removals?.length).toBe(2)
  })

  it("refuses to build when the canonical file is uncommitted", () => {
    // Image provenance must identify the exact source content, and the
    // patterns are now part of what the image enforces.
    expect(buildScript).toContain("lib/safety/personal-data-patterns.json \\")
  })

  it("keeps the staged copy out of git so it cannot drift", () => {
    expect(gitignore).toContain(stagedRelative)
    expect(existsSync(join(repoRoot, stagedRelative))).toBe(false)
  })

  it("keeps the staged file out of the CDK bundled-skills asset", () => {
    // The staged copy lands INSIDE infra/agent-image/skills/, the tree the
    // BundledSkillsDeployment uploads to S3. A deploy overlapping a build would
    // otherwise ship it and make the asset hash depend on build timing.
    expect(agentPlatformStack).toContain("'_shared/personal-data-patterns.json',")
    expect(agentPlatformStack).toContain("'validated-fs.cjs',")
  })

  it("does not let .dockerignore exclude the staged file", () => {
    // The staging lands in the build context AFTER .dockerignore is read, so a
    // broad `*.json` rule here would silently produce an image with no gate.
    expect(dockerignore).not.toMatch(/^\*\.json$/m)
    expect(dockerignore).not.toMatch(/^skills\//m)
  })
})

describe("the canonical pattern file is the only copy of the regexes", () => {
  const patternFile = JSON.parse(readFileSync(canonicalPath, "utf8")) as {
    version: number
    patterns: Array<{ kind: string; source: string; description: string }>
    publicFileMinDistinct: Record<string, number>
    narrationMinDistinct: Record<string, number>
  }

  it("covers the four kinds #1886 names, with a threshold for each", () => {
    const kinds = new Set(patternFile.patterns.map((entry) => entry.kind))
    expect([...kinds].sort()).toEqual([
      "email",
      "psd-student-id",
      "ssn",
      "us-phone",
    ])
    for (const kind of kinds) {
      expect(typeof patternFile.publicFileMinDistinct[kind]).toBe("number")
      expect(typeof patternFile.narrationMinDistinct[kind]).toBe("number")
    }
  })

  it("uses only syntax that is valid in both JavaScript and Python re", () => {
    for (const { source } of patternFile.patterns) {
      // No named groups, lookbehind, or Unicode property escapes: Python's
      // `re` spells the first differently and rejects the other two.
      expect(source).not.toMatch(/\(\?</)
      expect(source).not.toMatch(/\\p\{/)
    }
  })

  it("keeps every quantifier bounded, which is what keeps the scan linear", () => {
    // chat-chart's run.test.js holds the 120KB timing test this protects: an
    // unbounded `+` in the email pattern took ~25s of CPU to reject 120KB.
    for (const { kind, source } of patternFile.patterns) {
      expect(source).not.toMatch(/[\])][+*]/)
      expect(`${kind}:${source}`).not.toMatch(/\)\{\d/)
    }
  })

  it("is not duplicated back into the places that used to hold it", () => {
    for (const file of [
      join(repoRoot, "infra", "agent-image", "skills", "chat-chart", "run.js"),
      join(repoRoot, "lib", "safety", "types.ts"),
      join(repoRoot, "lib", "safety", "custom-pii-patterns.ts"),
      join(repoRoot, "docs", "features", "k12-content-safety.md"),
      join(repoRoot, "lib", "safety", "personal-data-scan.ts"),
      join(repoRoot, "infra", "agent-image", "skills", "_shared", "personal-data.js"),
      join(repoRoot, "infra", "agent-image", "personal_data.py"),
    ]) {
      const contents = readFileSync(file, "utf8")
      // The student-ID regex is the one that had three copies. Any literal
      // re-appearance means a loader grew a hardcoded fallback.
      expect(contents).not.toContain("\\b2\\d{6}\\b")
    }
  })
})
