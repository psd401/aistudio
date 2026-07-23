/** @jest-environment node */

import {
  convertMessagesToPartsFormat,
  extractUserContent,
} from "@/app/api/nexus/chat/chat-helpers";
import { buildTemporaryAttachmentMarker } from "@/lib/repositories/temporary-attachment-contract";

const rawSearchResult = {
  success: true,
  query: "student handbook",
  results: [{
    content: "REVOKED-SOURCE-BODY-DO-NOT-REPLAY",
    source: "policy.pdf",
    score: 0.92,
    citations: [{
      itemVersionId: "223e4567-e89b-42d3-a456-426614174000",
      chunkId: 73,
      label: "Page 4",
      sourceLocator: { page: 4 },
    }],
  }],
};

describe("extractUserContent repository attachment persistence", () => {
  it("stores safe text plus reload metadata without source bytes", () => {
    const reference = {
      bindingId: "123e4567-e89b-42d3-a456-426614174000",
      itemId: 42,
      name: "policy.pdf",
    };
    const marker = buildTemporaryAttachmentMarker(reference);

    const result = extractUserContent({
      id: "message-1",
      role: "user",
      parts: [{
        type: "text",
        text: `Use this file.\n${marker}`,
      }],
    });

    expect(result.content).toBe(
      "Use this file.\n[Attached repository content: policy.pdf]"
    );
    expect(result.parts).toEqual([{
      type: "text",
      text: "Use this file.\n[Attached repository content: policy.pdf]",
      metadata: {
        repositoryAttachments: [reference],
        repositoryAttachmentDisplayText: "Use this file.\n",
      },
    }]);
  });
});

describe("Nexus attachment search replay sanitization", () => {
  it("removes chunk bodies from persisted generic tool-call results on replay", () => {
    const [message] = convertMessagesToPartsFormat([{
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "searchNexusAttachments",
        state: "output-available",
        input: { query: "student handbook" },
        result: rawSearchResult,
      }],
    }]);

    expect(JSON.stringify(message.parts)).not.toContain(
      "REVOKED-SOURCE-BODY-DO-NOT-REPLAY"
    );
    expect(message.parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
      state: "output-available",
      result: {
        success: true,
        query: "student handbook",
        results: [{
          source: "policy.pdf",
          score: 0.92,
          citations: [{
            itemVersionId: "223e4567-e89b-42d3-a456-426614174000",
            chunkId: 73,
            label: "Page 4",
            sourceLocator: { page: 4 },
          }],
        }],
      },
    });
  });

  it("removes chunk bodies from AI SDK static tool outputs without breaking pairing", () => {
    const [message] = convertMessagesToPartsFormat([{
      id: "assistant-2",
      role: "assistant",
      parts: [{
        type: "tool-searchNexusAttachments",
        toolCallId: "tool-2",
        state: "output-available",
        input: { query: "student handbook" },
        output: rawSearchResult,
      }],
    }]);

    expect(JSON.stringify(message.parts)).not.toContain(
      "REVOKED-SOURCE-BODY-DO-NOT-REPLAY"
    );
    expect(message.parts[0]).toMatchObject({
      type: "tool-searchNexusAttachments",
      toolCallId: "tool-2",
      state: "output-available",
      input: { query: "student handbook" },
      output: {
        success: true,
        results: [{
          citations: [{ chunkId: 73, label: "Page 4" }],
        }],
      },
    });
  });
});
