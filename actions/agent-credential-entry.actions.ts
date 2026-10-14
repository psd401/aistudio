"use server"

/**
 * Server action behind the one-time credential entry page (issue #1887).
 *
 * The secret arrives as a server-action argument — i.e. in the POST body of
 * the RPC — so it never lands in a URL, a query string, or the chat
 * transcript. It is handed straight to the credential broker and is never
 * logged, echoed back, or returned to the client.
 */

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { createSuccess, handleError } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import {
  submitCredentialEntry,
  type CredentialEntrySubmission,
} from "@/lib/agent-workspace/credential-entry"

export async function storeCredentialFromEntryLink(
  token: string,
  value: string
): Promise<ActionState<CredentialEntrySubmission>> {
  const requestId = generateRequestId()
  const timer = startTimer("storeCredentialFromEntryLink")
  const log = createLogger({ requestId, action: "storeCredentialFromEntryLink" })

  try {
    // Deliberately no `params` log line: every argument of this action is
    // either the link token or the secret itself.
    log.info("Credential entry submission started")

    const session = await getServerSession()
    const outcome = await submitCredentialEntry({
      token,
      sessionEmail: session?.email ?? null,
      value,
    })

    timer({ status: outcome.status === "stored" ? "success" : "refused" })
    log.info("Credential entry submission finished", { outcome: outcome.status })
    return createSuccess(outcome, "Credential entry processed")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Could not store that credential", {
      context: "storeCredentialFromEntryLink",
      requestId,
      operation: "storeCredentialFromEntryLink",
    })
  }
}
