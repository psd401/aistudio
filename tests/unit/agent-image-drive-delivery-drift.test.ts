/** @jest-environment node */

/**
 * The skill layer's copy of the Drive-delivery policy must match the broker's.
 *
 * The broker is the real gate; the skill's map exists so a refusal names the
 * extension and lists what IS deliverable. When the two drift, the agent gets a
 * confident local "yes" followed by an opaque broker rejection — which is the
 * failure mode that made `drive +upload` look allowlisted for months while
 * being impossible.
 *
 * It also pins two pieces of wording the issue called out as actively wrong:
 * the unsupported-type message used to tell the agent to "attach it to the
 * reply" (it cannot — Chat replies carry no attachments), and the public-link
 * text claimed the links never expire (the `expire-public-artifacts` lifecycle
 * rule deletes them after 30 days).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "@jest/globals"

import { DRIVE_DELIVERY_CONTENT_TYPES } from "@/lib/agent-workspace/drive-delivery"

const SKILLS_DIR = join(process.cwd(), "infra/agent-image/skills")
const PUBLISH_JS_PATH = join(SKILLS_DIR, "psd-publish-file/publish.js")
const PUBLISH_SKILL_PATH = join(SKILLS_DIR, "psd-publish-file/SKILL.md")
const DELIVERER_PATH = join(SKILLS_DIR, "_shared/drive-deliverer.js")
const PRINT_PDF_SKILL_PATH = join(SKILLS_DIR, "psd-print-pdf/SKILL.md")
const HTML_ARTIFACT_SKILL_PATH = join(SKILLS_DIR, "psd-html-artifact/SKILL.md")
const WORKSPACE_SKILL_PATH = join(SKILLS_DIR, "psd-workspace/SKILL.md")
const IMAGE_GEN_SKILL_PATH = join(SKILLS_DIR, "psd-image-gen/SKILL.md")

const publishJs = readFileSync(PUBLISH_JS_PATH, "utf8")
const publishSkill = readFileSync(PUBLISH_SKILL_PATH, "utf8")
const pointerSkills: Array<[string, string]> = [
  ["psd-print-pdf", readFileSync(PRINT_PDF_SKILL_PATH, "utf8")],
  ["psd-html-artifact", readFileSync(HTML_ARTIFACT_SKILL_PATH, "utf8")],
  ["psd-workspace", readFileSync(WORKSPACE_SKILL_PATH, "utf8")],
  ["psd-image-gen", readFileSync(IMAGE_GEN_SKILL_PATH, "utf8")],
]

const { DRIVE_DELIVERABLE_TYPES, MAX_DRIVE_DELIVERY_BYTES } = require(
  DELIVERER_PATH,
) as {
  DRIVE_DELIVERABLE_TYPES: Map<string, string>
  MAX_DRIVE_DELIVERY_BYTES: number
}

describe("psd-publish-file Drive delivery", () => {
  it("mirrors the broker's deliverable extension/MIME map exactly", () => {
    expect([...DRIVE_DELIVERABLE_TYPES.entries()].sort()).toEqual(
      [...DRIVE_DELIVERY_CONTENT_TYPES.entries()].sort(),
    )
  })

  it("mirrors the broker's delivery size cap", () => {
    expect(MAX_DRIVE_DELIVERY_BYTES).toBe(100 * 1024 * 1024)
  })

  it("carries the Office types the public path cannot take", () => {
    for (const extension of [".docx", ".xlsx", ".pptx"]) {
      expect(DRIVE_DELIVERABLE_TYPES.has(extension)).toBe(true)
    }
  })

  it("offers a Drive delivery mode and defaults to it", () => {
    expect(publishJs).toContain("--to drive")
    // Drive when `--to` is absent: the private path is the default delivery
    // path, not an opt-in.
    expect(publishJs).toMatch(/if \(requested === undefined\) return 'drive'/)
  })

  it("no longer tells the agent to attach the file to the reply", () => {
    for (const source of [publishJs, publishSkill]) {
      expect(source).not.toMatch(/attach it to the reply/i)
    }
  })

  it("says public links expire after 30 days, and never that they do not", () => {
    for (const source of [publishJs, publishSkill]) {
      expect(source).toMatch(/30 days/)
      expect(source).not.toMatch(/never expires?|does not expire/i)
    }
  })

  it("points the other file-producing skills at the private path", () => {
    for (const [name, source] of pointerSkills) {
      expect({ name, mentions: source.includes("psd-publish-file") }).toEqual({
        name,
        mentions: true,
      })
      expect({ name, drive: /Drive/.test(source) }).toEqual({ name, drive: true })
    }
  })
})
