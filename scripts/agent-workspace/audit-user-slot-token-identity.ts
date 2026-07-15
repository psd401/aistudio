/**
 * One-off audit + remediation: verify stored user-slot Workspace tokens belong
 * to the expected account (#1234).
 *
 * Before the callback started verifying the granted id_token, a consent link
 * completed with the WRONG Google account stored that other account's refresh
 * token in the owner's slot. This script audits every `user_account` row in the
 * psd_agent_workspace_tokens manifest:
 *   1. mints a fresh access token from the stored refresh token,
 *   2. fetches Google userinfo, and
 *   3. compares the verified email against the manifest's ownerEmail.
 *
 * On a mismatch (or an unverified email) with `--apply`, it deletes the
 * user-slot secret and marks the manifest row `revoked` so the user re-consents
 * (now guarded by the id_token check). Read-only mismatches are always reported.
 *
 * The agent slot is NOT audited here — #1232's purge-agent-slot-tokens.ts
 * deletes every agent-slot token outright, which supersedes an identity check.
 *
 * SAFETY: dry-run by default. Pass `--apply` to delete + revoke mismatches.
 *
 * Run (Kris runs this himself — do NOT run it automatically):
 *   ENVIRONMENT=dev  AWS_REGION=us-east-1 DATABASE_URL=... bunx tsx scripts/agent-workspace/audit-user-slot-token-identity.ts
 *   ENVIRONMENT=prod AWS_REGION=us-east-1 DATABASE_URL=... bunx tsx scripts/agent-workspace/audit-user-slot-token-identity.ts --apply
 */

import { and, eq } from "drizzle-orm"
import { SecretsManagerClient, DeleteSecretCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { getFreshAccessTokenForUser, workspaceSecretId } from "@/lib/agent/workspace-token"

const APPLY = process.argv.includes("--apply")
const ENV = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
const REGION = process.env.AWS_REGION ?? "us-east-1"

interface UserInfo {
  email?: string
  email_verified?: boolean
}

async function fetchUserInfo(accessToken: string): Promise<UserInfo | null> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  return (await res.json()) as UserInfo
}

async function main() {
  const sm = new SecretsManagerClient({ region: REGION })

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: psdAgentWorkspaceTokens.id,
          ownerEmail: psdAgentWorkspaceTokens.ownerEmail,
          status: psdAgentWorkspaceTokens.status,
        })
        .from(psdAgentWorkspaceTokens)
        .where(eq(psdAgentWorkspaceTokens.tokenKind, "user_account")),
    "auditUserSlot.listRows"
  )

  console.log(`[audit-user-slot] env=${ENV} region=${REGION} apply=${APPLY}`)
  console.log(`[audit-user-slot] auditing ${rows.length} user_account row(s)`)

  let ok = 0
  let mismatch = 0
  let unverified = 0
  let noToken = 0
  let errored = 0
  let remediated = 0

  for (const row of rows) {
    const expected = row.ownerEmail.toLowerCase()
    try {
      const fresh = await getFreshAccessTokenForUser(row.ownerEmail, ENV, "user_account", REGION)
      if (!fresh) {
        noToken++
        console.log(`  SKIP  ${row.ownerEmail} — no stored user-slot token`)
        continue
      }
      const info = await fetchUserInfo(fresh.access_token)
      if (!info?.email) {
        errored++
        console.log(`  ERROR ${row.ownerEmail} — userinfo returned no email`)
        continue
      }
      const granted = info.email.toLowerCase()
      const verified = info.email_verified === true
      if (granted === expected && verified) {
        ok++
        continue
      }

      if (!verified && granted === expected) {
        unverified++
        console.log(`  UNVERIFIED ${row.ownerEmail} — email present but email_verified=false`)
      } else {
        mismatch++
        console.log(`  MISMATCH  slot owner=${expected}  stored token belongs to=${granted}`)
      }

      if (APPLY) {
        const secretId = workspaceSecretId(row.ownerEmail, ENV, "user_account")
        try {
          await sm.send(new DeleteSecretCommand({ SecretId: secretId, ForceDeleteWithoutRecovery: true }))
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) throw err
        }
        await executeQuery(
          (db) =>
            db
              .update(psdAgentWorkspaceTokens)
              .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(psdAgentWorkspaceTokens.id, row.id),
                  eq(psdAgentWorkspaceTokens.tokenKind, "user_account")
                )
              ),
          "auditUserSlot.revokeRow"
        )
        remediated++
        console.log(`    -> deleted secret + marked row ${row.id} revoked (user must re-consent)`)
      }
    } catch (err) {
      errored++
      console.error(`  ERROR ${row.ownerEmail}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(
    `[audit-user-slot] done — ok=${ok} mismatch=${mismatch} unverified=${unverified} noToken=${noToken} errored=${errored}` +
      (APPLY ? ` remediated=${remediated}` : ` (dry run — re-run with --apply to purge mismatches)`)
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[audit-user-slot] fatal:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
