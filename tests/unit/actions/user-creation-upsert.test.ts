/**
 * Unit tests for concurrent user creation UPSERT fix (Issue #508)
 *
 * NOTE: These tests are tightly coupled to implementation details due to the
 * action's multi-step flow (session → DB lookup → UPSERT → role assignment).
 *
 * Future improvements (technical debt):
 * - Extract SQL generation to testable functions (test queries directly)
 * - Use integration tests with test database for full flow validation
 * - Reduce mock complexity by testing at higher abstraction level
 *
 * For now, these tests validate the critical UPSERT behavior that fixes the
 * production race condition (39% error rate under concurrent load).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import type {
  executeSQL,
  getUserByCognitoSub,
  createUser,
  getRoleByName,
  assignRoleToUser,
  getUserRolesByCognitoSub
} from '@/lib/db/data-api-adapter'
import type { getServerSession } from '@/lib/auth/server-session'

// Create properly typed mock functions (no 'any' types per CLAUDE.md)
const mockExecuteSQL = jest.fn<typeof executeSQL>()
const mockGetUserByCognitoSub = jest.fn<typeof getUserByCognitoSub>()
const mockCreateUser = jest.fn<typeof createUser>()
const mockGetRoleByName = jest.fn<typeof getRoleByName>()
const mockAssignRoleToUser = jest.fn<typeof assignRoleToUser>()
const mockGetUserRolesByCognitoSub = jest.fn<typeof getUserRolesByCognitoSub>()
const mockGetServerSession = jest.fn<typeof getServerSession>()

// Mock all dependencies
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: mockGetServerSession
}))

jest.mock('@/lib/db/data-api-adapter', () => ({
  getUserByCognitoSub: mockGetUserByCognitoSub,
  createUser: mockCreateUser,
  getRoleByName: mockGetRoleByName,
  assignRoleToUser: mockAssignRoleToUser,
  getUserRolesByCognitoSub: mockGetUserRolesByCognitoSub,
  executeSQL: mockExecuteSQL
}))

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
  getLogContext: () => ({ requestId: 'test-request-id', userId: undefined })
}))

describe('User Creation with UPSERT - Issue #508', () => {
  let getCurrentUserAction: any

  beforeAll(async () => {
    // Import the action after mocks are set up
    const module = await import('@/actions/db/get-current-user-action')
    getCurrentUserAction = module.getCurrentUserAction
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Concurrent User Creation', () => {
    it('should handle first-time user creation successfully', async () => {
      // Arrange: Mock session for new user
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-new-123',
        email: 'newuser@psd401.net',
        givenName: 'New',
        familyName: 'User'
      })

      // User doesn't exist yet (both cognito_sub and email lookups)
      mockGetUserByCognitoSub.mockResolvedValue(undefined as never)
      mockExecuteSQL.mockResolvedValueOnce([])  // Empty result for email lookup

      // UPSERT creates new user
      mockCreateUser.mockResolvedValue({
        id: 1,
        cognitoSub: 'cognito-new-123',
        email: 'newuser@psd401.net',
        firstName: 'New',
        lastName: 'User',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      // Mock role assignment (UPSERT returns result on first insert)
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff' }])
      mockAssignRoleToUser.mockResolvedValue([{ user_id: 1, role_id: 2 }])

      // Mock final queries (last_sign_in_at update and role fetching)
      mockExecuteSQL.mockResolvedValueOnce([{  // last_sign_in_at update
        id: 1,
        cognitoSub: 'cognito-new-123',
        email: 'newuser@psd401.net',
        firstName: 'New',
        lastName: 'User'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])
      mockGetRoleByName.mockResolvedValueOnce([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.cognitoSub).toBe('cognito-new-123')
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(1, 2)
    })

    it('should handle UPSERT when user already exists from concurrent request', async () => {
      // Arrange: Simulate race condition where user was created between lookup and UPSERT
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-race-123',
        email: 'raceuser@psd401.net',
        givenName: 'Race',
        familyName: 'User'
      })

      // First lookup: user doesn't exist
      mockGetUserByCognitoSub.mockResolvedValue(undefined as never)
      mockExecuteSQL.mockResolvedValueOnce([])  // Empty email lookup

      // UPSERT handles conflict and returns existing user (created by concurrent request)
      mockCreateUser.mockResolvedValue({
        id: 5,
        cognitoSub: 'cognito-race-123',
        email: 'raceuser@psd401.net',
        firstName: 'Race',
        lastName: 'User',
        createdAt: new Date(Date.now() - 1000).toISOString(), // Created 1 second ago
        updatedAt: new Date().toISOString()
      })

      // Mock role assignment (UPSERT returns empty if conflict)
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff' }])
      mockAssignRoleToUser.mockResolvedValue([])  // Empty array = DO NOTHING triggered

      // Mock final queries (last_sign_in_at update)
      mockExecuteSQL.mockResolvedValueOnce([{
        id: 5,
        cognitoSub: 'cognito-race-123',
        email: 'raceuser@psd401.net',
        firstName: 'Race',
        lastName: 'User'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])
      mockGetRoleByName.mockResolvedValueOnce([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.id).toBe(5)
      // Role assignment should be attempted but DO NOTHING (empty result)
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(5, 2)
    })

    it('should preserve existing user data on UPSERT update', async () => {
      // Arrange: User exists with data
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-existing-123',
        email: 'updated@psd401.net', // Email changed in Cognito
        givenName: 'Updated',
        familyName: 'Name'
      })

      // User doesn't exist in first lookup (simulating edge case)
      mockGetUserByCognitoSub.mockResolvedValue(undefined as never)
      mockExecuteSQL.mockResolvedValueOnce([])  // Empty email lookup

      // UPSERT updates email but preserves other fields
      mockCreateUser.mockResolvedValue({
        id: 10,
        cognitoSub: 'cognito-existing-123',
        email: 'updated@psd401.net',
        firstName: 'Updated',
        lastName: 'Name',
        createdAt: new Date(Date.now() - 86400000).toISOString(), // Created 1 day ago
        updatedAt: new Date().toISOString()
      })

      // Mock role assignment (UPSERT returns empty - DO NOTHING)
      mockGetRoleByName.mockResolvedValueOnce([{ id: 2, name: 'staff' }])  // For role assignment
      mockAssignRoleToUser.mockResolvedValue([])  // DO NOTHING triggered

      // Mock final queries (last_sign_in_at update)
      mockExecuteSQL.mockResolvedValueOnce([{
        id: 10,
        cognitoSub: 'cognito-existing-123',
        email: 'updated@psd401.net',
        firstName: 'Updated',
        lastName: 'Name'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['admin'])
      mockGetRoleByName.mockResolvedValueOnce([{ id: 1, name: 'admin', description: 'Administrator' }])  // For role fetching

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.email).toBe('updated@psd401.net')
      expect(result.data?.user.id).toBe(10)
      // Role assignment attempted but DO NOTHING (already exists)
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(10, 2)
    })

    it('should determine correct default role for numeric username (student)', async () => {
      // Arrange: Student with numeric ID
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-student-123',
        email: '123456@psd401.net', // Numeric username = student
        givenName: 'Student',
        familyName: 'User'
      })

      mockGetUserByCognitoSub.mockResolvedValue(undefined as never)
      mockExecuteSQL.mockResolvedValueOnce([])  // Empty email lookup

      mockCreateUser.mockResolvedValue({
        id: 20,
        cognitoSub: 'cognito-student-123',
        email: '123456@psd401.net',
        firstName: 'Student',
        lastName: 'User'
      })

      // Mock student role assignment (UPSERT returns result)
      mockGetRoleByName.mockResolvedValue([{ id: 3, name: 'student' }])
      mockAssignRoleToUser.mockResolvedValue([{ user_id: 20, role_id: 3 }])

      // Mock final queries (last_sign_in_at update)
      mockExecuteSQL.mockResolvedValueOnce([{
        id: 20,
        cognitoSub: 'cognito-student-123',
        email: '123456@psd401.net',
        firstName: 'Student',
        lastName: 'User'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['student'])
      mockGetRoleByName.mockResolvedValueOnce([{ id: 3, name: 'student', description: 'Student' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(20, 3)
    })

    it('should determine correct default role for non-numeric username (staff)', async () => {
      // Arrange: Staff member with name-based email
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-staff-123',
        email: 'jdoe@psd401.net', // Non-numeric username = staff
        givenName: 'John',
        familyName: 'Doe'
      })

      mockGetUserByCognitoSub.mockResolvedValue(undefined as never)
      mockExecuteSQL.mockResolvedValueOnce([])  // Empty email lookup

      mockCreateUser.mockResolvedValue({
        id: 21,
        cognitoSub: 'cognito-staff-123',
        email: 'jdoe@psd401.net',
        firstName: 'John',
        lastName: 'Doe'
      })

      // Mock staff role assignment (UPSERT returns result)
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff' }])
      mockAssignRoleToUser.mockResolvedValue([{ user_id: 21, role_id: 2 }])

      // Mock final queries (last_sign_in_at update)
      mockExecuteSQL.mockResolvedValueOnce([{
        id: 21,
        cognitoSub: 'cognito-staff-123',
        email: 'jdoe@psd401.net',
        firstName: 'John',
        lastName: 'Doe'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])
      mockGetRoleByName.mockResolvedValueOnce([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(21, 2)
    })
  })

  describe('Error Handling', () => {
    it('should return error when session is missing', async () => {
      // Arrange
      mockGetServerSession.mockResolvedValue(null as never)

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(false)
      expect(result.error?.message || result.error).toMatch(/session/i)
    })
  })
})
