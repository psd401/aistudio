const mockGetCurrentUser = jest.fn();
const mockHasCapability = jest.fn();
const mockGetArchitect = jest.fn();
const mockAccessibleRepositoryIds = jest.fn();
const mockUploadDraft = jest.fn();
const mockInvokeScan = jest.fn();
const mockExecuteTransaction = jest.fn();

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
  generateRequestId: () => "publish-skill-request",
  getLogContext: () => ({}),
  startTimer: () => () => undefined,
}));

jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...args: unknown[]) => mockGetCurrentUser(...args),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => mockHasCapability(...args),
}));
jest.mock("@/actions/db/assistant-architect-actions", () => ({
  getAssistantArchitectByIdAction: (...args: unknown[]) =>
    mockGetArchitect(...args),
}));
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoryIds: (...args: unknown[]) =>
    mockAccessibleRepositoryIds(...args),
}));
jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));
jest.mock("@/lib/skills/skill-publish-pipeline", () => ({
  uploadSkillDraft: (...args: unknown[]) => mockUploadDraft(...args),
  invokeSkillScan: (...args: unknown[]) => mockInvokeScan(...args),
}));
jest.mock("@/lib/db/schema/tables/agent-skills", () => ({
  psdAgentSkills: "skills-table",
}));
jest.mock("@/lib/db/schema/tables/agent-skill-audit", () => ({
  psdAgentSkillAudit: "audit-table",
}));
jest.mock("@/lib/db/schema/tables/skill-repository-bindings", () => ({
  skillRepositoryBindings: "bindings-table",
}));
jest.mock("drizzle-orm", () => ({
  eq: (...values: unknown[]) => ({ eq: values }),
  and: (...values: unknown[]) => ({ and: values }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

import { publishAssistantArchitectAsSkillAction } from "@/actions/db/publish-skill.actions";

const skillId = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({
    isSuccess: true,
    data: { user: { id: 7, email: "owner@psd401.net" } },
  });
  mockHasCapability.mockResolvedValue(true);
  mockGetArchitect.mockResolvedValue({
    isSuccess: true,
    data: {
      id: 31,
      userId: 7,
      name: "Policy helper",
      description: "Answers policy questions",
      inputFields: [],
      prompts: [
        {
          name: "Answer",
          content: "Answer from the repositories.",
          systemContext: null,
          position: 0,
          enabledTools: [],
          repositoryIds: [41, 41, 87],
        },
      ],
    },
  });
  mockAccessibleRepositoryIds.mockResolvedValue([41, 87]);
  mockUploadDraft.mockResolvedValue({
    draftPrefix: "skills/drafts/policy-helper/",
    destinationPrefix: "skills/shared/policy-helper/",
  });
  mockInvokeScan.mockResolvedValue(true);
});

describe("publish skill repository bindings", () => {
  it("normalizes, authorizes, and transactionally replaces prompt repository bindings", async () => {
    const insertedBindings: unknown[] = [];
    const auditValues: unknown[] = [];
    let deletedBindings = false;
    mockExecuteTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert(table: unknown) {
            if (table === "skills-table") {
              return {
                values: () => ({
                  onConflictDoUpdate: () => ({
                    returning: async () => [{ id: skillId }],
                  }),
                }),
              };
            }
            if (table === "bindings-table") {
              return {
                values: async (values: unknown[]) => {
                  insertedBindings.push(...values);
                },
              };
            }
            return {
              values: async (values: unknown) => {
                auditValues.push(values);
              },
            };
          },
          delete(table: unknown) {
            expect(table).toBe("bindings-table");
            return {
              where: async () => {
                deletedBindings = true;
              },
            };
          },
        };
        return callback(tx);
      }
    );

    const result = await publishAssistantArchitectAsSkillAction("31");

    expect(result.isSuccess).toBe(true);
    expect(mockAccessibleRepositoryIds).toHaveBeenCalledWith([41, 87], 7);
    expect(deletedBindings).toBe(true);
    expect(insertedBindings).toEqual([
      { skillId, repositoryId: 41 },
      { skillId, repositoryId: 87 },
    ]);
    expect(auditValues).toEqual([
      expect.objectContaining({
        skillId,
        details: expect.objectContaining({ repositoryIds: [41, 87] }),
      }),
    ]);
  });

  it("fails before upload or persistence when the publisher lost repository access", async () => {
    mockAccessibleRepositoryIds.mockResolvedValue([41]);

    const result = await publishAssistantArchitectAsSkillAction("31");

    expect(result.isSuccess).toBe(false);
    expect(mockUploadDraft).not.toHaveBeenCalled();
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });
});
