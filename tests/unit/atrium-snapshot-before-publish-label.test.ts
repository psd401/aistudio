/** @jest-environment node */

/**
 * #1791: a document the Nexus chat edited and then published gets its version
 * from the pre-publish snapshot. That version must carry the chat's authoring
 * label, or the history calls a model-written version "human".
 */

const snapshotMock = jest.fn(async (..._args: unknown[]) => ({}));
jest.mock("@/lib/content", () => ({
  versionService: { snapshot: (...args: unknown[]) => snapshotMock(...args) },
}));
jest.mock("@/lib/content/collab/apply-agent-edit", () => ({
  readAgentDocCleanMarkdown: jest.fn(async () => "# Live doc"),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { snapshotLiveDocumentForPublish } from "@/lib/content/collab/snapshot-before-publish";
import type { Requester } from "@/lib/content/types";

const req: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

beforeEach(() => snapshotMock.mockClear());

describe("snapshotLiveDocumentForPublish authoring label", () => {
  it("stamps the given surface label on the snapshot version", async () => {
    await snapshotLiveDocumentForPublish({
      req,
      objectId: "doc-1",
      kind: "document",
      requestId: "r",
      authorLabel: "nexus-chat",
    });
    expect(snapshotMock).toHaveBeenCalledWith(
      req,
      { id: "doc-1", kind: "document" },
      expect.objectContaining({ body: "# Live doc", authorLabel: "nexus-chat" })
    );
  });

  it("adds no label for other publish surfaces", async () => {
    await snapshotLiveDocumentForPublish({ req, objectId: "doc-1", kind: "document", requestId: "r" });
    const input = (snapshotMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(input).not.toHaveProperty("authorLabel");
  });
});
