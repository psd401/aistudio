/** @jest-environment node */

/**
 * Regression for the Atrium asset upload 403 (agent_failures 435).
 *
 * `signedAssetUploadUrl` binds ChecksumSHA256 into the PutObjectCommand, so the
 * uploader sends `x-amz-checksum-sha256` as a request header. If the presigner
 * hoists that into the query string instead of signing it, S3 rejects every PUT
 * with `AccessDenied — There were headers present in the request which were not
 * signed / HeadersNotSigned: x-amz-checksum-sha256`.
 *
 * These assertions run the real presigner (no mock of getSignedUrl) so the
 * signature actually has to cover the header.
 */

const mockGetS3 = jest.fn()

jest.mock("@/lib/settings-manager", () => ({
  Settings: { getS3: () => mockGetS3() },
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

describe("Atrium signed asset upload URL", () => {
  let signedUrl: URL

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= "AKIAIOSFODNN7EXAMPLE"
    process.env.AWS_SECRET_ACCESS_KEY ??=
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    process.env.AWS_REGION ??= "us-east-1"
    mockGetS3.mockResolvedValue({ bucket: "atrium-test", region: "us-east-1" })

    const { s3Store } = await import("@/lib/content/storage/s3-store")
    signedUrl = new URL(
      await s3Store.signedAssetUploadUrl({
        key: "atrium/objects/obj-1/assets/a.png",
        contentType: "image/png",
        contentLength: 1234,
        checksumSha256: "3q2+7w==",
      }),
    )
  })

  function signedHeaders(): string[] {
    return (signedUrl.searchParams.get("X-Amz-SignedHeaders") ?? "")
      .split(";")
      .filter(Boolean)
  }

  it("signs the checksum header instead of hoisting it to the query string", () => {
    expect(signedHeaders()).toContain("x-amz-checksum-sha256")
    // Hoisted would mean it travels as a query param and is not covered by the
    // signature — that is the exact shape that produced the 403.
    expect(signedUrl.searchParams.has("x-amz-checksum-sha256")).toBe(false)
  })

  it("signs content-type, which the uploader also sends", () => {
    expect(signedHeaders()).toContain("content-type")
  })

  it("still produces a usable presigned PUT", () => {
    expect(signedUrl.pathname).toContain("atrium/objects/obj-1/assets/a.png")
    expect(signedUrl.searchParams.get("X-Amz-Algorithm")).toBe(
      "AWS4-HMAC-SHA256",
    )
    expect(Number(signedUrl.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(0)
  })
})
