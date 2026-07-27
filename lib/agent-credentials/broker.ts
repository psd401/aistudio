import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"
import { sql } from "drizzle-orm"
import {
  psdAgentCredentialReads,
  psdAgentCredentialRequests,
  psdAgentCredentialsAudit,
} from "@/lib/db/schema"
import {
  executeQuery,
  toPgRows,
} from "@/lib/db/drizzle-client"

const SAFE_CREDENTIAL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/
const SAFE_CAPABILITY_RE = /^[a-z0-9._-]{1,64}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LISTED_CREDENTIALS = 500

export class AgentCredentialInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentCredentialInputError"
  }
}

export class AgentCredentialNotConfiguredError extends Error {
  constructor() {
    super("Agent credential broker is not configured")
    this.name = "AgentCredentialNotConfiguredError"
  }
}

function credentialName(value: unknown): string {
  if (typeof value !== "string" || !SAFE_CREDENTIAL_NAME_RE.test(value)) {
    throw new AgentCredentialInputError("Invalid credential name")
  }
  return value
}

function environment(): string {
  const value = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT
  if (!value) throw new AgentCredentialNotConfiguredError()
  return value
}

function userSecretId(ownerEmail: string, name: string): string {
  return `psd-agent-creds/${environment()}/user/${ownerEmail}/${name}`
}

function sharedSecretId(name: string): string {
  return `psd-agent-creds/${environment()}/shared/${name}`
}

async function tryReadSecret(
  client: SecretsManagerClient,
  secretId: string
): Promise<string | null> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId })
    )
    return result.SecretString ?? null
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return null
    throw error
  }
}

export class AgentCredentialBroker {
  constructor(
    private readonly secrets = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-east-1",
    })
  ) {}

  async get(
    ownerEmail: string,
    rawName: unknown,
    options: { sharedOnly?: boolean; sessionId?: string } = {}
  ): Promise<{ name: string; value: string; scope: "user" | "shared" } | null> {
    const name = credentialName(rawName)
    let value: string | null = null
    let scope: "user" | "shared" = "shared"
    if (!options.sharedOnly) {
      value = await tryReadSecret(this.secrets, userSecretId(ownerEmail, name))
      if (value !== null) scope = "user"
    }
    if (value === null) {
      value = await tryReadSecret(this.secrets, sharedSecretId(name))
      scope = "shared"
    }
    if (value === null) return null
    await executeQuery(
      (db) =>
        db.insert(psdAgentCredentialReads).values({
          credentialName: name,
          userId: ownerEmail,
          sessionId: options.sessionId?.slice(0, 512) || null,
        }),
      "agentCredentialReadAudit"
    )
    return { name, value, scope }
  }

  async getUserOnly(
    ownerEmail: string,
    rawName: unknown,
    options: { sessionId?: string } = {}
  ): Promise<{ name: string; value: string; scope: "user" } | null> {
    const name = credentialName(rawName)
    const value = await tryReadSecret(
      this.secrets,
      userSecretId(ownerEmail, name)
    )
    if (value === null) return null
    await executeQuery(
      (db) =>
        db.insert(psdAgentCredentialReads).values({
          credentialName: name,
          userId: ownerEmail,
          sessionId: options.sessionId?.slice(0, 512) || null,
        }),
      "agentOwnerCredentialReadAudit"
    )
    return { name, value, scope: "user" }
  }

  async list(
    ownerEmail: string
  ): Promise<Array<{ name: string; scope: "user" | "shared" }>> {
    const prefixes = [
      {
        prefix: `psd-agent-creds/${environment()}/shared/`,
        scope: "shared" as const,
      },
      {
        prefix: `psd-agent-creds/${environment()}/user/${ownerEmail}/`,
        scope: "user" as const,
      },
    ]
    const credentials: Array<{
      name: string
      scope: "user" | "shared"
    }> = []
    for (const { prefix, scope } of prefixes) {
      let nextToken: string | undefined
      do {
        const result = await this.secrets.send(
          new ListSecretsCommand({
            Filters: [{ Key: "name", Values: [prefix] }],
            MaxResults: 100,
            NextToken: nextToken,
          })
        )
        for (const secret of result.SecretList ?? []) {
          if (
            typeof secret.Name === "string" &&
            secret.Name.startsWith(prefix)
          ) {
            const name = secret.Name.slice(prefix.length)
            if (SAFE_CREDENTIAL_NAME_RE.test(name)) {
              credentials.push({ name, scope })
            }
          }
          if (credentials.length >= MAX_LISTED_CREDENTIALS) {
            return credentials
          }
        }
        nextToken = result.NextToken
      } while (nextToken)
    }
    return credentials
  }

  async put(
    ownerEmail: string,
    rawName: unknown,
    rawValue: unknown
  ): Promise<{ name: string; action: "created" | "rotated" }> {
    const name = credentialName(rawName)
    if (
      typeof rawValue !== "string" ||
      rawValue.trim().length < 8 ||
      rawValue.length > 4096 ||
      /^<[^>]+>$/.test(rawValue.trim())
    ) {
      throw new AgentCredentialInputError("Invalid credential value")
    }
    const secretId = userSecretId(ownerEmail, name)
    let action: "created" | "rotated" = "created"
    try {
      await this.secrets.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: rawValue,
          Description: `Per-user agent credential ${name}`,
          Tags: [
            { Key: "Environment", Value: environment() },
            { Key: "ManagedBy", Value: "aistudio" },
            { Key: "OwnerEmail", Value: ownerEmail },
          ],
        })
      )
    } catch (error) {
      if (
        !(error instanceof ResourceExistsException) &&
        (!(error instanceof Error) ||
          error.name !== "ResourceExistsException")
      ) {
        throw error
      }
      await this.secrets.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: rawValue,
        })
      )
      action = "rotated"
    }
    await executeQuery(
      (db) =>
        db.insert(psdAgentCredentialsAudit).values({
          credentialName: name,
          scope: "user",
          action,
          details: { user_email: ownerEmail },
        }),
      "agentCredentialWriteAudit"
    )
    return { name, action }
  }

  async request(
    ownerEmail: string,
    rawName: unknown,
    rawReason: unknown,
    rawSkillContext: unknown
  ): Promise<number> {
    const name = credentialName(rawName)
    if (
      typeof rawReason !== "string" ||
      rawReason.trim().length === 0 ||
      rawReason.length > 2000
    ) {
      throw new AgentCredentialInputError("Invalid request reason")
    }
    if (
      rawSkillContext !== undefined &&
      rawSkillContext !== null &&
      (typeof rawSkillContext !== "string" ||
        rawSkillContext.length > 4000)
    ) {
      throw new AgentCredentialInputError("Invalid skill context")
    }
    const [created] = await executeQuery(
      (db) =>
        db
          .insert(psdAgentCredentialRequests)
          .values({
            credentialName: name,
            reason: rawReason.trim(),
            skillContext:
              typeof rawSkillContext === "string"
                ? rawSkillContext
                : null,
            requestedBy: ownerEmail,
          })
          .returning({ id: psdAgentCredentialRequests.id }),
      "agentCredentialRequest"
    )
    if (!created) throw new Error("Credential request insert returned no row")
    return created.id
  }

  async canAccessSkill(
    ownerEmail: string,
    rawCapability: unknown,
    rawSkillId: unknown
  ): Promise<boolean> {
    const capability =
      rawCapability === undefined || rawCapability === null
        ? null
        : typeof rawCapability === "string" &&
            SAFE_CAPABILITY_RE.test(rawCapability)
          ? rawCapability
          : (() => {
              throw new AgentCredentialInputError("Invalid capability")
            })()
    const skillId =
      rawSkillId === undefined || rawSkillId === null
        ? null
        : typeof rawSkillId === "string" && UUID_RE.test(rawSkillId)
          ? rawSkillId
          : (() => {
              throw new AgentCredentialInputError("Invalid skill id")
            })()
    if (!capability && !skillId) {
      throw new AgentCredentialInputError(
        "A capability or skill id is required"
      )
    }
    const result = await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT 1
          WHERE (
            ${capability}::text IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN role_capabilities rc ON rc.role_id = ur.role_id
              JOIN capabilities c ON c.id = rc.capability_id
              WHERE lower(u.email) = lower(${ownerEmail})
                AND c.identifier = ${capability}
                AND c.is_active = true
            )
          )
          OR (
            ${skillId}::text IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM resource_access_grants g
              WHERE g.resource_type = 'skill'
                AND g.resource_id = ${skillId}
                AND (
                  (
                    g.grant_kind = 'role'
                    AND EXISTS (
                      SELECT 1
                      FROM users u
                      JOIN user_roles ur ON ur.user_id = u.id
                      JOIN roles r ON r.id = ur.role_id
                      WHERE lower(u.email) = lower(${ownerEmail})
                        AND lower(r.name) = lower(g.grant_value)
                    )
                  )
                  OR (
                    g.grant_kind = 'group'
                    AND EXISTS (
                      SELECT 1
                      FROM groups grp
                      JOIN group_members gm ON gm.group_id = grp.id
                      WHERE grp.is_active = true
                        AND lower(grp.group_email) = lower(g.grant_value)
                        AND lower(gm.member_email) = lower(${ownerEmail})
                    )
                  )
                )
            )
          )
          LIMIT 1
        `),
      "agentSkillAccessCheck"
    )
    return toPgRows<Record<string, unknown>>(result).length > 0
  }
}
