/**
 * OAuth consent-decision consumption (server-only).
 *
 * Moved out of `actions/oauth/consent.actions.ts` (REV-COR-050): as an exported
 * function in a `"use server"` module it was a public, unauthenticated endpoint
 * that could destructively consume ANY user's pending consent decision by uid
 * (uids travel in browser URLs / logs / referrers). The legitimate consumer is
 * the OAuth interaction route handler acting on behalf of the OAuth flow — not a
 * logged-in browser session — so the correct fix is removing it from the action
 * surface, not gating it. `import "server-only"` makes a client import fail at
 * build time.
 */
import "server-only"

import { and, eq, gt } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { oauthConsentDecisions } from "@/lib/db/schema"

export interface ConsentDecision {
  approved: boolean
  userId: number
  scopes: string[]
  createdAt: number
}

/**
 * Atomically read-and-consume a consent decision (consume-once). A single
 * `DELETE ... WHERE uid = $1 AND expires_at > now() RETURNING *` guarantees two
 * concurrent readers can't both observe the row before either deletes it — the
 * previous SELECT-then-DELETE broke that guarantee (REV-COR-050). Returns
 * `undefined` when the uid is unknown or the decision has expired.
 */
export async function consumeConsentDecision(
  uid: string
): Promise<ConsentDecision | undefined> {
  const [decision] = await executeQuery(
    (db) =>
      db
        .delete(oauthConsentDecisions)
        .where(
          and(
            eq(oauthConsentDecisions.uid, uid),
            gt(oauthConsentDecisions.expiresAt, new Date())
          )
        )
        .returning(),
    "consumeConsentDecision"
  )

  if (!decision) return undefined

  return {
    approved: decision.approved,
    userId: decision.userId,
    scopes: decision.scopes as string[],
    createdAt: decision.createdAt.getTime(),
  }
}
