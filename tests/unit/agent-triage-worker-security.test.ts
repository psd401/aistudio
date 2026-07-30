/** @jest-environment node */

const mockListLabels = jest.fn()
const mockGetMessageMetadata = jest.fn()
const mockModifyMessage = jest.fn()
const mockApplyRules = jest.fn()
const mockGetFreshAccessToken = jest.fn()
const mockGetMessageFullBody = jest.fn()
const mockListHistory = jest.fn()
const mockModifyThread = jest.fn()
const mockClaimTaskGesture = jest.fn()
const mockGetUserProfile = jest.fn()
const mockRecordPollResult = jest.fn()
const mockRecordTaskCreated = jest.fn()
const mockReleaseTaskGestureClaim = jest.fn()
const mockStampTrustedTriageLabelMapping = jest.fn()
const mockRequestTaskCreation = jest.fn()
const mockPostTaskOutcome = jest.fn()

jest.mock("@/infra/lambdas/agent-triage-poll/workspace-token", () => ({
  getFreshAccessTokenForUser: (...args: unknown[]) =>
    mockGetFreshAccessToken(...args),
  workspaceSecretId: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/gmail", () => ({
  extractFromEmail: () => "sender@example.net",
  extractSubject: () => "Subject",
  getCurrentHistoryId: jest.fn(),
  getMessageFullBody: (...args: unknown[]) =>
    mockGetMessageFullBody(...args),
  getMessageMetadata: (...args: unknown[]) =>
    mockGetMessageMetadata(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  listHistory: (...args: unknown[]) => mockListHistory(...args),
  modifyMessage: (...args: unknown[]) => mockModifyMessage(...args),
  modifyThread: (...args: unknown[]) => mockModifyThread(...args),
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
  postTaskOutcome: (...args: unknown[]) => mockPostTaskOutcome(...args),
  resolveDmSpace: jest.fn(),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/storage", () => ({
  backfillDmSpaceName: jest.fn(),
  claimTaskGesture: (...args: unknown[]) => mockClaimTaskGesture(...args),
  getGoogleIdentityForEmail: jest.fn(),
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  recordPollResult: (...args: unknown[]) => mockRecordPollResult(...args),
  recordTaskCreated: (...args: unknown[]) => mockRecordTaskCreated(...args),
  releaseTaskGestureClaim: (...args: unknown[]) =>
    mockReleaseTaskGestureClaim(...args),
  resetCursor: jest.fn(),
  stampTrustedTriageLabelMapping: (...args: unknown[]) =>
    mockStampTrustedTriageLabelMapping(...args),
}))

jest.mock("@/infra/lambdas/agent-triage-poll/agentcore", () => ({
  requestTaskCreation: (...args: unknown[]) =>
    mockRequestTaskCreation(...args),
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
  lastHistoryId?: string
  tasksMode?: "none" | "invoke-agent"
  tasksNotifySuccess?: boolean
  dmSpaceName?: string
  agentcoreRuntimeId?: string
}

interface ClassifyResult {
  decision: {
    label: string
  }
}

const { classifyAndLabel, processUser } = jest.requireActual<{
  classifyAndLabel: (
    state: TestTriageRow,
    accessToken: string,
    message: { id: string; threadId: string }
  ) => Promise<ClassifyResult | null>
  processUser: (state: TestTriageRow) => Promise<void>
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
    mockGetFreshAccessToken.mockResolvedValue({ access_token: "token" })
    mockGetMessageFullBody.mockResolvedValue("Full message body")
    mockClaimTaskGesture.mockResolvedValue(true)
    mockGetUserProfile.mockResolvedValue({
      workspacePrefix: "owner-a1b2c3d4",
    })
    mockRecordPollResult.mockResolvedValue(undefined)
    mockRecordTaskCreated.mockResolvedValue(undefined)
    mockReleaseTaskGestureClaim.mockResolvedValue(undefined)
    mockStampTrustedTriageLabelMapping.mockResolvedValue(undefined)
    mockPostTaskOutcome.mockResolvedValue(undefined)
    mockModifyThread.mockResolvedValue(undefined)
    mockListHistory.mockResolvedValue({
      events: [],
      latestHistoryId: "101",
      tooOld: false,
    })
  })

  it("heals a legacy mapping and continues the poll in the same tick", async () => {
    await processUser(
      row({
        labelMappingVersion: undefined,
        labelMappingProvenance: undefined,
        labelMappingOwnerEmail: undefined,
        labelMappingResolvedAt: undefined,
        lastHistoryId: "100",
      })
    )

    expect(mockStampTrustedTriageLabelMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: TRIAGE_LABEL_NAMES,
        labelIdsByKey: IDS,
        labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
        labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
        labelMappingOwnerEmail: "owner@example.com",
        labelMappingResolvedAt: expect.any(String),
      })
    )
    expect(mockListHistory).toHaveBeenCalledWith("token", "100")
    expect(mockRecordPollResult).toHaveBeenCalledWith(
      "owner@example.com",
      expect.objectContaining({ lastHistoryId: "101" }),
      [],
      []
    )
  })

  it("fails closed without stamping when live labels are ambiguous", async () => {
    mockListLabels.mockResolvedValue([
      ...liveLabels(),
      {
        id: "Label_important_duplicate",
        name: TRIAGE_LABEL_NAMES.important,
        type: "user",
      },
    ])

    await processUser(
      row({
        labelMappingVersion: undefined,
        lastHistoryId: "100",
      })
    )

    expect(mockStampTrustedTriageLabelMapping).not.toHaveBeenCalled()
    expect(mockListHistory).not.toHaveBeenCalled()
    expect(mockRecordPollResult).not.toHaveBeenCalled()
  })

  it("passes through a valid row without a provenance write", async () => {
    await processUser(row({ lastHistoryId: "100" }))

    expect(mockListLabels).toHaveBeenCalledTimes(1)
    expect(mockStampTrustedTriageLabelMapping).not.toHaveBeenCalled()
    expect(mockListHistory).toHaveBeenCalledWith("token", "100")
    expect(mockRecordPollResult).toHaveBeenCalled()
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

describe("agent triage task gestures", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListLabels.mockResolvedValue(liveLabels())
    mockGetFreshAccessToken.mockResolvedValue({ access_token: "token" })
    mockListHistory.mockResolvedValue({
      events: [
        {
          labelsAdded: [
            {
              labelIds: [IDS.task],
              message: {
                id: "message-1",
                labelIds: ["INBOX", IDS.task],
                threadId: "thread-1",
              },
            },
          ],
        },
      ],
      latestHistoryId: "101",
      tooOld: false,
    })
    mockGetMessageMetadata.mockResolvedValue({
      id: "message-1",
      threadId: "thread-1",
      labelIds: ["INBOX", IDS.task],
      snippet: "Preview",
    })
    mockGetMessageFullBody.mockResolvedValue("Full task request")
    mockClaimTaskGesture.mockResolvedValue(true)
    mockGetUserProfile.mockResolvedValue({
      workspacePrefix: "owner-a1b2c3d4",
    })
    mockRecordPollResult.mockResolvedValue(undefined)
    mockRecordTaskCreated.mockResolvedValue(undefined)
    mockReleaseTaskGestureClaim.mockResolvedValue(undefined)
    mockPostTaskOutcome.mockResolvedValue(undefined)
    mockModifyThread.mockResolvedValue(undefined)
  })

  it("archives and records a successful task after advancing the cursor", async () => {
    mockRequestTaskCreation.mockResolvedValue({
      ok: true,
      taskRef: "TASK-42",
    })

    await processUser(
      row({
        lastHistoryId: "100",
        tasksMode: "invoke-agent",
        tasksNotifySuccess: true,
        dmSpaceName: "spaces/dm-1",
      })
    )

    expect(mockRecordPollResult).toHaveBeenCalledWith(
      "owner@example.com",
      expect.objectContaining({ lastHistoryId: "101" }),
      [],
      []
    )
    expect(mockModifyThread).toHaveBeenCalledWith(
      "token",
      "thread-1",
      [],
      ["INBOX", IDS.task]
    )
    expect(mockRecordTaskCreated).toHaveBeenCalledWith(
      "owner@example.com",
      "message-1",
      "TASK-42",
      expect.any(String)
    )
    expect(
      mockRecordPollResult.mock.invocationCallOrder[0]
    ).toBeLessThan(mockClaimTaskGesture.mock.invocationCallOrder[0])
  })

  it("releases a failed task claim and leaves Gmail unchanged", async () => {
    mockRequestTaskCreation.mockResolvedValue({
      ok: false,
      reason: "Task provider unavailable",
    })

    await processUser(
      row({
        lastHistoryId: "100",
        tasksMode: "invoke-agent",
        dmSpaceName: "spaces/dm-1",
      })
    )

    expect(mockReleaseTaskGestureClaim).toHaveBeenCalledWith(
      "owner@example.com",
      "message-1"
    )
    expect(mockModifyThread).not.toHaveBeenCalled()
    expect(mockRecordTaskCreated).not.toHaveBeenCalled()
    expect(mockPostTaskOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        dmSpaceName: "spaces/dm-1",
        messageId: "message-1",
        ok: false,
        reason: "Task provider unavailable",
      })
    )
  })
})
