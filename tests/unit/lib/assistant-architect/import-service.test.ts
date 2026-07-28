import { beforeEach, expect, it } from "@jest/globals";

/* eslint-disable no-var */
var mockExecuteQuery: jest.Mock;
var mockExecuteTransaction: jest.Mock;
var mockCheckUserRole: jest.Mock;
var mockUserCanAccessResource: jest.Mock;
/* eslint-enable no-var */

mockCheckUserRole = jest.fn();
mockUserCanAccessResource = jest.fn();

jest.mock("drizzle-orm", () => ({
  eq: (left: unknown, right: unknown) => ({ left, right }),
  inArray: jest.fn(),
}));

jest.mock("@/lib/db/schema", () => ({
  assistantArchitects: {
    table: "assistants",
    id: "assistants.id",
    userId: "assistants.user_id",
    status: "assistants.status",
  },
  chainPrompts: {
    table: "prompts",
    assistantArchitectId: "prompts.assistant_id",
  },
  toolInputFields: {
    table: "fields",
    assistantArchitectId: "fields.assistant_id",
  },
  aiModels: {},
}));

jest.mock("@/lib/db/drizzle", () => ({
  checkUserRole: (...args: unknown[]) => mockCheckUserRole(...args),
}));

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  userCanAccessResource: (...args: unknown[]) =>
    mockUserCanAccessResource(...args),
}));

jest.mock("@/lib/logger", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@/lib/utils/text-sanitizer", () => ({
  decodeMdxEditorEscapes: (value: string) => value,
}));

import {
  AssistantImportServiceError,
  createAssistantsFromImport,
  forkAssistant,
  updateAssistantFromImport,
} from "@/lib/assistant-architect/import-service";
import {
  assistantArchitects,
  chainPrompts,
  toolInputFields,
} from "@/lib/db/schema";
import { getAssistantDataForExport } from "@/lib/assistant-export-import";

const drizzleClientMock = jest.requireMock<{
  executeQuery: jest.Mock;
  executeTransaction: jest.Mock;
}>("@/lib/db/drizzle-client");
mockExecuteQuery = drizzleClientMock.executeQuery;
mockExecuteTransaction = drizzleClientMock.executeTransaction;

interface AssistantState {
  id: number;
  name: string;
  description: string;
  status: string;
  userId: number | null;
  imagePath?: string | null;
  isParallel?: boolean;
  timeoutSeconds?: number | null;
}

interface ChildState {
  assistantArchitectId: number;
  name: string;
  [key: string]: unknown;
}

interface DatabaseState {
  assistants: AssistantState[];
  prompts: ChildState[];
  fields: ChildState[];
}

interface EqualityCondition {
  right?: unknown;
}

let database: DatabaseState;
let failPromptName: string | null;

const baseAssistant = {
  name: "Imported assistant",
  description: "Imported description",
  status: "approved",
  prompts: [
    {
      name: "Prompt one",
      content: "Hello",
      model_name: "gpt-source",
      position: 0,
    },
  ],
  input_fields: [
    {
      name: "topic",
      label: "Topic",
      field_type: "short_text",
      position: 0,
    },
  ],
};

function envelope(
  assistant: typeof baseAssistant = baseAssistant,
): Record<string, unknown> {
  return {
    version: "1.0",
    exported_at: "2026-07-28T00:00:00.000Z",
    assistants: [assistant],
  };
}

function cloneState(state: DatabaseState): DatabaseState {
  return {
    assistants: state.assistants.map((row) => ({ ...row })),
    prompts: state.prompts.map((row) => ({ ...row })),
    fields: state.fields.map((row) => ({ ...row })),
  };
}

function thenable<T>(work: () => T): Promise<T> {
  return Promise.resolve().then(work);
}

function createTransaction(state: DatabaseState) {
  return {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          const operation = thenable(() => {
            if (table === chainPrompts && values.name === failPromptName) {
              throw new Error("prompt insert failed");
            }
            if (table === assistantArchitects) {
              const id =
                Math.max(0, ...state.assistants.map((row) => row.id)) + 1;
              state.assistants.push({
                id,
                name: String(values.name),
                description: String(values.description),
                status: String(values.status),
                userId: Number(values.userId),
                imagePath: values.imagePath as string | null,
                isParallel: Boolean(values.isParallel),
                timeoutSeconds: values.timeoutSeconds as number | null,
              });
              return { id };
            }
            const child = {
              ...values,
              assistantArchitectId: Number(values.assistantArchitectId),
              name: String(values.name),
            };
            if (table === chainPrompts) state.prompts.push(child);
            if (table === toolInputFields) state.fields.push(child);
            return undefined;
          });
          return Object.assign(operation, {
            returning: async () => {
              const row = await operation;
              return row ? [row] : [];
            },
          });
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where(condition: EqualityCondition) {
              return {
                limit: async () => {
                  const id =
                    typeof condition.right === "number"
                      ? condition.right
                      : state.assistants[0]?.id;
                  const found = state.assistants.find((row) => row.id === id);
                  return found ? [{ userId: found.userId }] : [];
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: EqualityCondition) {
              const operation = thenable(() => {
                if (table !== assistantArchitects) return undefined;
                const id =
                  typeof condition.right === "number"
                    ? condition.right
                    : state.assistants[0]?.id;
                const row = state.assistants.find((item) => item.id === id);
                if (!row) return undefined;
                Object.assign(row, values);
                return { id };
              });
              return Object.assign(operation, {
                returning: async () => {
                  const row = await operation;
                  return row ? [row] : [];
                },
              });
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(condition: EqualityCondition) {
          return thenable(() => {
            const assistantId =
              typeof condition.right === "number"
                ? condition.right
                : state.assistants[0]?.id;
            if (table === chainPrompts) {
              state.prompts = state.prompts.filter(
                (row) => row.assistantArchitectId !== assistantId,
              );
            }
            if (table === toolInputFields) {
              state.fields = state.fields.filter(
                (row) => row.assistantArchitectId !== assistantId,
              );
            }
          });
        },
      };
    },
  };
}

beforeEach(() => {
  database = { assistants: [], prompts: [], fields: [] };
  failPromptName = null;
  mockExecuteQuery.mockReset();
  mockExecuteTransaction.mockReset();
  mockCheckUserRole.mockReset();
  mockUserCanAccessResource.mockReset();

  mockExecuteQuery.mockImplementation((_query: unknown, operation: unknown) =>
    operation === "getActiveModelsForImport"
      ? Promise.resolve([
          {
            id: 91,
            modelId: "gpt-source",
            provider: "openai",
            capabilities: {},
          },
        ])
      : Promise.resolve([]),
  );
  mockCheckUserRole.mockResolvedValue(false);
  mockUserCanAccessResource.mockResolvedValue(true);
  mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
    const staged = cloneState(database);
    const run = callback as (
      tx: ReturnType<typeof createTransaction>,
    ) => Promise<unknown>;
    const result = await run(createTransaction(staged));
    database = staged;
    return result;
  });
});

it("creates caller-owned pending assistants and ignores imported approved status", async () => {
  const result = await createAssistantsFromImport(envelope(), 7);

  expect(result).toMatchObject({
    total: 1,
    successful: 1,
    failed: 0,
    results: [
      {
        name: "Imported assistant",
        id: 1,
        status: "pending_approval",
      },
    ],
    modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
  });
  expect(database.assistants[0]).toMatchObject({
    userId: 7,
    status: "pending_approval",
  });
  expect(database.prompts).toHaveLength(1);
  expect(database.fields).toHaveLength(1);
});

it("rolls back every row for an assistant when a prompt insert fails", async () => {
  failPromptName = "Prompt one";

  const result = await createAssistantsFromImport(envelope(), 7);

  expect(result.results[0]).toMatchObject({
    name: "Imported assistant",
    status: "error",
    error: "Failed to import assistant",
  });
  expect(database.assistants).toEqual([]);
  expect(database.prompts).toEqual([]);
  expect(database.fields).toEqual([]);
});

it("lets an owner replace prompts and fields and resets approval", async () => {
  database = {
    assistants: [
      {
        id: 12,
        name: "Old",
        description: "Old",
        status: "approved",
        userId: 7,
      },
    ],
    prompts: [{ assistantArchitectId: 12, name: "Old prompt" }],
    fields: [{ assistantArchitectId: 12, name: "old_field" }],
  };

  const result = await updateAssistantFromImport(12, envelope(), 7);

  expect(result.result).toEqual({
    id: 12,
    name: "Imported assistant",
    status: "pending_approval",
  });
  expect(database.assistants[0]).toMatchObject({
    id: 12,
    name: "Imported assistant",
    status: "pending_approval",
    userId: 7,
  });
  expect(database.prompts.map((row) => row.name)).toEqual(["Prompt one"]);
  expect(database.fields.map((row) => row.name)).toEqual(["topic"]);
});

it("denies a staff caller updating an assistant they do not own", async () => {
  database.assistants.push({
    id: 12,
    name: "Other owner",
    description: "",
    status: "approved",
    userId: 99,
  });

  await expect(
    updateAssistantFromImport(12, envelope(), 7),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  } satisfies Partial<AssistantImportServiceError>);
});

it("lets an administrator update any assistant", async () => {
  database.assistants.push({
    id: 12,
    name: "Other owner",
    description: "",
    status: "approved",
    userId: 99,
  });
  mockCheckUserRole.mockResolvedValue(true);

  await updateAssistantFromImport(12, envelope(), 7);

  expect(database.assistants[0]).toMatchObject({
    status: "pending_approval",
    userId: 99,
  });
});

it("rolls back the whole replacement on a mid-update failure", async () => {
  database = {
    assistants: [
      {
        id: 12,
        name: "Original",
        description: "Keep me",
        status: "approved",
        userId: 7,
      },
    ],
    prompts: [{ assistantArchitectId: 12, name: "Original prompt" }],
    fields: [{ assistantArchitectId: 12, name: "original_field" }],
  };
  failPromptName = "Prompt one";
  const before = cloneState(database);

  await expect(updateAssistantFromImport(12, envelope(), 7)).rejects.toThrow(
    "prompt insert failed",
  );
  expect(database).toEqual(before);
});

it("masks a resource-invisible fork source as not found", async () => {
  mockExecuteQuery.mockImplementation((_query: unknown, operation: unknown) =>
    operation === "getAssistantForFork"
      ? Promise.resolve([{ userId: 99, status: "approved" }])
      : Promise.resolve([]),
  );
  mockUserCanAccessResource.mockResolvedValue(false);

  await expect(forkAssistant(12, 7)).rejects.toMatchObject({
    code: "NOT_FOUND",
  } satisfies Partial<AssistantImportServiceError>);
});

it("forks into a caller-owned pending copy without changing the source", async () => {
  database = {
    assistants: [
      {
        id: 12,
        name: "Source",
        description: "Source description",
        status: "approved",
        userId: 7,
      },
    ],
    prompts: [{ assistantArchitectId: 12, name: "Source prompt" }],
    fields: [],
  };
  mockExecuteQuery.mockImplementation((_query: unknown, operation: unknown) => {
    switch (operation) {
      case "getAssistantForFork":
        return Promise.resolve([{ userId: 7, status: "approved" }]);
      case "getAssistantsForExport":
        return Promise.resolve([
          {
            id: 12,
            name: "Source",
            description: "Source description",
            status: "approved",
            imagePath: null,
            isParallel: false,
            timeoutSeconds: null,
          },
        ]);
      case "getPromptsForExport":
        return Promise.resolve([
          {
            name: "Prompt one",
            content: "Hello",
            systemContext: null,
            position: 0,
            parallelGroup: null,
            inputMapping: null,
            timeoutSeconds: null,
            modelName: "gpt-source",
          },
        ]);
      case "getInputFieldsForExport":
        return Promise.resolve([]);
      case "getActiveModelsForImport":
        return Promise.resolve([
          {
            id: 91,
            modelId: "gpt-source",
            provider: "openai",
            capabilities: {},
          },
        ]);
      default:
        return Promise.resolve([]);
    }
  });

  expect(await getAssistantDataForExport([12])).toHaveLength(1);
  const result = await forkAssistant(12, 7, "Caller copy");

  expect(result.result).toMatchObject({
    name: "Caller copy",
    status: "pending_approval",
  });
  expect(database.assistants.find((row) => row.id === 12)).toMatchObject({
    name: "Source",
    status: "approved",
    userId: 7,
  });
  expect(database.assistants.find((row) => row.id !== 12)).toMatchObject({
    name: "Caller copy",
    status: "pending_approval",
    userId: 7,
  });
  expect(
    database.prompts.some(
      (row) => row.assistantArchitectId === 12 && row.name === "Source prompt",
    ),
  ).toBe(true);
});
