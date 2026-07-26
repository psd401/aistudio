import { and, eq, ilike, or, sql } from "drizzle-orm"
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client"
import { users } from "@/lib/db/schema/tables/users"
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills"
import { psdAgentSkillAudit } from "@/lib/db/schema/tables/agent-skill-audit"
import {
  invokeSkillScan,
  readSkillMarkdown,
  uploadSkillDraft,
  type SkillFile,
} from "@/lib/skills/skill-publish-pipeline"

const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/
const MAX_QUERY_LENGTH = 200
const MAX_SUMMARY_LENGTH = 500
const MAX_SKILL_MD_BYTES = 256 * 1024
const MAX_FILES = 20
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024

export class AgentSkillInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentSkillInputError"
  }
}

export class AgentSkillOwnerNotFoundError extends Error {
  constructor() {
    super("The signed owner does not have an AI Studio user record")
    this.name = "AgentSkillOwnerNotFoundError"
  }
}

interface AgentSkillFileInput {
  path?: unknown
  content_base64?: unknown
}

function safeName(raw: unknown): string {
  if (typeof raw !== "string" || !SAFE_NAME_RE.test(raw)) {
    throw new AgentSkillInputError("Invalid skill name")
  }
  return raw
}

function safeRelativePath(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > 240 ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new AgentSkillInputError("Invalid skill file path")
  }
  return raw
}

function decodeBase64(raw: unknown, label: string, maxBytes: number): Uint8Array {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
    raw.length % 4 !== 0
  ) {
    throw new AgentSkillInputError(`${label} must be valid base64`)
  }
  const content = Buffer.from(raw, "base64")
  if (content.length === 0 || content.length > maxBytes) {
    throw new AgentSkillInputError(`${label} exceeds its size limit`)
  }
  return content
}

async function ownerUserId(ownerEmail: string): Promise<number> {
  const [owner] = await executeQuery(
    (db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${ownerEmail})`)
        .limit(1),
    "agentSkills.resolveOwner"
  )
  if (!owner) throw new AgentSkillOwnerNotFoundError()
  return owner.id
}

export class AgentSkillsService {
  async search(ownerEmail: string, rawQuery: unknown) {
    if (
      typeof rawQuery !== "string" ||
      rawQuery.trim().length < 1 ||
      rawQuery.length > MAX_QUERY_LENGTH
    ) {
      throw new AgentSkillInputError("Invalid skill search query")
    }
    const ownerId = await ownerUserId(ownerEmail)
    const pattern = `%${rawQuery.trim().replace(/[\\%_]/g, "\\$&")}%`
    return executeQuery(
      (db) =>
        db
          .select({
            id: psdAgentSkills.id,
            name: psdAgentSkills.name,
            scope: psdAgentSkills.scope,
            summary: psdAgentSkills.summary,
            scanStatus: psdAgentSkills.scanStatus,
          })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.scanStatus, "clean"),
              or(
                eq(psdAgentSkills.scope, "shared"),
                and(
                  eq(psdAgentSkills.scope, "user"),
                  eq(psdAgentSkills.ownerUserId, ownerId)
                )
              ),
              or(
                ilike(psdAgentSkills.name, pattern),
                ilike(psdAgentSkills.summary, pattern)
              )
            )
          )
          .orderBy(psdAgentSkills.name)
          .limit(20),
      "agentSkills.search"
    )
  }

  async load(ownerEmail: string, rawName: unknown) {
    const name = safeName(rawName)
    const ownerId = await ownerUserId(ownerEmail)
    const [skill] = await executeQuery(
      (db) =>
        db
          .select({
            name: psdAgentSkills.name,
            s3Key: psdAgentSkills.s3Key,
          })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.name, name),
              eq(psdAgentSkills.scanStatus, "clean"),
              or(
                eq(psdAgentSkills.scope, "shared"),
                and(
                  eq(psdAgentSkills.scope, "user"),
                  eq(psdAgentSkills.ownerUserId, ownerId)
                )
              )
            )
          )
          .limit(1),
      "agentSkills.load"
    )
    if (!skill) return null
    const skillMd = await readSkillMarkdown(skill.s3Key)
    return skillMd ? { name: skill.name, skillMd } : null
  }

  async author(
    ownerEmail: string,
    input: {
      name: unknown
      summary: unknown
      skillMdBase64: unknown
      files: unknown
    }
  ) {
    const name = safeName(input.name)
    if (/^psd-/i.test(name)) {
      throw new AgentSkillInputError(
        'The "psd-" prefix is reserved for system skills'
      )
    }
    if (
      typeof input.summary !== "string" ||
      input.summary.trim().length < 1 ||
      input.summary.length > MAX_SUMMARY_LENGTH
    ) {
      throw new AgentSkillInputError("Invalid skill summary")
    }
    const summary = input.summary.trim()
    const skillMd = decodeBase64(
      input.skillMdBase64,
      "SKILL.md",
      MAX_SKILL_MD_BYTES
    )
    const skillMdText = Buffer.from(skillMd).toString("utf8")
    if (
      !skillMdText.startsWith("---") ||
      !skillMdText.slice(3).includes("---") ||
      !/\nname:\s*\S/.test(skillMdText) ||
      !/\nsummary:\s*\S/.test(skillMdText)
    ) {
      throw new AgentSkillInputError(
        "SKILL.md must contain name and summary frontmatter"
      )
    }
    const rawFiles = input.files === undefined ? [] : input.files
    if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
      throw new AgentSkillInputError("Invalid skill files")
    }
    const files: SkillFile[] = [
      {
        path: "SKILL.md",
        content: skillMd,
        contentType: "text/markdown",
      },
    ]
    let totalBytes = skillMd.length
    const seen = new Set(["SKILL.md"])
    for (const rawFile of rawFiles as AgentSkillFileInput[]) {
      if (!rawFile || typeof rawFile !== "object") {
        throw new AgentSkillInputError("Invalid skill file")
      }
      const path = safeRelativePath(rawFile.path)
      if (seen.has(path)) {
        throw new AgentSkillInputError("Duplicate skill file path")
      }
      seen.add(path)
      const content = decodeBase64(
        rawFile.content_base64,
        `File ${path}`,
        MAX_FILE_BYTES
      )
      totalBytes += content.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new AgentSkillInputError("Skill files exceed the total size limit")
      }
      files.push({ path, content })
    }

    const ownerId = await ownerUserId(ownerEmail)
    const { draftPrefix, destinationPrefix } = await uploadSkillDraft({
      ownerEmail,
      slug: name,
      files,
    })
    const skill = await executeTransaction(async (tx) => {
      const [row] = await tx
        .insert(psdAgentSkills)
        .values({
          name,
          scope: "draft",
          ownerUserId: ownerId,
          s3Key: draftPrefix,
          summary,
          scanStatus: "pending",
        })
        .onConflictDoUpdate({
          target: [psdAgentSkills.name, psdAgentSkills.ownerUserId],
          targetWhere: eq(psdAgentSkills.scope, "draft"),
          set: {
            s3Key: draftPrefix,
            summary,
            scanStatus: "pending",
            scanLeaseId: null,
            scanStartedAt: null,
            version: sql`${psdAgentSkills.version} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: psdAgentSkills.id,
          version: psdAgentSkills.version,
        })
      if (!row) throw new Error("Skill draft upsert returned no id")
      await tx.insert(psdAgentSkillAudit).values({
        skillId: row.id,
        action: "agent_authored",
        actorUserId: ownerId,
        details: { draftPrefix, destinationPrefix },
      })
      return row
    }, "agentSkills.author")
    const scanQueued = await invokeSkillScan({
      skillId: skill.id,
      ownerKey: ownerEmail,
      version: skill.version,
      draftPrefix,
      destinationPrefix,
      idempotencyKey: `${skill.id}:${skill.version}`,
    })
    return { skillId: skill.id, name, scanQueued }
  }
}
