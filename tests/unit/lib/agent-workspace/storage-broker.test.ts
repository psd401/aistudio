import {
  ownerWorkspaceKey,
  publicArtifactKey,
  validateWorkspaceRelativePath,
  workspaceReservationCountsAsRetained,
  workspaceReservationExpiresByLease,
  workspacePublicReconciliationCutoff,
  workspaceRetainedQuotaReason,
} from "@/lib/agent-workspace/storage-broker"

describe("owner-bound workspace storage keys", () => {
  it("derives every private key beneath the signed prefix", () => {
    expect(ownerWorkspaceKey("users/hagelk", "memory/notes.md")).toBe(
      "users/hagelk/memory/notes.md"
    )
  })

  it.each([
    "../victim/secret",
    "/absolute",
    "safe/../../victim",
    "safe/\u0000bad",
    "trailing/",
  ])("rejects path escape %s", (path) => {
    expect(() => validateWorkspaceRelativePath(path)).toThrow(
      "Invalid workspace-relative path"
    )
  })

  it("uses a one-way owner namespace for public artifacts", () => {
    const key = publicArtifactKey("HagelK@PSD401.NET", "chart.png")
    expect(key).toMatch(/^public-images\/[a-f0-9]{24}\/chart\.png$/)
    expect(key).not.toContain("hagelk")
  })

  it("rejects executable public artifacts", () => {
    expect(() => publicArtifactKey("hagelk@psd401.net", "payload.js")).toThrow(
      "not allowed"
    )
  })

  it("bounds retained objects independently of bytes", () => {
    expect(workspaceRetainedQuotaReason(0, 999, 1, true)).toBeNull()
    expect(workspaceRetainedQuotaReason(0, 1_000, 1, true)).toBe(
      "retained_objects",
    )
  })

  it("never lease-expires verifying cleanup debt", () => {
    expect(workspaceReservationExpiresByLease("reserved")).toBe(true)
    expect(workspaceReservationExpiresByLease("verifying")).toBe(false)
    expect(workspaceReservationCountsAsRetained("verifying")).toBe(true)
  })

  it("keeps public commits charged until exact-version cleanup is proven", () => {
    expect(workspaceReservationExpiresByLease("committed")).toBe(false)
    expect(workspaceReservationCountsAsRetained("committed")).toBe(true)
    expect(workspaceReservationCountsAsRetained("superseded")).toBe(false)
  })

  it("waits through both public lifecycle stages plus a safety margin", () => {
    expect(
      workspacePublicReconciliationCutoff(
        new Date("2026-07-26T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-06-17T00:00:00.000Z")
  })
})
