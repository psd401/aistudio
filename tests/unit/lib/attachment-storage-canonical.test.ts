import {
  buildAttachmentStoragePayload,
  type AttachmentContent,
} from "@/lib/services/attachment-storage-service"
import { NexusInlineAttachmentValidationError } from "@/lib/nexus/inline-attachment-security"

describe("attachment storage canonical payload", () => {
  it("stores the one canonical data value", () => {
    expect(
      buildAttachmentStoragePayload({
        type: "document",
        data: "approved body",
        name: "source.txt",
      })
    ).toEqual({
      type: "document",
      data: "approved body",
      name: "source.txt",
      contentType: undefined,
    })
  })

  it("rejects ambiguous content/data instead of selecting an unscanned value", () => {
    const attachment = {
      type: "document",
      content: "scanned",
      data: "secret sink value",
    } satisfies AttachmentContent
    expect(() => buildAttachmentStoragePayload(attachment)).toThrow(
      NexusInlineAttachmentValidationError
    )
  })
})
