/**
 * One-off cleanup: delete EXPIRED per-user Cognito refresh-token secrets (#1902).
 *
 * AI Studio used to write `psd-agent-creds/{env}/user/{email}/cognito-refresh`
 * for every user on every sign-in, and nothing ever deleted them. At $0.40
 * per secret per month, prod held 438 of them on 2026-10-12, 313 never read.
 * The sign-in path is now update-only (`lib/auth/agent-token-sync.ts`), so no
 * new orphans appear — this script clears the ones already there.
 *
 * It only deletes secrets whose stored refresh token is ALREADY EXPIRED, i.e.
 * whose last write is older than the user pool's `RefreshTokenValidity`
 * (30 days in aistudio-prod) plus a 1-day margin. Never-read but still-valid
 * secrets are kept deliberately (Kris, 2026-10-12): deleting one would force
 * a working user back through the consent link.
 *
 * "Expired" is inferred from the secret's `LastChangedDate`, which holds only
 * because an active user re-mirrors their token on every Node-side sign-in —
 * and the 24h session max age (`DEFAULT_SESSION_MAX_AGE_SECONDS` in `auth.ts`)
 * forces one daily. Edge middleware refreshes never mirror. If `SESSION_MAX_AGE`
 * is ever raised past the pool's refresh validity, revisit this heuristic.
 * Each secret's timestamp is also re-read right before its delete, so one
 * rotated after the list was taken is kept.
 *
 * Deletion uses `ForceDeleteWithoutRecovery: true` on purpose:
 *   - A secret sitting in a recovery window makes `CreateSecret` fail with
 *     `InvalidRequestException` ("The secret is scheduled for deletion"), which
 *     would break the consent flow for that user for up to 30 days.
 *   - The ECS task role has no `secretsmanager:RestoreSecret`
 *     (`infra/lib/constructs/ecs-service.ts`), so the window is unusable anyway.
 *   - Restoring would only bring back an already-expired token.
 *
 * SAFETY: dry-run by default — prints the plan and touches nothing. Pass
 * `--apply` to actually delete. Neither mode prints an email or any part of
 * one: dry run lists each secret by a short SHA-256 of its email (compute
 * the same hash to check a specific user), `--apply` prints counts only.
 *
 * Run (Kris runs this himself — do NOT run it automatically; dev first):
 *   ENVIRONMENT=dev  AWS_REGION=us-east-1 bunx tsx scripts/agent-workspace/purge-expired-cognito-refresh-secrets.ts
 *   ENVIRONMENT=prod AWS_REGION=us-east-1 bunx tsx scripts/agent-workspace/purge-expired-cognito-refresh-secrets.ts --apply
 *
 * Flags:
 *   --apply               actually delete (default: dry run)
 *   --max-age-days <n>    expiry threshold in days (default 31 = 30-day pool
 *                         validity + 1 day margin)
 */

import { createHash } from "node:crypto"
import {
  SecretsManagerClient,
  ListSecretsCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ResourceNotFoundException,
  type SecretListEntry,
} from "@aws-sdk/client-secrets-manager"

const APPLY = process.argv.includes("--apply")
const ENV = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
const REGION = process.env.AWS_REGION ?? "us-east-1"

const DEFAULT_MAX_AGE_DAYS = 31
const DAY_MS = 24 * 60 * 60 * 1000

function parseMaxAgeDays(argv: string[]): number {
  const index = argv.indexOf("--max-age-days")
  if (index === -1) return DEFAULT_MAX_AGE_DAYS
  const raw = argv[index + 1]
  const parsed = Number(raw)
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `--max-age-days needs a positive number, got ${raw === undefined ? "nothing" : `"${raw}"`}`,
    )
  }
  return parsed
}

const PREFIX = `psd-agent-creds/${ENV}/user/`
const SUFFIX = "/cognito-refresh"

/**
 * True for `psd-agent-creds/{ENV}/user/{email}/cognito-refresh` and nothing
 * else. The `name` ListSecrets filter is not an anchored prefix match, so the
 * prefix, the suffix and the "exactly one path segment between" check are all
 * enforced here — otherwise a future `.../user/{email}/sub/path/cognito-refresh`
 * slot (or any name merely containing the prefix) would be swept too.
 */
function isUserCognitoRefreshSecret(name: string | undefined): name is string {
  if (!name) return false
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return false
  const middle = name.slice(PREFIX.length, name.length - SUFFIX.length)
  return middle.length > 0 && !middle.includes("/")
}

/**
 * Short, stable stand-in for a secret's email so a dry run against prod
 * prints no part of any address (a domain plus an initial can identify a
 * student). Check one user with:
 *   printf %s user@domain | shasum -a 256 | cut -c1-12
 */
function secretLabel(name: string | undefined): string {
  if (!name) return "(unnamed)"
  const email = name.slice(PREFIX.length, name.length - SUFFIX.length)
  return `user#${createHash("sha256").update(email).digest("hex").slice(0, 12)}`
}

/** Last time the secret VALUE changed, which is when the token was minted. */
function lastWrite(
  secret: Pick<SecretListEntry, "LastChangedDate" | "CreatedDate">,
): Date | null {
  return secret.LastChangedDate ?? secret.CreatedDate ?? null
}

async function listCandidates(
  sm: SecretsManagerClient,
): Promise<SecretListEntry[]> {
  const out: SecretListEntry[] = []
  let nextToken: string | undefined
  do {
    const page = await sm.send(
      new ListSecretsCommand({
        MaxResults: 100,
        NextToken: nextToken,
        Filters: [{ Key: "name", Values: [PREFIX] }],
      }),
    )
    for (const secret of page.SecretList ?? []) {
      if (isUserCognitoRefreshSecret(secret.Name)) out.push(secret)
    }
    nextToken = page.NextToken
  } while (nextToken)
  return out
}

type DeleteOutcome = "deleted" | "notFound" | "refreshed"

/**
 * Delete one secret, re-checking its timestamp first. The candidate list is a
 * snapshot; a large run takes minutes, and a user who signs in or completes
 * consent meanwhile rotates their secret. Re-reading right before the
 * irreversible delete means a freshly written token is never destroyed on
 * stale data.
 */
async function deleteIfStillExpired(
  sm: SecretsManagerClient,
  secretId: string | undefined,
  cutoff: Date,
): Promise<DeleteOutcome> {
  try {
    const current = await sm.send(new DescribeSecretCommand({ SecretId: secretId }))
    const written = lastWrite(current)
    if (!written || written >= cutoff) return "refreshed"
    await sm.send(
      new DeleteSecretCommand({ SecretId: secretId, ForceDeleteWithoutRecovery: true }),
    )
    return "deleted"
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return "notFound"
    throw err
  }
}

async function deleteExpired(
  sm: SecretsManagerClient,
  expired: SecretListEntry[],
  cutoff: Date,
) {
  const counts = { deleted: 0, notFound: 0, refreshed: 0, failed: 0 }
  for (const [index, secret] of expired.entries()) {
    try {
      counts[await deleteIfStillExpired(sm, secret.ARN ?? secret.Name, cutoff)]++
    } catch (err) {
      counts.failed++
      // Name is intentionally omitted in --apply mode; the ARN suffix is
      // enough to find the row in CloudTrail without printing the email.
      console.error(
        `  FAILED to delete secret ${index + 1} of ${expired.length}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return counts
}

async function main() {
  const maxAgeDays = parseMaxAgeDays(process.argv)
  const cutoff = new Date(Date.now() - maxAgeDays * DAY_MS)
  const sm = new SecretsManagerClient({ region: REGION })

  console.log(
    `[purge-cognito-refresh] env=${ENV} region=${REGION} apply=${APPLY} maxAgeDays=${maxAgeDays} cutoff=${cutoff.toISOString()}`,
  )

  const candidates = await listCandidates(sm)
  const expired: SecretListEntry[] = []
  let kept = 0
  let undated = 0

  for (const secret of candidates) {
    const written = lastWrite(secret)
    if (!written) {
      // No timestamp at all — we cannot prove the token is expired, so keep it.
      undated++
      continue
    }
    if (written < cutoff) expired.push(secret)
    else kept++
  }

  console.log(
    `[purge-cognito-refresh] ${candidates.length} cognito-refresh secret(s): ${expired.length} expired, ${kept} still within validity, ${undated} with no timestamp (kept)`,
  )

  if (!APPLY) {
    for (const secret of expired) {
      console.log(
        `  DRY-RUN would delete ${secretLabel(secret.Name)} (last written ${lastWrite(secret)?.toISOString()})`,
      )
    }
    console.log(
      `[purge-cognito-refresh] dry run complete — re-run with --apply to execute`,
    )
    return
  }

  const { deleted, notFound, refreshed, failed } = await deleteExpired(
    sm,
    expired,
    cutoff,
  )

  console.log(
    `[purge-cognito-refresh] done — deleted=${deleted} alreadyGone=${notFound} rewrittenSinceList=${refreshed} failed=${failed}`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(
    "[purge-cognito-refresh] fatal:",
    err instanceof Error ? err.message : String(err),
  )
  process.exit(1)
})
