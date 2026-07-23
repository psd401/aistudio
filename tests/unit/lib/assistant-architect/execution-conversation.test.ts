const mockCreateConversation = jest.fn();
const mockCreateMessageWithStats = jest.fn();
const mockBindNexusRequestAttachmentReferences = jest.fn();
const mockRollbackNewNexusAttachmentConversation = jest.fn();

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
}));

jest.mock("@/lib/db/drizzle/nexus-messages", () => ({
  createMessageWithStats: (...args: unknown[]) =>
    mockCreateMessageWithStats(...args),
}));

jest.mock("@/lib/logger", () => ({
  sanitizeForLogging: (value: unknown) => value,
}));

jest.mock("@/lib/nexus/request-attachment-binding", () => ({
  bindNexusRequestAttachmentReferences: (...args: unknown[]) =>
    mockBindNexusRequestAttachmentReferences(...args),
  rollbackNewNexusAttachmentConversation: (...args: unknown[]) =>
    mockRollbackNewNexusAttachmentConversation(...args),
}));

import { createAssistantExecutionConversation } from "@/lib/assistant-architect/execution-conversation";

const CONVERSATION_ID = "123e4567-e89b-42d3-a456-426614174111";
const REFERENCES = [
  {
    bindingId: "123e4567-e89b-42d3-a456-426614174000",
    itemId: 44,
    name: "authoritative-name.pdf",
  },
];

describe("createAssistantExecutionConversation", () => {
  const log = {
    error: jest.fn(),
    info: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateConversation.mockResolvedValue({ id: CONVERSATION_ID });
    mockCreateMessageWithStats.mockResolvedValue({ id: "message-1" });
    mockBindNexusRequestAttachmentReferences.mockResolvedValue(undefined);
    mockRollbackNewNexusAttachmentConversation.mockResolvedValue(undefined);
  });

  it("binds runtime references before persisting a resumable first message", async () => {
    const inputs = {
      file: "[Attached repository content: authoritative-name.pdf]",
    };

    await expect(
      createAssistantExecutionConversation({
        assistantId: 5,
        assistantName: "Research Assistant",
        executionId: 55,
        inputs,
        log,
        ownerId: 7,
        references: REFERENCES,
        runtimeRepositoryIds: [77],
      })
    ).resolves.toBe(CONVERSATION_ID);

    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        provider: "assistant-architect",
        metadata: {
          source: "app",
          assistantId: 5,
          assistantName: "Research Assistant",
          executionId: 55,
          executionStatus: "running",
          runtimeRepositoryIds: [77],
        },
      })
    );
    expect(mockBindNexusRequestAttachmentReferences).toHaveBeenCalledWith({
      ownerId: 7,
      conversationId: CONVERSATION_ID,
      references: REFERENCES,
      conversationCreated: true,
    });
    expect(mockCreateMessageWithStats).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        metadata: { inputs, source: "app" },
      })
    );
    expect(
      mockCreateConversation.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockBindNexusRequestAttachmentReferences.mock.invocationCallOrder[0]!
    );
    expect(
      mockBindNexusRequestAttachmentReferences.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateMessageWithStats.mock.invocationCallOrder[0]!);
  });

  it("does not persist a message when reference binding is rejected", async () => {
    mockBindNexusRequestAttachmentReferences.mockRejectedValue(
      new Error("reference unavailable")
    );

    await expect(
      createAssistantExecutionConversation({
        assistantId: 5,
        assistantName: "Research Assistant",
        executionId: 55,
        inputs: {},
        log,
        ownerId: 7,
        references: REFERENCES,
        runtimeRepositoryIds: [77],
      })
    ).resolves.toBeUndefined();

    expect(mockCreateMessageWithStats).not.toHaveBeenCalled();
    expect(mockRollbackNewNexusAttachmentConversation).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "Failed to create nexus conversation for execution",
      expect.objectContaining({
        executionId: 55,
        toolId: 5,
      })
    );
  });

  it("unbinds references and removes the conversation when the first message fails", async () => {
    mockCreateMessageWithStats.mockRejectedValue(
      new Error("message persistence failed")
    );

    await expect(
      createAssistantExecutionConversation({
        assistantId: 5,
        assistantName: "Research Assistant",
        executionId: 55,
        inputs: {},
        log,
        ownerId: 7,
        references: REFERENCES,
        runtimeRepositoryIds: [77],
      })
    ).resolves.toBeUndefined();

    expect(mockRollbackNewNexusAttachmentConversation).toHaveBeenCalledWith({
      ownerId: 7,
      conversationId: CONVERSATION_ID,
    });
  });

  it("logs compensation failures without hiding the original persistence failure", async () => {
    mockCreateMessageWithStats.mockRejectedValue(
      new Error("message persistence failed")
    );
    mockRollbackNewNexusAttachmentConversation.mockRejectedValue(
      new Error("cleanup failed")
    );

    await expect(
      createAssistantExecutionConversation({
        assistantId: 5,
        assistantName: "Research Assistant",
        executionId: 55,
        inputs: {},
        log,
        ownerId: 7,
        references: REFERENCES,
        runtimeRepositoryIds: [77],
      })
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      "Failed to compensate an empty assistant execution conversation",
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        error: "cleanup failed",
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "Failed to create nexus conversation for execution",
      expect.objectContaining({
        error: "message persistence failed",
      })
    );
  });
});
