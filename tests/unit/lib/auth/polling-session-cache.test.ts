/**
 * @jest-environment node
 *
 * Polling session cache key + invalidation (REV-COR-512 / REV-SEC-165 / REV-SEC-181).
 * The key must be deterministic (no Date.now()) so the cache actually hits, and the
 * producer + invalidator must derive it through one shared builder so invalidation
 * matches the stored entry.
 */
import {
  PollingSessionCache,
  pollingSessionCache,
  generateSessionCacheKey,
  sessionCacheKeyForSub,
} from "@/lib/auth/polling-session-cache"
import { invalidateUserSessions } from "@/lib/auth/optimized-polling-auth"

type SessionArg = Parameters<typeof generateSessionCacheKey>[0]
const makeSession = (sub: string): SessionArg =>
  ({ sub, email: `${sub}@example.com` } as unknown as SessionArg)

describe("polling session cache (REV-COR-512 / SEC-165 / SEC-181)", () => {
  it("does not keep a Node process alive solely for cache cleanup", () => {
    const cache = new PollingSessionCache({ cleanupInterval: 60_000 })
    const timer = (
      cache as unknown as { cleanupTimer?: NodeJS.Timeout }
    ).cleanupTimer

    expect(timer?.hasRef()).toBe(false)
    cache.destroy()
  })

  it("generates a deterministic, Date.now()-free key for the same session", () => {
    const s = makeSession("user-1")
    expect(generateSessionCacheKey(s)).toBe(generateSessionCacheKey(s))
    expect(generateSessionCacheKey(s)).toBe("session:user-1")
  })

  it("producer and invalidator derive the key from one shared builder", () => {
    const s = makeSession("user-2")
    expect(generateSessionCacheKey(s)).toBe(sessionCacheKeyForSub("user-2"))
  })

  it("invalidateUserSessions clears the entry stored via generateSessionCacheKey", () => {
    const s = makeSession("user-3")
    const key = generateSessionCacheKey(s)
    pollingSessionCache.setCachedSession(key, s as never, 3, ["student"])
    expect(pollingSessionCache.getCachedSession(key)).not.toBeNull()

    invalidateUserSessions("user-3")

    expect(pollingSessionCache.getCachedSession(key)).toBeNull()
  })
})
