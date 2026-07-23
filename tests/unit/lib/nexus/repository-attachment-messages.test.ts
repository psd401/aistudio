import type { UIMessage } from "ai";
import { prepareRepositoryAttachmentMessages } from "@/lib/nexus/repository-attachment-messages";

const marker =
  "[[repository-attachment:v1:123e4567-e89b-42d3-a456-426614174000:31:handbook.pdf]]";

describe("repository attachment messages", () => {
  it("extracts nested adapter references and strips opaque IDs from model input", () => {
    const input = [
      {
        id: "message",
        role: "user",
        parts: [
          { type: "text", text: "Summarize this" },
          {
            type: "document",
            name: "handbook.pdf",
            content: [{ type: "text", text: marker }],
          },
        ],
      },
    ] as UIMessage[];

    const prepared = prepareRepositoryAttachmentMessages(input, [
      {
        bindingId: "123e4567-e89b-42d3-a456-426614174000",
        itemId: 31,
        name: "District handbook.pdf",
      },
    ]);

    expect(prepared.references).toEqual([
      {
        bindingId: "123e4567-e89b-42d3-a456-426614174000",
        itemId: 31,
        name: "District handbook.pdf",
      },
    ]);
    expect(JSON.stringify(prepared.modelMessages)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174000"
    );
    expect(JSON.stringify(prepared.modelMessages)).toContain(
      "[Attached repository content: District handbook.pdf]"
    );
    expect(prepared.messages[0]?.parts).toEqual([
      { type: "text", text: "Summarize this" },
      {
        type: "text",
        text: "[Attached repository content: District handbook.pdf]",
        metadata: {
          repositoryAttachments: [
            {
              bindingId: "123e4567-e89b-42d3-a456-426614174000",
              itemId: 31,
              name: "District handbook.pdf",
            },
          ],
          repositoryAttachmentDisplayText: "",
        },
      },
    ]);
  });

  it("does not disclose an unvalidated marker name or identifier", () => {
    const prepared = prepareRepositoryAttachmentMessages(
      [
        {
          id: "message",
          role: "user",
          parts: [{ type: "text", text: `Review ${marker}` }],
        },
      ] as UIMessage[],
      []
    );

    expect(JSON.stringify(prepared.messages)).toContain(
      "Review [Attached repository content]"
    );
    expect(JSON.stringify(prepared.messages)).not.toContain("handbook.pdf");
    expect(JSON.stringify(prepared.messages)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174000"
    );
    expect(prepared.references).toEqual([]);
    expect(JSON.stringify(prepared.modelMessages)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174000"
    );
  });
});
