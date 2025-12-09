import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Create mock functions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecuteSQL = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetUserByCognitoSub = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateUser = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetRoleByName = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAssignRoleToUser = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetUserRolesByCognitoSub = jest.fn<any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetServerSession = jest.fn<any>()

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
  sanitizeForLogging: (value: unknown) => value
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

      // User doesn't exist yet
      mockGetUserByCognitoSub.mockResolvedValue(null)

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

      // No existing roles
      mockGetUserRolesByCognitoSub.mockResolvedValue([])

      // Mock role assignment
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff' }])
      mockAssignRoleToUser.mockResolvedValue(true)

      // Mock final queries
      mockExecuteSQL.mockResolvedValue([{
        id: 1,
        cognitoSub: 'cognito-new-123',
        email: 'newuser@psd401.net',
        firstName: 'New',
        lastName: 'User'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.cognitoSub).toBe('cognito-new-123')
      expect(mockCreateUser).toHaveBeenCalledWith({
        cognitoSub: 'cognito-new-123',
        email: 'newuser@psd401.net',
        firstName: 'New',
        lastName: 'User'
      })
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
      mockGetUserByCognitoSub.mockResolvedValue(null)

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

      // User already has roles (from concurrent request)
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])

      // Mock final queries
      mockExecuteSQL.mockResolvedValue([{
        id: 5,
        cognitoSub: 'cognito-race-123',
        email: 'raceuser@psd401.net',
        firstName: 'Race',
        lastName: 'User'
      }])
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.id).toBe(5)
      // Role assignment should be skipped since user already has roles
      expect(mockAssignRoleToUser).not.toHaveBeenCalled()
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
      mockGetUserByCognitoSub.mockResolvedValue(null)

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

      // User has existing roles
      mockGetUserRolesByCognitoSub.mockResolvedValue(['admin'])

      // Mock final queries
      mockExecuteSQL.mockResolvedValue([{
        id: 10,
        cognitoSub: 'cognito-existing-123',
        email: 'updated@psd401.net',
        firstName: 'Updated',
        lastName: 'Name'
      }])
      mockGetRoleByName.mockResolvedValue([{ id: 1, name: 'admin', description: 'Administrator' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(result.data?.user.email).toBe('updated@psd401.net')
      expect(result.data?.user.id).toBe(10)
      // Should not assign new role since user already has roles
      expect(mockAssignRoleToUser).not.toHaveBeenCalled()
    })

    it('should determine correct default role for numeric username (student)', async () => {
      // Arrange: Student with numeric ID
      mockGetServerSession.mockResolvedValue({
        sub: 'cognito-student-123',
        email: '123456@psd401.net', // Numeric username = student
        givenName: 'Student',
        familyName: 'User'
      })

      mockGetUserByCognitoSub.mockResolvedValue(null)
      mockCreateUser.mockResolvedValue({
        id: 20,
        cognitoSub: 'cognito-student-123',
        email: '123456@psd401.net',
        firstName: 'Student',
        lastName: 'User'
      })

      // No existing roles
      mockGetUserRolesByCognitoSub.mockResolvedValue([])

      // Mock student role assignment
      mockGetRoleByName.mockResolvedValue([{ id: 3, name: 'student' }])
      mockAssignRoleToUser.mockResolvedValue(true)

      // Mock final queries
      mockExecuteSQL.mockResolvedValue([{
        id: 20,
        cognitoSub: 'cognito-student-123',
        email: '123456@psd401.net',
        firstName: 'Student',
        lastName: 'User'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['student'])
      mockGetRoleByName.mockResolvedValue([{ id: 3, name: 'student', description: 'Student' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(mockGetRoleByName).toHaveBeenCalledWith('student')
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

      mockGetUserByCognitoSub.mockResolvedValue(null)
      mockCreateUser.mockResolvedValue({
        id: 21,
        cognitoSub: 'cognito-staff-123',
        email: 'jdoe@psd401.net',
        firstName: 'John',
        lastName: 'Doe'
      })

      // No existing roles
      mockGetUserRolesByCognitoSub.mockResolvedValue([])

      // Mock staff role assignment
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff' }])
      mockAssignRoleToUser.mockResolvedValue(true)

      // Mock final queries
      mockExecuteSQL.mockResolvedValue([{
        id: 21,
        cognitoSub: 'cognito-staff-123',
        email: 'jdoe@psd401.net',
        firstName: 'John',
        lastName: 'Doe'
      }])
      mockGetUserRolesByCognitoSub.mockResolvedValue(['staff'])
      mockGetRoleByName.mockResolvedValue([{ id: 2, name: 'staff', description: 'Staff member' }])

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(true)
      expect(mockGetRoleByName).toHaveBeenCalledWith('staff')
      expect(mockAssignRoleToUser).toHaveBeenCalledWith(21, 2)
    })
  })

  describe('Error Handling', () => {
    it('should return error when session is missing', async () => {
      // Arrange
      mockGetServerSession.mockResolvedValue(null)

      // Act
      const result = await getCurrentUserAction()

      // Assert
      expect(result.isSuccess).toBe(false)
      expect(result.error).toContain('session')
    })
  })
})
