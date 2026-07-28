import { beforeEach, describe, expect, it } from "@jest/globals";

/* eslint-disable no-var */
var mockExecuteTransaction: jest.Mock;
/* eslint-enable no-var */

mockExecuteTransaction = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));

import { approveAssistantArchitect } from "@/lib/db/drizzle/assistant-architects";
import {
  assistantArchitects,
  capabilities,
} from "@/lib/db/schema";

interface UpdateCall {
  table: unknown;
  values: Record<string, unknown>;
}

let updateCalls: UpdateCall[];
let insertCalls: unknown[];

function transactionDouble() {
  return {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              updateCalls.push({ table, values });
              if (table === assistantArchitects) {
                return {
                  returning: async () => [
                    {
                      id: 12,
                      name: "Renamed assistant",
                      description: "Updated",
                    },
                  ],
                };
              }
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                orderBy: async () =>
                  table === capabilities
                    ? [
                        { id: 77, identifier: "original-assistant" },
                        { id: 92, identifier: "renamed-assistant" },
                      ]
                    : [],
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      insertCalls.push(table);
      throw new Error("Existing capability must be reused");
    },
  };
}

describe("approveAssistantArchitect capability identity", () => {
  beforeEach(() => {
    updateCalls = [];
    insertCalls = [];
    mockExecuteTransaction.mockReset();
    mockExecuteTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof transactionDouble>) => unknown) =>
        callback(transactionDouble()),
    );
  });

  it("reuses the oldest linked capability when a renamed assistant is reapproved", async () => {
    await expect(approveAssistantArchitect(12)).resolves.toMatchObject({
      id: 12,
      name: "Renamed assistant",
    });

    const capabilityUpdate = updateCalls.find(
      ({ table }) => table === capabilities,
    );
    expect(capabilityUpdate?.values).toMatchObject({
      name: "Renamed assistant",
      description: "Updated",
      isActive: true,
      source: "manual",
    });
    expect(capabilityUpdate?.values).not.toHaveProperty("identifier");
    expect(capabilityUpdate?.values).not.toHaveProperty("promptChainToolId");
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: capabilities,
          values: expect.objectContaining({
            promptChainToolId: null,
            isActive: false,
          }),
        }),
      ]),
    );
    expect(insertCalls).toEqual([]);
  });
});
