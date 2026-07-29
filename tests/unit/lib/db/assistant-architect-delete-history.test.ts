import { beforeEach, describe, expect, it } from "@jest/globals";

/* eslint-disable no-var */
var mockExecuteTransaction: jest.Mock;
/* eslint-enable no-var */

mockExecuteTransaction = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));

import { deleteAssistantArchitect } from "@/lib/db/drizzle/assistant-architects";
import {
  assistantArchitects,
  chainPrompts,
  navigationItems,
  promptResults,
  toolExecutions,
} from "@/lib/db/schema";

interface DeleteCall {
  table: unknown;
  condition: unknown;
}

let deleteCalls: DeleteCall[];
let detachedHistoryJoins: unknown[];

function transactionDouble() {
  return {
    select() {
      return {
        from(table: unknown) {
          const joins: unknown[] = [];
          const builder = {
            innerJoin(joinedTable: unknown) {
              joins.push(joinedTable);
              return builder;
            },
            where() {
              if (table === navigationItems) return Promise.resolve([]);
              if (table === chainPrompts) {
                detachedHistoryJoins = joins;
                return Promise.resolve([{ id: 41 }]);
              }
              return Promise.resolve([]);
            },
          };
          return builder;
        },
      };
    },
    delete(table: unknown) {
      return {
        where(condition: unknown) {
          deleteCalls.push({ table, condition });
          const operation = Promise.resolve(undefined);
          return Object.assign(operation, {
            returning: async () =>
              table === assistantArchitects ? [{ id: 12 }] : [],
          });
        },
      };
    },
  };
}

describe("deleteAssistantArchitect historical prompt cleanup", () => {
  beforeEach(() => {
    deleteCalls = [];
    detachedHistoryJoins = [];
    mockExecuteTransaction.mockReset();
    mockExecuteTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof transactionDouble>) => unknown) =>
        callback(transactionDouble()),
    );
  });

  it("deletes detached execution-history prompts before removing the assistant", async () => {
    await expect(deleteAssistantArchitect(12)).resolves.toEqual({ id: 12 });

    expect(detachedHistoryJoins).toEqual([promptResults, toolExecutions]);
    const deletedTables = deleteCalls.map(({ table }) => table);
    expect(deletedTables.filter((table) => table === chainPrompts)).toHaveLength(
      2,
    );
    expect(deletedTables.indexOf(promptResults)).toBeLessThan(
      deletedTables.lastIndexOf(chainPrompts),
    );
    expect(deletedTables.at(-1)).toBe(assistantArchitects);
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      "deleteAssistantArchitectTransaction",
    );
  });
});
