/**
 * Per-owner workspace-token mint rate limit.
 *
 * The cap is generous because a token lasts about an hour and clients cache it.
 * The in-memory, per-task limit is defense in depth behind the internal shared
 * secret. It bounds abuse of one task; a fleet-wide guard would require shared
 * storage.
 */
const RATE_LIMIT_PER_HOUR = Number(process.env.AGENT_WORKSPACE_TOKEN_RATE_LIMIT) || 120
const RATE_WINDOW_MS = 60 * 60 * 1000
const mintWindow = new Map<string, { count: number; windowStart: number }>()

export function checkAgentWorkspaceTokenRateLimit(ownerEmail: string): boolean {
  const now = Date.now()
  const entry = mintWindow.get(ownerEmail)
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    mintWindow.set(ownerEmail, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT_PER_HOUR) return false
  entry.count += 1
  return true
}

export function getAgentWorkspaceTokenRateLimit(): number {
  return RATE_LIMIT_PER_HOUR
}

/** Test-only: clear the in-memory rate-limit window between tests. */
export function resetAgentWorkspaceTokenRateLimitForTests(): void {
  mintWindow.clear()
}
