/**
 * @jest-environment node
 *
 * Tests the job-poll fallback save idempotency (REV-COR-226). A completed job whose
 * assistant response was not yet persisted is saved via an upsert keyed on a
 * deterministic `job-<jobId>` id, so concurrent completed-status polls converge on a
 * single nexus_messages row instead of the previous racy SELECT-then-INSERT.
 */

const mockAuthenticatePollingRequest = jest.fn()
const mockValidateJobOwnership = jest.fn()
jest.mock('@/lib/auth/optimized-polling-auth', () => ({
  authenticatePollingRequest: (...a: unknown[]) => mockAuthenticatePollingRequest(...a),
  validateJobOwnership: (...a: unknown[]) => mockValidateJobOwnership(...a),
}))

const mockGetJob = jest.fn()
const mockGetOptimalPollingInterval = jest.fn()
jest.mock('@/lib/streaming/job-management-service', () => ({
  jobManagementService: {
    getJob: (...a: unknown[]) => mockGetJob(...a),
    getOptimalPollingInterval: (...a: unknown[]) => mockGetOptimalPollingInterval(...a),
  },
}))

const mockExecuteQuery = jest.fn()
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: (...a: unknown[]) => mockExecuteQuery(...a),
}))

const mockUpsertMessageWithStats = jest.fn()
jest.mock('@/lib/db/drizzle', () => ({
  upsertMessageWithStats: (...a: unknown[]) => mockUpsertMessageWithStats(...a),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  generateRequestId: jest.fn(() => 'rid'),
  startTimer: jest.fn(() => jest.fn()),
}))

import { GET } from '../route'

const JOB_ID = 'job-uuid-1'
const CONVO = 'convo-1'

function ctx() {
  return { params: Promise.resolve({ jobId: JOB_ID }) }
}

function completedJob() {
  return {
    id: JOB_ID,
    userId: 1,
    status: 'completed',
    modelId: 9,
    nexusConversationId: CONVO,
    responseData: { text: 'the final answer', usage: { totalTokens: 5 }, finishReason: 'stop' },
    partialContent: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

describe('GET nexus job poll fallback idempotency (REV-COR-226)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthenticatePollingRequest.mockResolvedValue({ isAuthorized: true, userId: 1, authMethod: 'cache', authTime: 1 })
    mockValidateJobOwnership.mockReturnValue({ authorized: true })
    mockGetOptimalPollingInterval.mockResolvedValue(1000)
    mockUpsertMessageWithStats.mockResolvedValue({})
  })

  it('saves the fallback assistant message via upsert keyed on a deterministic job id', async () => {
    mockGetJob.mockResolvedValue(completedJob())
    // No existing assistant message yet → fallback save path runs.
    mockExecuteQuery.mockResolvedValue([])

    await GET({} as Request, ctx())

    expect(mockUpsertMessageWithStats).toHaveBeenCalledTimes(1)
    // Deterministic id derived from the job — concurrent polls converge on this row.
    expect(mockUpsertMessageWithStats.mock.calls[0][0]).toBe(`job-${JOB_ID}`)
    expect(mockUpsertMessageWithStats.mock.calls[0][1]).toBe(CONVO)
    expect(mockUpsertMessageWithStats.mock.calls[0][2]).toMatchObject({ role: 'assistant' })
  })

  it('does not save when an assistant message already exists (stream onFinish saved it)', async () => {
    mockGetJob.mockResolvedValue(completedJob())
    mockExecuteQuery.mockResolvedValue([{ id: 'already-saved' }])

    await GET({} as Request, ctx())

    expect(mockUpsertMessageWithStats).not.toHaveBeenCalled()
  })
})
