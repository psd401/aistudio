import { beforeEach, expect, it } from "@jest/globals";

/* eslint-disable no-var */
var mockExecuteQuery: jest.Mock;
var mockExecuteTransaction: jest.Mock;
var mockCheckUserRole: jest.Mock;
var mockGetUserRoles: jest.Mock;
var mockUserCanAccessResource: jest.Mock;
var mockLogWarn: jest.Mock;
var mockValidateAgentToolsForAuthor: jest.Mock;
var mockValidateAgentConnectorsForAuthor: jest.Mock;
var mockValidatePromptToolsForRouting: jest.Mock;
/* eslint-enable no-var */

mockCheckUserRole = jest.fn();
mockGetUserRoles = jest.fn();
mockUserCanAccessResource = jest.fn();
mockLogWarn = jest.fn();
mockValidateAgentToolsForAuthor = jest.fn();
mockValidateAgentConnectorsForAuthor = jest.fn();
mockValidatePromptToolsForRouting = jest.fn();

jest.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
  inArray: (left: unknown, right: unknown) => ({ left, right }),
}));

jest.mock("@/lib/db/schema", () => ({
  assistantArchitects: {
    table: "assistants",
    id: "assistants.id",
    userId: "assistants.user_id",
    status: "assistants.status",
  },
  capabilities: {
    table: "capabilities",
    isActive: "capabilities.is_active",
    promptChainToolId: "capabilities.prompt_chain_tool_id",
  },
  chainPrompts: {
    table: "prompts",
    id: "prompts.id",
    assistantArchitectId: "prompts.assistant_id",
  },
  promptResults: {
    table: "results",
    promptId: "results.prompt_id",
  },
  toolExecutions: {
    table: "executions",
    id: "executions.id",
    assistantArchitectId: "executions.assistant_id",
    status: "executions.status",
  },
  toolInputFields: {
    table: "fields",
    assistantArchitectId: "fields.assistant_id",
  },
  aiModels: {},
}));

jest.mock("@/lib/db/drizzle", () => ({
  checkUserRole: (...args: unknown[]) => mockCheckUserRole(...args),
  getUserRoles: (...args: unknown[]) => mockGetUserRoles(...args),
}));

jest.mock("@/lib/assistant-architect/agent-config-validation", () => ({
  validateAgentToolsForAuthor: (...args: unknown[]) =>
    mockValidateAgentToolsForAuthor(...args),
  validateAgentConnectorsForAuthor: (...args: unknown[]) =>
    mockValidateAgentConnectorsForAuthor(...args),
}));

jest.mock("@/lib/assistant-architect/prompt-tool-validation", () => ({
  validatePromptToolsForRouting: (...args: unknown[]) =>
    mockValidatePromptToolsForRouting(...args),
}));

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  userCanAccessResource: (...args: unknown[]) =>
    mockUserCanAccessResource(...args),
}));

jest.mock("@/lib/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
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
  capabilities,
  chainPrompts,
  promptResults,
  toolExecutions,
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
  mode?: string;
  modelRoutingMode?: string;
  modelRoutingFamily?: string | null;
  agentEnabledTools?: string[];
  agentEnabledConnectors?: string[];
  agentMaxSteps?: number;
  agentTimeoutSeconds?: number;
  agentCostCapCents?: number | null;
  agentMaxRequestsPerHour?: number | null;
  retrievalScope?: Record<string, unknown> | null;
}

interface ChildState {
  id?: number;
  assistantArchitectId: number | null;
  name: string;
  [key: string]: unknown;
}

interface DatabaseState {
  assistants: AssistantState[];
  capabilities: Array<{
    promptChainToolId: number;
    isActive: boolean;
  }>;
  prompts: ChildState[];
  fields: ChildState[];
  promptResults: Array<{ promptId: number; outputData: string }>;
  executions: Array<{
    id: number;
    assistantArchitectId: number;
    status: "pending" | "running" | "completed" | "failed";
  }>;
}

interface EqualityCondition {
  conditions?: EqualityCondition[];
  left?: unknown;
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
  assistant: Record<string, unknown> = baseAssistant,
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
    capabilities: state.capabilities.map((row) => ({ ...row })),
    prompts: state.prompts.map((row) => ({ ...row })),
    fields: state.fields.map((row) => ({ ...row })),
    promptResults: state.promptResults.map((row) => ({ ...row })),
    executions: state.executions.map((row) => ({ ...row })),
  };
}

function thenable<T>(work: () => T): Promise<T> {
  return Promise.resolve().then(work);
}

function insertAssistantRow(
  state: DatabaseState,
  values: Record<string, unknown>,
): { id: number } {
  const id = Math.max(0, ...state.assistants.map((row) => row.id)) + 1;
  state.assistants.push({
    id,
    name: String(values.name),
    description: String(values.description),
    status: String(values.status),
    userId: Number(values.userId),
    imagePath: values.imagePath as string | null,
    isParallel: Boolean(values.isParallel),
    timeoutSeconds: values.timeoutSeconds as number | null,
    mode: String(values.mode),
    modelRoutingMode: String(values.modelRoutingMode),
    modelRoutingFamily: values.modelRoutingFamily as string | null,
    agentEnabledTools: values.agentEnabledTools as string[],
    agentEnabledConnectors: values.agentEnabledConnectors as string[],
    agentMaxSteps: Number(values.agentMaxSteps),
    agentTimeoutSeconds: Number(values.agentTimeoutSeconds),
    agentCostCapCents: values.agentCostCapCents as number | null,
    agentMaxRequestsPerHour: values.agentMaxRequestsPerHour as number | null,
    retrievalScope: values.retrievalScope as Record<string, unknown> | null,
  });
  return { id };
}

function selectFromState(state: DatabaseState, table: unknown) {
  if (table === chainPrompts) {
    return {
      innerJoin(joinedTable: unknown) {
        expect(joinedTable).toBe(promptResults);
        return {
          where(condition: EqualityCondition) {
            const assistantId = Number(condition.right);
            const referencedPromptIds = new Set(
              state.promptResults.map((row) => row.promptId),
            );
            return thenable(() =>
              state.prompts
                .filter(
                  (row) =>
                    row.assistantArchitectId === assistantId &&
                    row.id !== undefined &&
                    referencedPromptIds.has(row.id),
                )
                .map((row) => ({ id: row.id as number })),
            );
          },
        };
      },
    };
  }
  if (table === toolExecutions) {
    return {
      where(condition: EqualityCondition) {
        const assistantId = Number(
          condition.conditions?.find(
            (item) => item.left === toolExecutions.assistantArchitectId,
          )?.right,
        );
        const statuses = condition.conditions?.find(
          (item) => item.left === toolExecutions.status,
        )?.right;
        return {
          limit: async () =>
            state.executions
              .filter(
                (row) =>
                  row.assistantArchitectId === assistantId &&
                  Array.isArray(statuses) &&
                  statuses.includes(row.status),
              )
              .slice(0, 1)
              .map(({ id }) => ({ id })),
        };
      },
    };
  }
  return {
    where(condition: EqualityCondition) {
      return {
        limit: () => ({
          for: async () => {
            const id =
              typeof condition.right === "number"
                ? condition.right
                : state.assistants[0]?.id;
            const found = state.assistants.find((row) => row.id === id);
            return found ? [{ userId: found.userId }] : [];
          },
        }),
      };
    },
  };
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
              return insertAssistantRow(state, values);
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
        from(table: unknown) {
          return selectFromState(state, table);
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: EqualityCondition) {
              const operation = thenable(() => {
                if (table === capabilities) {
                  for (const row of state.capabilities) {
                    if (row.promptChainToolId === condition.right) {
                      Object.assign(row, values);
                    }
                  }
                  return undefined;
                }
                if (table === chainPrompts) {
                  const ids = Array.isArray(condition.right)
                    ? condition.right
                    : [];
                  for (const row of state.prompts) {
                    if (row.id !== undefined && ids.includes(row.id)) {
                      Object.assign(row, values);
                    }
                  }
                  return undefined;
                }
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
  database = {
    assistants: [],
    capabilities: [],
    prompts: [],
    fields: [],
    promptResults: [],
    executions: [],
  };
  failPromptName = null;
  mockExecuteQuery.mockReset();
  mockExecuteTransaction.mockReset();
  mockCheckUserRole.mockReset();
  mockGetUserRoles.mockReset();
  mockUserCanAccessResource.mockReset();
  mockLogWarn.mockReset();
  mockValidateAgentToolsForAuthor.mockReset();
  mockValidateAgentConnectorsForAuthor.mockReset();
  mockValidatePromptToolsForRouting.mockReset();

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
  mockGetUserRoles.mockResolvedValue(["staff"]);
  mockUserCanAccessResource.mockResolvedValue(true);
  mockValidateAgentToolsForAuthor.mockResolvedValue({
    isValid: true,
    invalidTools: [],
  });
  mockValidateAgentConnectorsForAuthor.mockResolvedValue(null);
  mockValidatePromptToolsForRouting.mockResolvedValue({
    isValid: true,
    invalidTools: [],
  });
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

it("rejects agent tools unavailable to the author before starting a transaction", async () => {
  mockValidateAgentToolsForAuthor.mockResolvedValue({
    isValid: false,
    invalidTools: ["admin.secret-tool"],
    message:
      "Tools not available for agentic use with your permissions: 1 not accessible",
  });

  await expect(
    createAssistantsFromImport(
      envelope({
        ...baseAssistant,
        mode: "agentic",
        agent_enabled_tools: ["admin.secret-tool"],
      }),
      7,
    ),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  } satisfies Partial<AssistantImportServiceError>);

  expect(mockGetUserRoles).toHaveBeenCalledWith(7);
  expect(mockValidateAgentToolsForAuthor).toHaveBeenCalledWith(
    ["admin.secret-tool"],
    ["staff"],
  );
  expect(mockExecuteTransaction).not.toHaveBeenCalled();
});

it("rejects inaccessible agent connectors before starting a transaction", async () => {
  mockValidateAgentConnectorsForAuthor.mockResolvedValue(
    "Connectors not available with your permissions: 1 not accessible",
  );

  await expect(
    createAssistantsFromImport(
      envelope({
        ...baseAssistant,
        mode: "agentic",
        agent_enabled_connectors: ["connector-private"],
      }),
      7,
    ),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  } satisfies Partial<AssistantImportServiceError>);

  expect(mockValidateAgentConnectorsForAuthor).toHaveBeenCalledWith(
    ["connector-private"],
    7,
    ["staff"],
  );
  expect(mockExecuteTransaction).not.toHaveBeenCalled();
});

it("rejects unknown or model-incompatible prompt tools before starting a transaction", async () => {
  mockValidatePromptToolsForRouting.mockResolvedValue({
    isValid: false,
    invalidTools: ["unknown_prompt_tool"],
    message: "Unknown tools: unknown_prompt_tool",
  });

  await expect(
    createAssistantsFromImport(
      envelope({
        ...baseAssistant,
        prompts: [
          {
            ...baseAssistant.prompts[0],
            enabled_tools: ["unknown_prompt_tool"],
          },
        ],
      }),
      7,
    ),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  } satisfies Partial<AssistantImportServiceError>);

  expect(mockValidatePromptToolsForRouting).toHaveBeenCalledWith(
    ["unknown_prompt_tool"],
    {
      modelRoutingMode: undefined,
      modelRoutingFamily: undefined,
    },
    7,
    91,
  );
  expect(mockExecuteTransaction).not.toHaveBeenCalled();
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
    capabilities: [{ promptChainToolId: 12, isActive: true }],
    prompts: [{ assistantArchitectId: 12, name: "Old prompt" }],
    fields: [{ assistantArchitectId: 12, name: "old_field" }],
    promptResults: [],
    executions: [],
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
  expect(database.capabilities[0]).toMatchObject({
    promptChainToolId: 12,
    isActive: false,
  });
  expect(database.prompts.map((row) => row.name)).toEqual(["Prompt one"]);
  expect(database.fields.map((row) => row.name)).toEqual(["topic"]);
});

it("retains historical prompt results when replacing an executed graph", async () => {
  database = {
    assistants: [
      {
        id: 12,
        name: "Executed",
        description: "Has history",
        status: "approved",
        userId: 7,
      },
    ],
    capabilities: [],
    prompts: [
      { id: 41, assistantArchitectId: 12, name: "Executed prompt" },
      { id: 42, assistantArchitectId: 12, name: "Never executed" },
    ],
    fields: [],
    promptResults: [{ promptId: 41, outputData: "Historical output" }],
    executions: [],
  };

  await updateAssistantFromImport(12, envelope(), 7);

  expect(database.promptResults).toEqual([
    { promptId: 41, outputData: "Historical output" },
  ]);
  expect(database.prompts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 41,
        assistantArchitectId: null,
        name: "Executed prompt",
      }),
      expect.objectContaining({
        assistantArchitectId: 12,
        name: "Prompt one",
      }),
    ]),
  );
  expect(database.prompts).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 42, name: "Never executed" }),
    ]),
  );
});

it("rejects replacement while an execution can still reference live prompts", async () => {
  database = {
    assistants: [
      {
        id: 12,
        name: "Executing",
        description: "In progress",
        status: "approved",
        userId: 7,
      },
    ],
    capabilities: [{ promptChainToolId: 12, isActive: true }],
    prompts: [
      { id: 41, assistantArchitectId: 12, name: "In-flight prompt" },
    ],
    fields: [{ assistantArchitectId: 12, name: "existing_field" }],
    promptResults: [],
    executions: [
      {
        id: 91,
        assistantArchitectId: 12,
        status: "running",
      },
    ],
  };
  const before = cloneState(database);

  await expect(
    updateAssistantFromImport(12, envelope(), 7),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    message: "Assistant cannot be updated while an execution is in progress",
  } satisfies Partial<AssistantImportServiceError>);

  expect(database).toEqual(before);
});

it("existence-masks a staff caller updating an assistant they do not own", async () => {
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
    code: "NOT_FOUND",
    message: "Assistant not found: 12",
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
    capabilities: [],
    prompts: [{ assistantArchitectId: 12, name: "Original prompt" }],
    fields: [{ assistantArchitectId: 12, name: "original_field" }],
    promptResults: [],
    executions: [],
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

it("masks a non-owner pending fork source before resource lookup", async () => {
  mockExecuteQuery.mockImplementation((_query: unknown, operation: unknown) =>
    operation === "getAssistantForFork"
      ? Promise.resolve([{ userId: 99, status: "pending_approval" }])
      : Promise.resolve([]),
  );

  await expect(forkAssistant(12, 7)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Assistant not found: 12",
  } satisfies Partial<AssistantImportServiceError>);
  expect(mockUserCanAccessResource).not.toHaveBeenCalled();
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
    capabilities: [],
    prompts: [{ assistantArchitectId: 12, name: "Source prompt" }],
    fields: [],
    promptResults: [],
    executions: [],
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
            mode: "agentic",
            modelRoutingMode: "advanced",
            modelRoutingFamily: "anthropic",
            agentEnabledTools: ["repositories.search"],
            agentEnabledConnectors: ["connector-1"],
            agentMaxSteps: 12,
            agentTimeoutSeconds: 240,
            agentCostCapCents: 75,
            agentMaxRequestsPerHour: 20,
            retrievalScope: {
              collectionId: "collection-1",
              tags: ["family"],
              maxVisibilityLevel: "internal",
            },
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
            repositoryIds: [17],
            enabledTools: ["repositories.search"],
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
  expect(
    database.prompts.find((row) => row.assistantArchitectId !== 12),
  ).toMatchObject({
    repositoryIds: [17],
    enabledTools: ["repositories.search"],
  });
  expect(database.assistants.find((row) => row.id !== 12)).toMatchObject({
    name: "Caller copy",
    status: "pending_approval",
    userId: 7,
    mode: "agentic",
    modelRoutingMode: "advanced",
    modelRoutingFamily: "anthropic",
    agentEnabledTools: ["repositories.search"],
    agentEnabledConnectors: ["connector-1"],
    agentMaxSteps: 12,
    agentTimeoutSeconds: 240,
    agentCostCapCents: 75,
    agentMaxRequestsPerHour: 20,
    retrievalScope: {
      collectionId: "collection-1",
      tags: ["family"],
      maxVisibilityLevel: "internal",
    },
  });
  expect(
    database.prompts.some(
      (row) => row.assistantArchitectId === 12 && row.name === "Source prompt",
    ),
  ).toBe(true);
});

it("logs when an imported prompt has no active model mapping", async () => {
  mockExecuteQuery.mockResolvedValue([]);

  const result = await createAssistantsFromImport(envelope(), 7);

  expect(result.successful).toBe(1);
  expect(database.prompts).toEqual([]);
  expect(mockLogWarn).toHaveBeenCalledWith(
    "Skipping imported prompt without an active model mapping",
    expect.objectContaining({
      assistantName: "Imported assistant",
      promptName: "Prompt one",
      modelName: "gpt-source",
    }),
  );
});
