/**
 * Which conversation's bound workspace panel this tab is still restoring
 * (#1791).
 *
 * Reopening `/nexus?id=…` restores the artifact panel through an async lookup
 * that runs after the chat runtime has mounted. A message sent inside that
 * window carries no `workspaceId`, so the turn would run without the artifact
 * tools. While a restore is pending, the chat request asks the server to use
 * the persisted binding instead (`restoreBoundWorkspace`).
 *
 * Module-level on purpose, like `lib/atrium/artifact-preview-diagnostics.ts`:
 * the restore hook and the runtime's request body are separate parts of the
 * page, and threading one flag through every runtime prop layer would change
 * the runtime's documented stable-identity wiring
 * (docs/features/nexus-conversation-architecture.md). Keyed by conversation
 * id, so a flag can never leak into a different conversation.
 */

let pendingConversationId: string | null = null;

/** Called when the restore lookup for `conversationId` starts. */
export function markWorkspaceRestorePending(conversationId: string): void {
  pendingConversationId = conversationId;
}

/** Called when that lookup settles (found, not found, or failed). */
export function settleWorkspaceRestore(conversationId: string): void {
  if (pendingConversationId === conversationId) pendingConversationId = null;
}

/** True while `conversationId`'s panel restore has not settled. */
export function isWorkspaceRestorePending(
  conversationId: string | null | undefined
): boolean {
  return !!conversationId && pendingConversationId === conversationId;
}
