import {
  ownerWorkspaceKey,
  publicArtifactKey,
  validateWorkspaceRelativePath,
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
})
