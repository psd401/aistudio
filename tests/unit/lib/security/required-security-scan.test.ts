import { runRequiredSecurityScan } from "@/lib/security/required-security-scan"

describe("required security scans", () => {
  it("returns a successful scan result", async () => {
    await expect(
      runRequiredSecurityScan(
        async () => ({ tokens: ["redacted"] }),
        jest.fn(),
        "blocked",
      ),
    ).resolves.toEqual({ tokens: ["redacted"] })
  })

  it("quarantines input when the scanner fails", async () => {
    const onFailure = jest.fn()
    await expect(
      runRequiredSecurityScan(
        async () => {
          throw new Error("provider unavailable")
        },
        onFailure,
        "Attachment privacy scan failed; the attachment was not processed",
      ),
    ).rejects.toThrow("Attachment privacy scan failed")
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "provider unavailable",
    }))
  })
})
