const mockResolveNexusAttachmentReference = jest.fn();

jest.mock("@/lib/nexus/ephemeral-repository-service", () => ({
  resolveNexusAttachmentReference: (...args: unknown[]) =>
    mockResolveNexusAttachmentReference(...args),
}));

import {
  NexusAttachmentTurnLimitError,
  preflightNexusAttachmentReferences,
} from "@/lib/nexus/request-attachment-preflight";
import { canonicalizeInlineAttachmentMessages } from "@/lib/nexus/inline-attachment-security";

const BINDING_ID = "123e4567-e89b-42d3-a456-426614174000";

function marker(itemId: number, name = "source.pdf"): string {
  return `[[repository-attachment:v1:${BINDING_ID}:${itemId}:${name}]]`;
}

describe("preflightNexusAttachmentReferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves only the current user turn and requires retrieval for documents", async () => {
    mockResolveNexusAttachmentReference.mockResolvedValue({
      bindingId: BINDING_ID,
      itemId: 2,
      itemType: "document",
    });

    const result = await preflightNexusAttachmentReferences({
      ownerId: 7,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: marker(1, "old.pdf") }],
        },
        { role: "assistant", parts: [{ type: "text", text: "Earlier answer" }] },
        {
          role: "user",
          parts: [{ type: "text", text: marker(2, "current.pdf") }],
        },
      ],
    });

    expect(mockResolveNexusAttachmentReference).toHaveBeenCalledTimes(1);
    expect(mockResolveNexusAttachmentReference).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId: BINDING_ID,
      itemId: 2,
    });
    expect(result).toMatchObject({
      references: [{ bindingId: BINDING_ID, itemId: 2 }],
      requiresAttachmentTools: true,
    });
  });

  it("keeps retrieval available when an image marker also has inline pixels", async () => {
    mockResolveNexusAttachmentReference.mockResolvedValue({
      bindingId: BINDING_ID,
      itemId: 3,
      itemType: "image",
    });

    const result = await preflightNexusAttachmentReferences({
      ownerId: 7,
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: `Restyle this\n${marker(3, "photo.png")}` },
            { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      ],
    });

    expect(result?.requiresAttachmentTools).toBe(true);
  });

  it("does not let unrelated or reordered inline pixels suppress retrieval", async () => {
    mockResolveNexusAttachmentReference.mockResolvedValue({
      bindingId: BINDING_ID,
      itemId: 3,
      itemType: "image",
    });

    const result = await preflightNexusAttachmentReferences({
      ownerId: 7,
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "image",
              image: "data:image/png;base64,unrelated-image-bytes",
            },
            { type: "text", text: marker(3, "photo.png") },
          ],
        },
      ],
    });

    expect(result?.requiresAttachmentTools).toBe(true);
  });

  it("returns one non-disclosing null result for a missing or foreign reference", async () => {
    mockResolveNexusAttachmentReference.mockResolvedValue(null);

    await expect(
      preflightNexusAttachmentReferences({
        ownerId: 7,
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: marker(9) }],
          },
        ],
      })
    ).resolves.toBeNull();
  });

  it("rejects more than twenty attachments before resolving any reference", async () => {
    const parts = Array.from({ length: 21 }, (_, index) => ({
      type: "text",
      text: marker(index + 1, `source-${index + 1}.pdf`),
    }));

    await expect(
      preflightNexusAttachmentReferences({
        ownerId: 7,
        messages: [{ role: "user", parts }],
      })
    ).rejects.toBeInstanceOf(NexusAttachmentTurnLimitError);
    expect(mockResolveNexusAttachmentReference).not.toHaveBeenCalled();
  });

  it("applies one combined limit to repository and inline attachments", async () => {
    const parts = Array.from({ length: 19 }, (_, index) => ({
      type: "text",
      text: marker(index + 1, `source-${index + 1}.pdf`),
    }));

    await expect(
      preflightNexusAttachmentReferences({
        ownerId: 7,
        messages: [{ role: "user", parts }],
        additionalAttachmentCount: 2,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentTurnLimitError);
    expect(mockResolveNexusAttachmentReference).not.toHaveBeenCalled();
  });

  it("counts inline attachments normalized from legacy message content", async () => {
    const canonical = canonicalizeInlineAttachmentMessages([
      {
        role: "user",
        content: Array.from({ length: 21 }, (_, index) => ({
          type: "document",
          data: `attachment-${index}`,
        })),
      },
    ]);

    expect(canonical.inlineAttachmentCount).toBe(21);
    await expect(
      preflightNexusAttachmentReferences({
        ownerId: 7,
        messages: canonical.messages,
        additionalAttachmentCount: canonical.inlineAttachmentCount,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentTurnLimitError);
    expect(mockResolveNexusAttachmentReference).not.toHaveBeenCalled();
  });
});
