// @ts-nocheck - This test file is marked .skip and needs to be updated for Drizzle ORM
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Create simple mock functions
const mockExecuteQuery = jest.fn(() => Promise.resolve([]))
const mockDeleteAssistantArchitect = jest.fn(() => Promise.resolve(true))
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockGetCurrentUserAction = jest.fn(() => Promise.resolve({}))
const mockGetServerSession = jest.fn(() => Promise.resolve(null))

// Mock all dependencies
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: mockGetServerSession
}))

jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: mockExecuteQuery
}))

jest.mock('@/lib/db/drizzle', () => ({
  deleteAssistantArchitect: mockDeleteAssistantArchitect
}))

jest.mock('@/lib/auth/role-helpers', () => ({
  hasRole: mockHasRole
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
  startTimer: () => jest.fn()
}))

describe.skip('Assistant Architect Delete Action [NEEDS UPDATE FOR DRIZZLE]', () => {
  let deleteAssistantArchitectAction: (id: string) => Promise<{ isSuccess: boolean; message: string }>

  beforeAll(async () => {
    // Mock the dynamic imports at the module level
    jest.doMock('@/actions/db/get-current-user-action', () => ({
      getCurrentUserAction: mockGetCurrentUserAction
    }))

    jest.doMock('@/lib/db/drizzle-client', () => ({
      executeQuery: mockExecuteQuery
    }))

    jest.doMock('@/lib/db/drizzle', () => ({
      deleteAssistantArchitect: mockDeleteAssistantArchitect
    }))

    jest.doMock('@/lib/auth/role-helpers', () => ({
      hasRole: mockHasRole
    }))

    // Now import the function
    const module = await import('@/actions/db/assistant-architect-actions')
    deleteAssistantArchitectAction = module.deleteAssistantArchitectAction
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should delete a draft assistant successfully', async () => {
    // Setup session
    mockGetServerSession.mockResolvedValue({ sub: 'user-123' })

    // Setup Drizzle query response for getting assistant
    mockExecuteQuery.mockResolvedValueOnce([{ userId: 1, status: 'draft' }])

    // Setup current user
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: 1 } }
    })

    // Setup no admin access
    mockHasRole.mockResolvedValue(false)

    // Setup successful deletion
    mockDeleteAssistantArchitect.mockResolvedValue(true)

    // Execute
    const result = await deleteAssistantArchitectAction('1')

    // Verify
    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('Assistant architect deleted successfully')
  })

  it('should handle missing session', async () => {
    mockGetServerSession.mockResolvedValue(null)
    
    const result = await deleteAssistantArchitectAction('1')
    
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Please sign in to delete assistants')
  })

  it('should handle invalid ID', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-123' })
    
    const result = await deleteAssistantArchitectAction('invalid')
    
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Invalid assistant ID')
  })

  it('should handle assistant not found', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-123' })
    mockExecuteQuery.mockResolvedValue([])
    
    const result = await deleteAssistantArchitectAction('1')
    
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Assistant not found')
  })

  it('should prevent deleting approved assistants', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-123' })
    mockExecuteQuery.mockResolvedValue([{ userId: 1, status: 'approved' }])
    
    const result = await deleteAssistantArchitectAction('1')
    
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('Only draft or rejected assistants can be deleted')
  })

  it('should prevent non-owners from deleting', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'user-123' })
    mockExecuteQuery.mockResolvedValue([{ userId: 1, status: 'draft' }])
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: 2 } } // Different user
    })
    mockHasRole.mockResolvedValue(false)
    
    const result = await deleteAssistantArchitectAction('1')
    
    expect(result.isSuccess).toBe(false)
    expect(result.message).toBe('You can only delete your own assistants')
  })

  it('should allow admins to delete', async () => {
    mockGetServerSession.mockResolvedValue({ sub: 'admin-123' })
    mockExecuteQuery.mockResolvedValueOnce([{ userId: 1, status: 'draft' }])
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: 2 } } // Different user
    })
    mockHasRole.mockResolvedValue(true) // Admin access
    mockDeleteAssistantArchitect.mockResolvedValue(true)
    
    const result = await deleteAssistantArchitectAction('1')
    
    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('Assistant architect deleted successfully')
  })
})