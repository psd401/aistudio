/**
 * @jest-environment node
 *
 * The monitor now imports the leaf pollingSessionCache directly to break the
 * optimized-polling-auth ↔ auth-performance-monitor cycle (REV-ARCH-004); the
 * getPerformanceSummary() output — including the caching block from the cache
 * stats — must be unchanged.
 */
import { authPerformanceMonitor } from "@/lib/monitoring/auth-performance-monitor"

describe("authPerformanceMonitor.getPerformanceSummary (REV-ARCH-004)", () => {
  it("still returns a caching block populated from the cache stats", () => {
    const summary = authPerformanceMonitor.getPerformanceSummary()
    expect(summary).toHaveProperty("authentication")
    expect(summary).toHaveProperty("caching")
    expect(typeof summary.caching).toBe("object")
    // getStats() fields + effectivenessScore added by the summary
    expect(summary.caching).toHaveProperty("effectivenessScore")
  })
})
