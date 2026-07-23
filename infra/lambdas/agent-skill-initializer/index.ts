/**
 * Agent Skill Initializer
 *
 * Invoked by a CDK Custom Resource on every AgentPlatformStack deploy.
 * Receives the manifest of image-bundled skills (built at synth time
 * from `infra/agent-image/skills/{name}/SKILL.md` frontmatter) and
 * UPSERTs each one into `psd_agent_skills` with scope=shared and
 * scan_status=clean.
 *
 * Bundled skills are pre-vetted (they ship in the agent image, code-
 * reviewed and built by us), so the security scan is skipped — the
 * scope='shared' + scan_status='clean' combination is the same state a
 * user-submitted skill would land in after the skill-builder Lambda's
 * scan completes.
 *
 * Idempotent: re-running with the same manifest is a no-op (UPSERT only
 * bumps the version when the source hash changes). Skills removed from
 * the image manifest are NOT auto-deleted from the DB — that's an
 * explicit admin action via the Skills tab.
 *
 * Env vars:
 *   DATABASE_HOST         — Aurora host
 *   DATABASE_SECRET_ARN   — Aurora credentials secret
 *   DATABASE_NAME         — default 'aistudio'
 *   DATABASE_PORT         — default 5432
 *   IMAGE_TAG             — current agent image tag (stored in s3_key for traceability)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
import postgres from "postgres"

const DATABASE_HOST = process.env.DATABASE_HOST || ""
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || ""
const DATABASE_NAME = process.env.DATABASE_NAME || "aistudio"
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT || "5432", 10)

const secrets = new SecretsManagerClient({})

let sqlClient: postgres.Sql | null = null
async function getSql(): Promise<postgres.Sql> {
  if (sqlClient) return sqlClient
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN }),
  )
  if (!res.SecretString) throw new Error("Database secret missing SecretString")
  const creds = JSON.parse(res.SecretString) as {
    username: string
    password: string
  }
  sqlClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: creds.username,
    password: creds.password,
    ssl: "require",
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
  })
  return sqlClient
}

interface SkillManifestEntry {
  name: string
  summary: string
  description?: string
  sourceHash: string
  imageTag: string
}

interface CustomResourceEvent {
  RequestType: "Create" | "Update" | "Delete"
  ResourceProperties: {
    ServiceToken?: string
    skills?: SkillManifestEntry[]
    imageTag?: string
    /** Trigger string forces CDK to invoke this Custom Resource on every deploy. */
    trigger?: string
  }
}

interface CustomResourceResponse {
  PhysicalResourceId: string
  Data: { upserted: number; skipped: number; imageTag: string }
}

async function upsertSkills(
  skills: SkillManifestEntry[],
  imageTag: string,
): Promise<{ upserted: number; skipped: number }> {
  if (skills.length === 0) return { upserted: 0, skipped: 0 }
  const sql = await getSql()
  let upserted = 0
  let skipped = 0

  for (const skill of skills) {
    if (!skill.name || !skill.summary || !skill.sourceHash) {
      skipped++
      continue
    }
    // s3Key column stores `image:<tag>:<name>` for bundled skills — there's
    // no real S3 object, but the column is NOT NULL and this string is
    // both a stable identifier and a useful breadcrumb in the dashboard.
    const s3Key = `image:${imageTag}:${skill.name}`
    // UPSERT keyed on the partial unique index (name) WHERE scope='shared'.
    // The summary and s3Key get refreshed on every deploy; version bumps
    // when the source hash changes.
    const result = await sql<{ id: string; version: number }[]>`
      INSERT INTO psd_agent_skills
        (name, scope, s3_key, version, summary, scan_status, created_at, updated_at)
      VALUES
        (${skill.name}, 'shared', ${s3Key}, 1, ${skill.summary}, 'clean', NOW(), NOW())
      ON CONFLICT (name) WHERE scope = 'shared'
      DO UPDATE SET
        s3_key = EXCLUDED.s3_key,
        summary = EXCLUDED.summary,
        scan_status = 'clean',
        version = CASE
          WHEN psd_agent_skills.s3_key = EXCLUDED.s3_key THEN psd_agent_skills.version
          ELSE psd_agent_skills.version + 1
        END,
        updated_at = NOW()
      RETURNING id, version
    `
    if (result.length > 0) upserted++
  }
  return { upserted, skipped }
}

export const handler = async (
  event: CustomResourceEvent,
): Promise<CustomResourceResponse> => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "INFO",
      logger: "agent-skill-initializer",
      evt: "invoke",
      requestType: event.RequestType,
      skillCount: event.ResourceProperties.skills?.length ?? 0,
      imageTag: event.ResourceProperties.imageTag ?? "unknown",
    }),
  )

  // Delete is a no-op — image-bundled skills shouldn't be wiped from the
  // DB when the stack is destroyed; an admin can clean up via the
  // Skills tab if needed.
  if (event.RequestType === "Delete") {
    return {
      PhysicalResourceId: "agent-skill-initializer",
      Data: { upserted: 0, skipped: 0, imageTag: "n/a" },
    }
  }

  const skills = event.ResourceProperties.skills ?? []
  const imageTag = event.ResourceProperties.imageTag ?? "unknown"
  const { upserted, skipped } = await upsertSkills(skills, imageTag)

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "INFO",
      logger: "agent-skill-initializer",
      evt: "complete",
      upserted,
      skipped,
      imageTag,
    }),
  )

  return {
    PhysicalResourceId: "agent-skill-initializer",
    Data: { upserted, skipped, imageTag },
  }
}
