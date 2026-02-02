/**
 * MCP Session Manager
 * In-memory session tracking with TTL for MCP protocol compliance.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * MCP sessions are primarily stateless (auth per-request). This manager
 * tracks initialization state for protocol compliance (e.g., refusing
 * tools/call before initialize).
 */

import { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

interface McpSession {
  sessionId: string
  userId: number
  protocolVersion: string
  clientInfo: { name: string; version: string }
  createdAt: number
  lastAccessAt: number
}

// ============================================
// Constants
// ============================================

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_SESSIONS = 10000

// ============================================
// Session Store
// ============================================

const sessions = new Map<string, McpSession>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    const log = createLogger({ action: "mcp.session.cleanup" })
    let removed = 0

    for (const [id, session] of sessions) {
      if (now - session.lastAccessAt > SESSION_TTL_MS) {
        sessions.delete(id)
        removed++
      }
    }

    if (removed > 0) {
      log.info("Cleaned up expired MCP sessions", { removed, remaining: sessions.size })
    }
  }, CLEANUP_INTERVAL_MS)

  // Don't prevent process exit
  if (cleanupTimer.unref) {
    cleanupTimer.unref()
  }
}

// ============================================
// Public API
// ============================================

export function createSession(
  sessionId: string,
  userId: number,
  protocolVersion: string,
  clientInfo: { name: string; version: string }
): McpSession {
  ensureCleanup()

  // Enforce max sessions
  if (sessions.size >= MAX_SESSIONS) {
    evictOldest()
  }

  const session: McpSession = {
    sessionId,
    userId,
    protocolVersion,
    clientInfo,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
  }

  sessions.set(sessionId, session)
  return session
}

export function getSession(sessionId: string): McpSession | null {
  const session = sessions.get(sessionId)
  if (!session) return null

  // Check TTL
  if (Date.now() - session.lastAccessAt > SESSION_TTL_MS) {
    sessions.delete(sessionId)
    return null
  }

  session.lastAccessAt = Date.now()
  return session
}

export function removeSession(sessionId: string): boolean {
  return sessions.delete(sessionId)
}

export function getSessionCount(): number {
  return sessions.size
}

// ============================================
// Internal
// ============================================

function evictOldest(): void {
  let oldestId: string | null = null
  let oldestTime = Infinity

  for (const [id, session] of sessions) {
    if (session.lastAccessAt < oldestTime) {
      oldestTime = session.lastAccessAt
      oldestId = id
    }
  }

  if (oldestId) {
    sessions.delete(oldestId)
  }
}
