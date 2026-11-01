/** @jest-environment node */

/**
 * The durable scratch directory contract (#1895).
 *
 * Thirteen SKILL.md files told the agent to write its working files AND its
 * finished outputs under `/tmp`. `/tmp` is not part of the agent workspace —
 * `workspace_sync.py` only round-trips `/home/node/.openclaw/` — and each turn
 * may land on a fresh container, so anything left in `/tmp` between turns is
 * gone. In a read of 375 staff members' agent use (Aug–Oct 2026) that cost
 * real deliveries: PDFs and signs that "sat unpublished in /tmp" were never
 * sent, and a deputy principal's proposal source came back ENOENT.
 *
 * The instruction surface is the whole fix here — nothing in the runtime stops
 * a skill doc from naming `/tmp` again — so this suite is the only thing that
 * keeps it from drifting back.
 */

import { join } from "node:path"

import { validatedFs } from "@/lib/filesystem/validated-fs"

const { readFileSync, readdirSync, statSync } = validatedFs

const WORK_DIR = "/home/node/.openclaw/work"

const repoRoot = join(__dirname, "..", "..")
const agentImage = join(repoRoot, "infra", "agent-image")
const skillsDir = join(agentImage, "skills")

function skillManifests(): { name: string; path: string; body: string }[] {
  return readdirSync(skillsDir)
    .filter((entry) => {
      const manifest = join(skillsDir, entry, "SKILL.md")
      return statSync(join(skillsDir, entry)).isDirectory() &&
        validatedFs.existsSync(manifest)
    })
    .map((name) => {
      const path = join(skillsDir, name, "SKILL.md")
      return { name, path, body: readFileSync(path, "utf8") }
    })
}

describe("agent skill scratch directory", () => {
  it("has manifests to check", () => {
    // A glob that silently matched nothing would make every assertion below
    // vacuously true.
    expect(skillManifests().length).toBeGreaterThan(20)
  })

  it("names no /tmp path in any SKILL.md", () => {
    // Match a bare `/tmp` too, not just `/tmp/`: "write it to `/tmp`" is the
    // same instruction. Only the two docs that warn the agent away from /tmp
    // may name it.
    const warnings = new Set(["psd-rules", "psd-html-artifact"])
    const offenders = skillManifests()
      .filter(({ name }) => !warnings.has(name))
      .filter(({ body }) => /\/tmp\b/.test(body))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it("points the file-producing skills at the synced scratch directory", () => {
    // These are the skills whose whole job is to hand the user a file. If one
    // of them stops naming the scratch directory, it is writing somewhere that
    // does not survive the turn.
    const producers = [
      "psd-html-artifact",
      "psd-print-pdf",
      "psd-publish-file",
      "psd-pdf-to-markdown",
      "psd-sop-creator",
      "psd-transcribe",
      "psd-media",
    ]
    const manifests = new Map(skillManifests().map((m) => [m.name, m.body]))
    for (const name of producers) {
      const body = manifests.get(name)
      expect(body).toBeDefined()
      expect(body).toContain(WORK_DIR)
    }
  })

  it("creates the directory in the image and after every restore", () => {
    // Both halves are load-bearing: an empty directory is not an S3 object, so
    // it never comes back from a pull on its own, and a forced exact restore
    // prunes it as an uncommitted local extra.
    const dockerfile = readFileSync(join(agentImage, "Dockerfile"), "utf8")
    expect(dockerfile).toContain(WORK_DIR)

    const sync = readFileSync(join(agentImage, "workspace_sync.py"), "utf8")
    expect(sync).toContain('WORK_DIR_RELATIVE = "work"')
    expect(sync).toContain("def ensure_work_directory()")
    // Called on the restore path AND on the warm, unchanged-generation path
    // that skips pull_workspace entirely.
    expect(sync.match(/^\s+ensure_work_directory\(\)$/gm)?.length).toBe(2)
  })

  it("tells the agent in psd-rules to deliver in the turn it creates", () => {
    // psd-rules is concatenated into SOUL.md at image build time, so this is
    // the one instruction guaranteed to be in every turn's system prompt.
    const rules = readFileSync(
      join(skillsDir, "psd-rules", "SKILL.md"),
      "utf8"
    )
    expect(rules).toMatch(/^## Rule 16 — /m)
    expect(rules).toContain(WORK_DIR)
    expect(rules).toContain("delivered in the turn it is created")
    // The self-check is what the model actually re-reads before replying.
    expect(rules).toMatch(/\(R16\)/)
  })

  it("tells the agent that 'show me' means publish now, privately", () => {
    // Dev retest 2026-10-26: asked to "show" a rendered PNG, the model viewed
    // it with its own image tool and offered to publish instead of publishing.
    const rules = readFileSync(
      join(skillsDir, "psd-rules", "SKILL.md"),
      "utf8"
    )
    expect(rules).toContain(
      '**"Show me", "send me", "give me" a file or an image means deliver it now.**'
    )
    expect(rules).toContain("is not showing it to the user")
    expect(rules).toContain("is not delivering it")
    // Urgency must not override the FERPA routing in psd-publish-file.
    expect(rules).toContain("never switch to\n`--to public` for anything with student or staff data")
    expect(rules).toContain("Do not attach a file with a `MEDIA:` line")
    expect(rules).toMatch(/not viewed by you, not offered, not a `MEDIA:` line/)
  })
})
