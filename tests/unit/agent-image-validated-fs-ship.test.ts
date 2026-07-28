/** @jest-environment node */

/**
 * Guards the deployment contract behind the lint-hardening sweep's
 * `require("../../../validated-fs.cjs")` in agent skills.
 *
 * On disk that require resolves to infra/validated-fs.cjs. In the agent
 * container, /opt/psd-skills/<skill>/<file>.js resolves it to /validated-fs.cjs
 * — a path the image does not naturally ship. Without the staging + symlink
 * below, EVERY skill carrying the require crashes at module load on the next
 * image build (MODULE_NOT_FOUND), taking down psd-atrium, psd-workspace,
 * psd-learning-page, and the rest of the runtime skill surface at once.
 *
 * The image sits at the 53-layer Firecracker overlay ceiling (see the
 * consolidated-RUN comment in infra/agent-image/Dockerfile), so the fix is NOT
 * a new COPY layer: build-and-push.sh stages infra/validated-fs.cjs into
 * skills/ (shipped by the existing `COPY skills`), and the existing hardening
 * RUN symlinks /validated-fs.cjs to that staged copy.
 */

import { join } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { readFileSync, readdirSync, statSync } = validatedFs

const repoRoot = join(__dirname, "..", "..")
const skillsDir = join(repoRoot, "infra", "agent-image", "skills")
const dockerfile = readFileSync(
  join(repoRoot, "infra", "agent-image", "Dockerfile"),
  "utf8"
)
const buildScript = readFileSync(
  join(repoRoot, "infra", "agent-image", "build-and-push.sh"),
  "utf8"
)

function jsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...jsFilesUnder(full))
    else if (/\.(cjs|js|mjs)$/.test(entry)) out.push(full)
  }
  return out
}

describe("agent-image ships validated-fs.cjs where skills resolve it", () => {
  const requiringFiles = jsFilesUnder(skillsDir).filter((file) =>
    readFileSync(file, "utf8").includes("../../../validated-fs.cjs")
  )

  it("has runtime skill files that carry the require (sanity: sweep present)", () => {
    expect(requiringFiles.length).toBeGreaterThan(0)
  })

  it("build-and-push.sh stages the canonical copy into the build context", () => {
    expect(buildScript).toContain(
      'cp "${SCRIPT_DIR}/../validated-fs.cjs" "${SCRIPT_DIR}/skills/validated-fs.cjs"'
    )
  })

  it("Dockerfile symlinks /validated-fs.cjs to the staged copy without a new layer", () => {
    expect(dockerfile).toContain(
      "ln -s /opt/psd-skills/validated-fs.cjs /validated-fs.cjs"
    )
    // The ln must be appended to an existing RUN, not a new COPY/RUN layer.
    expect(dockerfile).not.toMatch(/^COPY\s+validated-fs\.cjs/m)
    expect(dockerfile).not.toMatch(/^RUN\s+ln -s \/opt\/psd-skills\/validated-fs\.cjs/m)
  })

  it("every skill require uses the exact depth the symlink was built for", () => {
    // A require at a different directory depth would resolve to a different
    // in-container path than /validated-fs.cjs and dodge the symlink.
    for (const file of requiringFiles) {
      const content = readFileSync(file, "utf8")
      const matches = content.match(/require\((["'])(\.[./]*validated-fs\.cjs)\1\)/g) || []
      for (const match of matches) {
        expect(match).toContain("../../../validated-fs.cjs")
      }
      // Skill root files sit exactly one directory under skills/, so ../../../
      // resolves to / in-container. Deeper files would need a different prefix.
      const depth = file.slice(skillsDir.length + 1).split("/").length
      expect(depth).toBe(2)
    }
  })
})
