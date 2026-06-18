import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals'
import type { ActionState } from '@/types'

const mockExecuteQuery = jest.fn(() => Promise.resolve([]))
const mockExecuteTransaction = jest.fn((fn) => fn({
  delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
}))
const mockDeleteAssistantArchitect = jest.fn(() => Promise.resolve(true))
const mockGetAssistantArchitectById = jest.fn()
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockGetCurrentUserAction = jest.fn(() => Promise.resolve({}))
const mockGetServerSession = jest.fn(() => Promise.resolve(null))

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: mockGetServerSession
}))

jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: mockExecuteQuery,
  executeTransaction: mockExecuteTransaction,
}))

jest.mock('@/lib/db/drizzle', () => ({
  getAssistantArchitectById: mockGetAssistantArchitectById,
  deleteAssistantArchitect: mockDeleteAssistantArchitect,
}))

jest.mock('@/utils/roles', () => ({
  hasRole: mockHasRole,
  hasToolAccess: jest.fn(),
}))

jest.mock('@/actions/db/get-current-user-action', () => ({
  getCurrentUserAction: mockGetCurrentUserAction
}))

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }),
  generateRequestId: () => 'test-id',
  startTimer: () => jest.fn(),
  sanitizeForLogging: (x: unknown) => x,
}))

jest.mock('@/lib/db/schema', () => ({
  tools: { id: 'id', promptChainToolId: 'prompt_chain_tool_id' },
  capabilities: { promptChainToolId: 'prompt_chain_tool_id' },
  roleTools: { toolId: 'tool_id' },
  navigationItems: { link: 'link' },
  navigationItemRoles: { navigationItemId: 'navigation_item_id' },
  toolInputFields: { assistantArchitectId: 'assistant_architect_id' },
  chainPrompts: { assistantArchitectId: 'assistant_architect_id' },
  assistantArchitects: { id: 'id' },
  userRoles: {},
  toolExecutions: { assistantArchitectId: 'assistant_architect_id' },
  promptResults: { promptId: 'prompt_id' },
  roleCapabilities: {},
}))

describe('deleteAssistantArchitectAction', () => {
  // Definite assignment: beforeAll assigns this before any it() runs.
  let deleteAssistantArchitectAction!: (id: string) => Promise<ActionState<void>>

  beforeAll(async () => {
    const module = await import('@/actions/db/assistant-architect-actions')
    deleteAssistantArchitectAction = module.deleteAssistantArchitectAction
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockExecuteTransaction.mockImplementation((fn) => fn({
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }))
  })

  it('returns error when no session', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const result = await deleteAssistantArchitectAction('1')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toContain('sign in')
  })

  it('returns error for invalid ID', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    const result = await deleteAssistantArchitectAction('not-a-number')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Invalid assistant ID')
  })

  it('returns error when assistant not found', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    mockGetAssistantArchitectById.mockResolvedValue(null)
    const result = await deleteAssistantArchitectAction('99')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Assistant not found')
  })

  it('blocks non-admin from deleting approved assistant', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 1, userId: 1, status: 'approved' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasRole.mockResolvedValue(false)
    const result = await deleteAssistantArchitectAction('1')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Only draft or rejected assistants can be deleted')
  })

  it('blocks non-admin from deleting pending_approval assistant', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 1, userId: 1, status: 'pending_approval' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasRole.mockResolvedValue(false)
    const result = await deleteAssistantArchitectAction('1')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Only draft or rejected assistants can be deleted')
  })

  it('allows admin to delete approved assistant (issue #1000 fix)', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'admin-1' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 5, userId: 99, status: 'approved' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasRole.mockResolvedValue(true)
    mockDeleteAssistantArchitect.mockResolvedValue({ id: 5 })
    const result = await deleteAssistantArchitectAction('5')
    expect(result.isSuccess).toBe(true)
    expect(mockDeleteAssistantArchitect).toHaveBeenCalledWith(5)
  })

  it('allows admin to delete pending_approval assistant', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'admin-1' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 7, userId: 99, status: 'pending_approval' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasRole.mockResolvedValue(true)
    mockDeleteAssistantArchitect.mockResolvedValue({ id: 7 })
    const result = await deleteAssistantArchitectAction('7')
    expect(result.isSuccess).toBe(true)
  })

  it('allows owner to delete their draft assistant', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-1' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 2, userId: 42, status: 'draft' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 42 } } })
    mockHasRole.mockResolvedValue(false)
    mockDeleteAssistantArchitect.mockResolvedValue({ id: 2 })
    const result = await deleteAssistantArchitectAction('2')
    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('Assistant architect deleted successfully')
  })

  it('blocks non-owner non-admin from deleting draft assistant', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-2' })
    mockGetAssistantArchitectById.mockResolvedValue({ id: 3, userId: 99, status: 'draft' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 42 } } })
    mockHasRole.mockResolvedValue(false)
    const result = await deleteAssistantArchitectAction('3')
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('You can only delete your own assistants')
  })
})
