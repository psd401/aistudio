"use server"

/**
 * Read the durable conversation <-> workspace binding (#1791 finding 1).
 *
 * Two reads, one per direction:
 *  - `getConversationWorkspaceAction` — the object a conversation worked on, so
 *    reopening `/nexus?id=<id>` restores the workspace panel instead of showing
 *    a chat whose model has lost its tools and whose author has lost the
 *    preview.
 *  - `findWorkspaceConversationAction` — the user's most recent chat about an
 *    object, so the editor's "Ask the agent" and "Open beside chat" land in the
 *    conversation that already knows the artifact rather than a fresh one that
 *    re-runs every table listing and schema probe.
 *
 * Both are scoped to the CALLER's own conversations in the query predicate.
 * A conversation is private to the person who had it, and neither action will
 * tell anyone that somebody else has one: a miss and a not-yours both return
 * `null`, so no caller can use these to probe for the existence of a
 * conversation id or to learn who else has worked on an artifact.
 *
 * No `atrium-content` capability check: these read NOTHING about the object
 * itself — not its title, not its body, not even whether it exists. They map an
 * id the caller already holds to one of the caller's own conversation ids.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import {
  findLatestConversationForWorkspace,
  getConversationWorkspaceObjectId,
} from "@/lib/nexus/workspace-conversation-binding"
import type { ActionState } from "@/types"

/** Resolve the caller's numeric user id, or throw the right auth error. */
async function requireUserId(
  log: ReturnType<typeof createLogger>
): Promise<number> {
  const session = await getServerSession()
  if (!session) {
    log.warn("Unauthorized")
    throw ErrorFactories.authNoSession()
  }
  const currentUser = await getCurrentUserAction()
  if (!currentUser.isSuccess) {
    log.error("Failed to get current user")
    throw ErrorFactories.authNoSession()
  }
  return currentUser.data.user.id
}

/**
 * The Atrium object id this conversation worked on, or null when it has no
 * binding — or is not the caller's.
 */
export async function getConversationWorkspaceAction(
  conversationId: string
): Promise<ActionState<{ workspaceObjectId: string | null }>> {
  const requestId = generateRequestId()
  const timer = startTimer("getConversationWorkspace")
  const log = createLogger({ requestId, action: "getConversationWorkspace" })

  try {
    log.info("Action started", {
      conversationId: sanitizeForLogging(conversationId),
    })
    const userId = await requireUserId(log)
    const workspaceObjectId = await getConversationWorkspaceObjectId({
      conversationId,
      userId,
    })
    timer({ status: "success" })
    return createSuccess({ workspaceObjectId }, "Workspace binding resolved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Could not resolve the workspace binding", {
      context: "getConversationWorkspaceAction",
      requestId,
      operation: "getConversationWorkspaceAction",
    })
  }
}

/**
 * The caller's most recent (non-archived) conversation about this object, or
 * null when they have never chatted about it.
 */
export async function findWorkspaceConversationAction(
  workspaceObjectId: string
): Promise<ActionState<{ conversationId: string | null }>> {
  const requestId = generateRequestId()
  const timer = startTimer("findWorkspaceConversation")
  const log = createLogger({ requestId, action: "findWorkspaceConversation" })

  try {
    log.info("Action started", {
      workspaceObjectId: sanitizeForLogging(workspaceObjectId),
    })
    const userId = await requireUserId(log)
    const conversationId = await findLatestConversationForWorkspace({
      workspaceObjectId,
      userId,
    })
    timer({ status: "success" })
    return createSuccess({ conversationId }, "Workspace conversation resolved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Could not find a conversation for this item", {
      context: "findWorkspaceConversationAction",
      requestId,
      operation: "findWorkspaceConversationAction",
    })
  }
}
