import * as crypto from 'node:crypto';

/**
 * Must remain byte-for-byte compatible with agent-router's ownerSessionId().
 * The Lambdas are bundled independently, so a shared runtime import is not
 * available in production.
 */
export function ownerRuntimeSessionId(
  workspacePrefix: string,
  buildTag: string,
): string {
  const scopeHash = crypto
    .createHash('sha256')
    .update(`${workspacePrefix}\0workspace:${workspacePrefix}`)
    .digest('hex');
  const buildHash = crypto
    .createHash('sha256')
    .update(buildTag || 'unset')
    .digest('hex')
    .slice(0, 24);
  // Keep this compact form byte-identical with the router. AgentCore rejects
  // runtime session ids longer than 100 characters; "agent-rt" yields 98.
  return `agent-rt-${scopeHash}-${buildHash}`;
}

/**
 * Must remain byte-for-byte compatible with agent-router's
 * ownerWorkspaceLockId(). Unlike runtime affinity, this mutex never rotates
 * during deploys: an old and a new microVM must not checkpoint the same
 * workspace concurrently.
 */
export function ownerWorkspaceLockId(workspacePrefix: string): string {
  const workspaceHash = crypto
    .createHash('sha256')
    .update(`owner-workspace-lock\0${workspacePrefix}`)
    .digest('hex');
  return `agent-workspace-${workspaceHash}`;
}

/** One logical OpenClaw transcript per schedule per UTC calendar day. */
export function scheduledConversationSessionId(
  workspacePrefix: string,
  scheduleId: string,
  dateKey: string,
): string {
  const prefix = workspacePrefix.substring(0, 40);
  return `${prefix}-sched-${scheduleId.substring(0, 12)}-${dateKey}`;
}
