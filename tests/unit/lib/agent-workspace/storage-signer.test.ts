/** @jest-environment node */

import {
  resetWorkspaceStorageClientForTests,
  signUploadReservation,
} from "@/lib/agent-workspace/storage-broker"

describe("workspace upload signer", () => {
  it("binds length, MIME type, and checksum with the real AWS signer", async () => {
    process.env.NODE_ENV = "test"
    process.env.AWS_REGION = "us-east-1"
    process.env.AWS_ACCESS_KEY_ID = "AKIATESTSIGNERONLY"
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-access-key"
    process.env.AGENT_WORKSPACE_BUCKET = "workspace-bucket"
    resetWorkspaceStorageClientForTests()

    const signed = await signUploadReservation({
      reservationId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
      stagingKey: ".upload-staging/private/owner/reservation",
      contentLength: 4,
      checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      contentType: "text/plain",
    })

    expect(
      new URL(signed.uploadUrl).searchParams.get("X-Amz-SignedHeaders"),
    ).toBe("content-length;content-type;host;x-amz-checksum-sha256")
    expect(signed.requiredHeaders).toEqual({
      "Content-Length": "4",
      "Content-Type": "text/plain",
      "x-amz-checksum-sha256":
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    })
  })
})
