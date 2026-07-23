const mockBindNexusAttachmentReferencesToConversation = jest.fn();
const mockExecuteTransaction = jest.fn();

jest.mock("@/lib/nexus/ephemeral-repository-service", () => ({
  bindNexusAttachmentReferencesToConversation: (...args: unknown[]) =>
    mockBindNexusAttachmentReferencesToConversation(...args),
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));

import {
  bindNexusRequestAttachmentReferences,
  NexusAttachmentBindingCleanupError,
  NexusAttachmentBindingRejectedError,
  rollbackNewNexusAttachmentConversation,
} from "@/lib/nexus/request-attachment-binding";

const INPUT = {
  ownerId: 7,
  conversationId: "123e4567-e89b-42d3-a456-426614174111",
  references: [
    {
      bindingId: "123e4567-e89b-42d3-a456-426614174000",
      itemId: 42,
    },
  ],
};

describe("bindNexusRequestAttachmentReferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("binds preflighted references without cleanup", async () => {
    mockBindNexusAttachmentReferencesToConversation.mockResolvedValue([8]);

    await expect(
      bindNexusRequestAttachmentReferences({
        ...INPUT,
        conversationCreated: true,
      })
    ).resolves.toBeUndefined();

    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("unbinds before deleting a newly created conversation when binding is indeterminate", async () => {
    mockBindNexusAttachmentReferencesToConversation.mockRejectedValue(
      new Error("expired")
    );
    const order: string[] = [];
    const tx = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(async () => {
            order.push("unbind");
          }),
        })),
      })),
      delete: jest.fn(() => ({
        where: jest.fn(async () => {
          order.push("delete");
        }),
      })),
    };
    mockExecuteTransaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<void>) =>
        callback(tx)
    );

    await expect(
      bindNexusRequestAttachmentReferences({
        ...INPUT,
        conversationCreated: true,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentBindingRejectedError);

    expect(order).toEqual(["unbind", "delete"]);
    expect(mockExecuteTransaction.mock.calls[0]?.[1]).toBe(
      "rollbackNewNexusAttachmentConversation"
    );
  });

  it("does not delete an existing conversation after a rejected binding", async () => {
    mockBindNexusAttachmentReferencesToConversation.mockRejectedValue(
      new Error("foreign")
    );

    await expect(
      bindNexusRequestAttachmentReferences({
        ...INPUT,
        conversationCreated: false,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentBindingRejectedError);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("surfaces cleanup failure separately instead of claiming a clean rejection", async () => {
    mockBindNexusAttachmentReferencesToConversation.mockRejectedValue(
      new Error("expired")
    );
    mockExecuteTransaction.mockRejectedValue(new Error("database unavailable"));

    await expect(
      bindNexusRequestAttachmentReferences({
        ...INPUT,
        conversationCreated: true,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentBindingCleanupError);
  });
});

describe("rollbackNewNexusAttachmentConversation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unbinds references before deleting the undisclosed conversation", async () => {
    const order: string[] = [];
    const updateWhere = jest.fn(async () => {
      order.push("unbind");
    });
    const deleteWhere = jest.fn(async () => {
      order.push("delete");
    });
    const tx = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: updateWhere })),
      })),
      delete: jest.fn(() => ({ where: deleteWhere })),
    };
    mockExecuteTransaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<void>) =>
        callback(tx)
    );

    await rollbackNewNexusAttachmentConversation({
      ownerId: INPUT.ownerId,
      conversationId: INPUT.conversationId,
    });

    expect(order).toEqual(["unbind", "delete"]);
    expect(mockExecuteTransaction.mock.calls[0]?.[1]).toBe(
      "rollbackNewNexusAttachmentConversation"
    );
  });

  it("reports a compensation failure instead of hiding a stranded binding", async () => {
    mockExecuteTransaction.mockRejectedValue(new Error("database unavailable"));

    await expect(
      rollbackNewNexusAttachmentConversation({
        ownerId: INPUT.ownerId,
        conversationId: INPUT.conversationId,
      })
    ).rejects.toBeInstanceOf(NexusAttachmentBindingCleanupError);
  });
});
