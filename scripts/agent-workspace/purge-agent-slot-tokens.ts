/**
 * One-off cleanup: purge agent-slot Google Workspace refresh tokens (#1232).
 *
 * The agent-slot OAuth consent flow is retired — agent access tokens are now
 * minted on demand by the DWD broker, and NO agent-slot refresh token should
 * exist. At least one stored agent-slot token is known to actually hold a
 * HUMAN's refresh token (the callback-validation bug, #1234), so leaving them
 * in place is an active attribution/security hazard.
 *
 * This script, for every `agent_account` row in the psd_agent_workspace_tokens
 * manifest:
 *   1. deletes the Secrets Manager secret
 *      psd-agent-creds/{env}/user/{email}/google-workspace (force, no recovery), and
 *   2. marks the manifest row `revoked` (revokedAt = now).
 *
 * SAFETY: dry-run by default — prints the plan and touches nothing. Pass
 * `--apply` to actually delete + update.
 *
 * Run (Kris runs this himself — do NOT run it automatically):
 *   ENVIRONMENT=dev  AWS_REGION=us-east-1 DATABASE_URL=... bunx tsx scripts/agent-workspace/purge-agent-slot-tokens.ts
 *   ENVIRONMENT=prod AWS_REGION=us-east-1 DATABASE_URL=... bunx tsx scripts/agent-workspace/purge-agent-slot-tokens.ts --apply
 */

import { and, eq } from "drizzle-orm"
import { SecretsManagerClient, DeleteSecretCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { workspaceSecretId } from "@/lib/agent/workspace-token"

const APPLY = process.argv.includes("--apply")
const ENV = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
const REGION = process.env.AWS_REGION ?? "us-east-1"

async function main() {
  const sm = new SecretsManagerClient({ region: REGION })

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: psdAgentWorkspaceTokens.id,
          ownerUserId: psdAgentWorkspaceTokens.ownerUserId,
          ownerEmail: psdAgentWorkspaceTokens.ownerEmail,
          status: psdAgentWorkspaceTokens.status,
        })
        .from(psdAgentWorkspaceTokens)
        .where(eq(psdAgentWorkspaceTokens.tokenKind, "agent_account")),
    "purgeAgentSlot.listRows"
  )

  console.log(`[purge-agent-slot] env=${ENV} region=${REGION} apply=${APPLY}`)
  console.log(`[purge-agent-slot] ${rows.length} agent_account manifest row(s) to process`)

  let deleted = 0
  let notFound = 0
  let failed = 0

  for (const row of rows) {
    const secretId = workspaceSecretId(row.ownerEmail, ENV, "agent_account")
    if (!APPLY) {
      console.log(`  DRY-RUN would delete secret ${secretId} + revoke manifest row ${row.id} (${row.ownerEmail}, status=${row.status})`)
      continue
    }
    try {
      await sm.send(new DeleteSecretCommand({ SecretId: secretId, ForceDeleteWithoutRecovery: true }))
      deleted++
      console.log(`  deleted secret ${secretId}`)
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        notFound++
      } else {
        failed++
        console.error(`  FAILED to delete ${secretId}: ${err instanceof Error ? err.message : String(err)}`)
        continue // leave the manifest row alone if the secret delete failed
      }
    }
    await executeQuery(
      (db) =>
        db
          .update(psdAgentWorkspaceTokens)
          .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(psdAgentWorkspaceTokens.id, row.id),
              eq(psdAgentWorkspaceTokens.tokenKind, "agent_account")
            )
          ),
      "purgeAgentSlot.revokeRow"
    )
  }

  if (APPLY) {
    console.log(`[purge-agent-slot] done — secrets deleted=${deleted} alreadyGone=${notFound} failed=${failed}`)
  } else {
    console.log(`[purge-agent-slot] dry run complete — re-run with --apply to execute`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[purge-agent-slot] fatal:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
