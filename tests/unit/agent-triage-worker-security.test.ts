/** @jest-environment node */

const mockListLabels = jest.fn()
const mockGetMessageMetadata = jest.fn()
const mockModifyMessage = jest.fn()
const mockApplyRules = jest.fn()

jest.mock("@/infra/lambdas/agent-triage-poll/workspace-token", () => ({
  getFreshAccessTokenForUser: jest.fn(),
  workspaceSecretId: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/gmail", () => ({
  extractFromEmail: () => "sender@example.net",
  extractSubject: () => "Subject",
  getCurrentHistoryId: jest.fn(),
  getMessageFullBody: jest.fn(),
  getMessageMetadata: (...args: unknown[]) =>
    mockGetMessageMetadata(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  listHistory: jest.fn(),
  modifyMessage: (...args: unknown[]) => mockModifyMessage(...args),
  modifyThread: jest.fn(),
  threadHasUserReply: jest.fn().mockResolvedValue(false),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/llm", () => ({
  BODY_EXCERPT_MAX: 10_000,
  classifyWithLLM: jest.fn(),
  finalizeLLMLabel: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/rules", () => ({
  applyRules: (...args: unknown[]) => mockApplyRules(...args),
  shouldEscalate: () => ({ escalate: false }),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/chat", () => ({
  postEscalation: jest.fn(),
  postTaskOutcome: jest.fn(),
  resolveDmSpace: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/storage", () => ({
  backfillDmSpaceName: jest.fn(),
  claimTaskGesture: jest.fn(),
  getGoogleIdentityForEmail: jest.fn(),
  getUserProfile: jest.fn(),
  recordPollResult: jest.fn(),
  recordTaskCreated: jest.fn(),
  releaseTaskGestureClaim: jest.fn(),
  resetCursor: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/agentcore", () => ({
  requestTaskCreation: jest.fn(),
}))

interface TestTriageRow {
  userEmail: string
  enabled: boolean
  labels: Record<keyof typeof IDS, string>
  labelIdsByKey: Record<keyof typeof IDS, string>
  labelMappingVersion?: number
  labelMappingProvenance?: string
  labelMappingOwnerEmail?: string
  labelMappingResolvedAt?: string
  rules: {
    vipSenders: string[]
    muteSenders: string[]
    keywordRules: never[]
  }
  escalation: {
    senders: string[]
    keywords: string[]
    labelTriggers: never[]
  }
  digestEnabled: boolean
  recentDecisions: never[]
  recentCorrections: never[]
}

interface ClassifyResult {
  decision: {
    label: string
  }
}

const { classifyAndLabel } = jest.requireActual<{
  classifyAndLabel: (
    state: TestTriageRow,
    accessToken: string,
    message: { id: string; threadId: string }
  ) => Promise<ClassifyResult | null>
}>("@/infra/lambdas/agent-triage-poll/index")

const IDS = {
  important: "Label_important",
  later: "Label_later",
  news: "Label_news",
  task: "Label_task",
}

const TRIAGE_LABEL_MAPPING_VERSION = 1
const TRIAGE_LABEL_MAPPING_PROVENANCE = "owner-gmail-label-resolution"
const TRIAGE_LABEL_NAMES = {
  important: "@psd/Important",
  later: "@psd/Later",
  news: "@psd/News",
  task: "@psd/Task",
}

function row(overrides: Partial<TestTriageRow> = {}): TestTriageRow {
  return {
    userEmail: "owner@example.com",
    enabled: true,
    labels: TRIAGE_LABEL_NAMES,
    labelIdsByKey: IDS,
    labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
    labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
    labelMappingOwnerEmail: "owner@example.com",
    labelMappingResolvedAt: "2026-07-26T00:00:00.000Z",
    rules: { vipSenders: [], muteSenders: [], keywordRules: [] },
    escalation: { senders: [], keywords: [], labelTriggers: [] },
    digestEnabled: false,
    recentDecisions: [],
    recentCorrections: [],
    ...overrides,
  }
}

function liveLabels(): Array<{ id: string; name: string; type: "user" }> {
  return Object.entries(TRIAGE_LABEL_NAMES).map(([key, name]) => ({
    id: IDS[key as keyof typeof IDS],
    name,
    type: "user" as const,
  }))
}

describe("agent triage worker label sink", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListLabels.mockResolvedValue(liveLabels())
    mockGetMessageMetadata.mockResolvedValue({
      id: "message-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      snippet: "Preview",
    })
    mockApplyRules.mockReturnValue({
      label: "later",
      reason: "mute:test",
      source: "rule",
    })
  })

  it.each([
    ["legacy", row({ labelMappingVersion: undefined })],
    ["foreign", row({ labelMappingOwnerEmail: "attacker@example.com" })],
  ])("fails closed before any Gmail call for %s state", async (_name, state) => {
    await expect(
      classifyAndLabel(state, "token", {
        id: "message-1",
        threadId: "thread-1",
      })
    ).resolves.toBeNull()
    expect(mockListLabels).not.toHaveBeenCalled()
    expect(mockGetMessageMetadata).not.toHaveBeenCalled()
    expect(mockApplyRules).not.toHaveBeenCalled()
    expect(mockModifyMessage).not.toHaveBeenCalled()
  })

  it("fails closed when the live label was renamed", async () => {
    const renamed = liveLabels()
    renamed[1] = { ...renamed[1], name: "Renamed" }
    mockListLabels.mockResolvedValue(renamed)

    await expect(
      classifyAndLabel(row(), "token", {
        id: "message-1",
        threadId: "thread-1",
      })
    ).resolves.toBeNull()
    expect(mockListLabels).toHaveBeenCalledTimes(1)
    expect(mockGetMessageMetadata).not.toHaveBeenCalled()
    expect(mockApplyRules).not.toHaveBeenCalled()
    expect(mockModifyMessage).not.toHaveBeenCalled()
  })

  it("uses the verified live ID and preserves intentional INBOX archive behavior", async () => {
    const result = await classifyAndLabel(row(), "token", {
      id: "message-1",
      threadId: "thread-1",
    })

    expect(result?.decision.label).toBe("later")
    expect(mockModifyMessage).toHaveBeenCalledTimes(1)
    expect(mockModifyMessage).toHaveBeenCalledWith(
      "token",
      "message-1",
      ["Label_later"],
      ["INBOX"]
    )
  })
})
