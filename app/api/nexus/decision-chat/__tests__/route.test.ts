/**
 * @jest-environment node
 *
 * Tests for POST /api/nexus/decision-chat:
 *  - REV-SEC-141: a client-supplied conversationId owned by a different user is
 *    rejected (404) before any message is written.
 *  - REV-COR-228: the onFinish callback persists multi-step tool turns via
 *    saveConversationSteps (steps.length > 1), mirroring the main chat route, instead
 *    of collapsing them into a single assistant message.
 */

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock('@/actions/db/get-current-user-action', () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockHasCapabilityAccess = jest.fn()
jest.mock('@/utils/roles', () => ({
  hasCapabilityAccess: (...a: unknown[]) => mockHasCapabilityAccess(...a),
}))

const mockGetRequiredSetting = jest.fn()
jest.mock('@/lib/settings-manager', () => ({
  getRequiredSetting: (...a: unknown[]) => mockGetRequiredSetting(...a),
}))

const mockGetModelConfig = jest.fn()
jest.mock('@/lib/ai/model-config', () => ({
  getModelConfig: (...a: unknown[]) => mockGetModelConfig(...a),
}))

const mockGetConversationById = jest.fn()
jest.mock('@/lib/db/drizzle/nexus-conversations', () => ({
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
}))

const mockProcessMessagesWithAttachments = jest.fn()
jest.mock('@/lib/services/attachment-storage-service', () => ({
  processMessagesWithAttachments: (...a: unknown[]) => mockProcessMessagesWithAttachments(...a),
}))

let capturedStreamRequest: { callbacks?: { onFinish?: (e: unknown) => Promise<void> } } | undefined
const mockStream = jest.fn()
jest.mock('@/lib/streaming/unified-streaming-service', () => ({
  unifiedStreamingService: { stream: (...a: unknown[]) => mockStream(...a) },
}))

const mockGetDecisionFrameworkPrompt = jest.fn()
jest.mock('@/lib/graph/decision-framework', () => ({
  getDecisionFrameworkPrompt: (...a: unknown[]) => mockGetDecisionFrameworkPrompt(...a),
}))

const mockCreateDecisionCaptureTools = jest.fn()
jest.mock('@/lib/tools/decision-capture-tools', () => ({
  createDecisionCaptureTools: (...a: unknown[]) => mockCreateDecisionCaptureTools(...a),
}))

const mockSaveUserMessage = jest.fn()
const mockSaveAssistantMessage = jest.fn()
const mockSaveConversationSteps = jest.fn()
const mockCreateConversation = jest.fn()
jest.mock('../../chat/chat-helpers', () => ({
  generateConversationTitle: () => 'Title',
  createConversation: (...a: unknown[]) => mockCreateConversation(...a),
  extractUserContent: () => ({ content: 'hi', parts: [{ type: 'text', text: 'hi' }] }),
  saveUserMessage: (...a: unknown[]) => mockSaveUserMessage(...a),
  convertMessagesToPartsFormat: (m: unknown) => m,
  saveAssistantMessage: (...a: unknown[]) => mockSaveAssistantMessage(...a),
  saveConversationSteps: (...a: unknown[]) => mockSaveConversationSteps(...a),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  generateRequestId: jest.fn(() => 'rid'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d: unknown) => d),
}))

import { POST } from '../route'

const CONVO = 'dddddddd-1111-4111-8111-dddddddddddd'

function req(conversationId: string | null) {
  return {
    json: async () => ({
      messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      conversationId,
    }),
  } as unknown as Request
}

describe('POST /api/nexus/decision-chat (REV-SEC-141 / REV-COR-228)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    capturedStreamRequest = undefined
    mockGetServerSession.mockResolvedValue({ sub: 'caller-sub' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockGetRequiredSetting.mockResolvedValue('decision-model')
    mockGetModelConfig.mockResolvedValue({ id: 9, provider: 'google', model_id: 'gemini', capabilities: {} })
    mockProcessMessagesWithAttachments.mockResolvedValue({ lightweightMessages: [] })
    mockGetDecisionFrameworkPrompt.mockResolvedValue('framework')
    mockCreateDecisionCaptureTools.mockReturnValue({})
    mockStream.mockImplementation(async (streamRequest: unknown) => {
      capturedStreamRequest = streamRequest as { callbacks?: { onFinish?: (e: unknown) => Promise<void> } }
      return {
        capabilities: { supportsReasoning: false },
        result: { toUIMessageStreamResponse: () => new Response('stream', { status: 200 }) },
      }
    })
  })

  it('rejects a conversationId owned by a different user with 404 and writes nothing (REV-SEC-141)', async () => {
    mockGetConversationById.mockResolvedValue(null) // not owned by caller

    const res = await POST(req(CONVO))

    expect(res.status).toBe(404)
    // Ownership query filters by BOTH id and userId.
    expect(mockGetConversationById).toHaveBeenCalledWith(CONVO, 1)
    // No message written, no streaming started.
    expect(mockSaveUserMessage).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('lets the owner save into their own existing conversation (REV-SEC-141)', async () => {
    mockGetConversationById.mockResolvedValue({ id: CONVO, userId: 1 })

    const res = await POST(req(CONVO))

    expect(res.status).toBe(200)
    expect(mockSaveUserMessage).toHaveBeenCalledTimes(1)
    expect(mockStream).toHaveBeenCalledTimes(1)
  })

  it('onFinish persists a multi-step turn via saveConversationSteps (REV-COR-228)', async () => {
    mockGetConversationById.mockResolvedValue({ id: CONVO, userId: 1 })
    await POST(req(CONVO))

    const onFinish = capturedStreamRequest?.callbacks?.onFinish
    expect(typeof onFinish).toBe('function')

    await onFinish!({
      text: 'done',
      usage: { totalTokens: 3 },
      finishReason: 'stop',
      steps: [{ text: 'a' }, { text: 'b' }], // > 1 step
    })

    expect(mockSaveConversationSteps).toHaveBeenCalledTimes(1)
    expect(mockSaveAssistantMessage).not.toHaveBeenCalled()
  })

  it('onFinish persists a single-step turn via saveAssistantMessage (REV-COR-228)', async () => {
    mockGetConversationById.mockResolvedValue({ id: CONVO, userId: 1 })
    await POST(req(CONVO))

    const onFinish = capturedStreamRequest?.callbacks?.onFinish
    await onFinish!({ text: 'just text', usage: {}, finishReason: 'stop' }) // no steps

    expect(mockSaveAssistantMessage).toHaveBeenCalledTimes(1)
    expect(mockSaveConversationSteps).not.toHaveBeenCalled()
  })
})
