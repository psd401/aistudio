/**
 * @jest-environment node
 *
 * Authorization on assistant-architect mutating actions:
 *   REV-COR-031 / REV-SEC-041 — addChainPromptAction requires a session + admin-
 *     or-creator ownership on ALL input shapes (unauthenticated stored-prompt
 *     injection / IDOR write).
 *   REV-COR-033 — setPromptPositionsAction must scope caller-supplied prompt IDs
 *     to the authorized tool (confused-deputy cross-tool write).
 *   REV-COR-036 — updatePromptResultAction must scope the write to the caller's
 *     own execution (IDOR).
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals'
import type { ActionState } from '@/types'

const mockGetServerSession = jest.fn(() => Promise.resolve(null as { sub: string } | null))
const mockGetAssistantArchitectById = jest.fn<() => Promise<unknown>>()
const mockGetChainPrompts = jest.fn<() => Promise<Array<{ id: number }>>>(() => Promise.resolve([]))
const mockCreateChainPrompt = jest.fn<() => Promise<unknown>>()
const mockUpdateChainPrompt = jest.fn<() => Promise<unknown>>()
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockGetCurrentUserAction = jest.fn(() => Promise.resolve({ isSuccess: true, data: { user: { id: 1 } } } as unknown))
const mockExecuteQuery = jest.fn(
  (_fn: unknown, label?: string) =>
    Promise.resolve(label === 'getExecutionOwnerForResultUpdate' ? [{ userId: 999 }] : [])
)

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: mockExecuteQuery,
  executeTransaction: jest.fn(),
  toPgRows: (x: unknown) => x,
}))
jest.mock('@/lib/db/drizzle', () => ({
  getAssistantArchitectById: mockGetAssistantArchitectById,
  getChainPrompts: mockGetChainPrompts,
  createChainPrompt: mockCreateChainPrompt,
  updateChainPrompt: mockUpdateChainPrompt,
}))
jest.mock('@/utils/roles', () => ({ hasRole: mockHasRole, hasCapabilityAccess: jest.fn(() => Promise.resolve(true)) }))
jest.mock('@/actions/db/get-current-user-action', () => ({ getCurrentUserAction: mockGetCurrentUserAction }))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({}),
}))
jest.mock('@/lib/db/schema', () => ({
  toolExecutions: { id: 'id', userId: 'user_id' },
  promptResults: { executionId: 'execution_id', promptId: 'prompt_id' },
  chainPrompts: { id: 'id', assistantArchitectId: 'assistant_architect_id' },
  navigationItems: { id: 'id', link: 'link' },
  toolInputFields: { id: 'id', assistantArchitectId: 'assistant_architect_id' },
  assistantArchitects: { id: 'id' },
  capabilities: {},
  roleCapabilities: {},
  userRoles: {},
}))

const promptData = {
  name: 'p', content: 'c', modelId: 1, position: 0,
}

describe('assistant-architect mutation authorization', () => {
  let mod: typeof import('@/actions/db/assistant-architect-actions')
  beforeAll(async () => { mod = await import('@/actions/db/assistant-architect-actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    mockHasRole.mockResolvedValue(false)
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockExecuteQuery.mockImplementation((_fn: unknown, label?: string) =>
      Promise.resolve(label === 'getExecutionOwnerForResultUpdate' ? [{ userId: 999 }] : [])
    )
  })

  // REV-COR-031 / REV-SEC-041
  it('addChainPromptAction rejects an unauthenticated caller (no session) with no repositoryIds', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res: ActionState<void> = await mod.addChainPromptAction('5', { ...promptData })
    expect(res.isSuccess).toBe(false)
    expect(mockCreateChainPrompt).not.toHaveBeenCalled()
  })

  it('addChainPromptAction rejects a non-owner, non-admin caller (no row inserted)', async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 5, userId: 999, status: 'approved' })
    const res = await mod.addChainPromptAction('5', { ...promptData })
    expect(res.isSuccess).toBe(false)
    expect(mockCreateChainPrompt).not.toHaveBeenCalled()
  })

  it('addChainPromptAction allows the owner to add a prompt', async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 5, userId: 1, status: 'draft' })
    mockCreateChainPrompt.mockResolvedValue({ id: 10 })
    const res = await mod.addChainPromptAction('5', { ...promptData })
    expect(res.isSuccess).toBe(true)
    expect(mockCreateChainPrompt).toHaveBeenCalledTimes(1)
  })

  // REV-COR-033
  it('setPromptPositionsAction rejects prompt IDs that belong to another tool', async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 5, userId: 1 }) // caller owns tool A
    mockGetChainPrompts.mockResolvedValue([{ id: 100 }, { id: 101 }]) // tool A's prompts
    const res = await mod.setPromptPositionsAction('5', [{ id: '999', position: 3 }]) // B's prompt
    expect(res.isSuccess).toBe(false)
    expect(mockUpdateChainPrompt).not.toHaveBeenCalled()
  })

  it('setPromptPositionsAction accepts the tool\'s own prompt IDs', async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 5, userId: 1 })
    mockGetChainPrompts.mockResolvedValue([{ id: 100 }, { id: 101 }])
    mockUpdateChainPrompt.mockResolvedValue({ id: 100 })
    const res = await mod.setPromptPositionsAction('5', [{ id: '100', position: 3 }])
    expect(res.isSuccess).toBe(true)
    expect(mockUpdateChainPrompt).toHaveBeenCalledTimes(1)
  })

  // REV-COR-036
  it('updatePromptResultAction refuses to write another user\'s execution', async () => {
    // ownership select returns userId 999; caller is 1 → not-found, no update.
    const res = await mod.updatePromptResultAction('42', 7, { result: 'x' })
    expect(res.isSuccess).toBe(false)
    // Only the ownership SELECT ran — the UPDATE executeQuery was never reached.
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
  })

  it('updatePromptResultAction updates the caller\'s own execution', async () => {
    mockExecuteQuery.mockImplementation((_fn: unknown, label?: string) =>
      Promise.resolve(label === 'getExecutionOwnerForResultUpdate' ? [{ userId: 1 }] : [])
    )
    const res = await mod.updatePromptResultAction('42', 7, { result: 'x' })
    expect(res.isSuccess).toBe(true)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2) // ownership select + update
  })
})
