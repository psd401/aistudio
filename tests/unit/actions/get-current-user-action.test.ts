const getUserByCognitoSubMock = jest.fn()
const getUserByEmailMock = jest.fn()
const createUserMock = jest.fn()
const updateUserMock = jest.fn()
const getRoleByNameMock = jest.fn()
const addUserRoleMock = jest.fn()
const getUserRolesMock = jest.fn()
const reconcileRolesMock = jest.fn()
const getSessionMock = jest.fn()
const defaultRoleMock = jest.fn()

jest.mock("@/lib/db/drizzle", () => ({
  getUserByCognitoSub: (...args: unknown[]) => getUserByCognitoSubMock(...args),
  getUserByEmail: (...args: unknown[]) => getUserByEmailMock(...args),
  createUser: (...args: unknown[]) => createUserMock(...args),
  updateUser: (...args: unknown[]) => updateUserMock(...args),
  getRoleByName: (...args: unknown[]) => getRoleByNameMock(...args),
  addUserRole: (...args: unknown[]) => addUserRoleMock(...args),
  getUserRolesByCognitoSub: (...args: unknown[]) => getUserRolesMock(...args),
  reconcileUserManagedRoles: (...args: unknown[]) => reconcileRolesMock(...args),
}))

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => getSessionMock(),
}))

jest.mock("@/lib/auth/default-role", () => ({
  defaultRoleForNewUser: (...args: unknown[]) => defaultRoleMock(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-test",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
}))

jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown, message: string) => ({
    isSuccess: true,
    message,
    data,
  }),
  handleError: (error: unknown, message: string) => ({
    isSuccess: false,
    message,
    error,
  }),
  ErrorFactories: {
    authNoSession: () => new Error("No session"),
  },
}))

import { getCurrentUserAction } from "@/actions/db/get-current-user-action"

const session = {
  sub: "cognito-1",
  email: "new.name@example.com",
  givenName: "New",
  familyName: "Name",
}

const existingUser = {
  id: 7,
  cognitoSub: "cognito-1",
  email: "old.name@example.com",
  firstName: "Old",
  lastName: "Name",
}

describe("getCurrentUserAction", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getSessionMock.mockResolvedValue(session)
    getUserRolesMock.mockResolvedValue(["staff"])
    getRoleByNameMock.mockResolvedValue({
      id: 2,
      name: "staff",
      description: "Staff",
    })
    reconcileRolesMock.mockResolvedValue(undefined)
    defaultRoleMock.mockReturnValue("student")
  })

  it("refreshes an existing user and reconciles roles with the live email", async () => {
    getUserByCognitoSubMock.mockResolvedValue(existingUser)
    updateUserMock.mockResolvedValue({
      ...existingUser,
      email: session.email,
      firstName: session.givenName,
    })

    const result = await getCurrentUserAction()

    expect(result.isSuccess).toBe(true)
    expect(updateUserMock).toHaveBeenCalledWith(7, expect.objectContaining({
      email: session.email,
      firstName: session.givenName,
      lastName: session.familyName,
      lastSignInAt: expect.any(Date),
    }))
    expect(reconcileRolesMock).toHaveBeenCalledWith(7, session.email)
    expect(result.data?.roles).toEqual([
      { id: 2, name: "staff", description: "Staff" },
    ])
  })

  it("links an existing email row to the current Cognito subject", async () => {
    getUserByCognitoSubMock.mockResolvedValue(null)
    getUserByEmailMock.mockResolvedValue({ ...existingUser, cognitoSub: "old-sub" })
    updateUserMock
      .mockResolvedValueOnce(existingUser)
      .mockResolvedValueOnce({ ...existingUser, email: session.email })

    await getCurrentUserAction()

    expect(updateUserMock).toHaveBeenNthCalledWith(1, 7, {
      cognitoSub: session.sub,
    })
    expect(createUserMock).not.toHaveBeenCalled()
  })

  it("provisions a missing user and assigns the configured default role", async () => {
    getUserByCognitoSubMock.mockResolvedValue(null)
    getUserByEmailMock.mockResolvedValue(null)
    createUserMock.mockResolvedValue(existingUser)
    updateUserMock.mockResolvedValue({ ...existingUser, email: session.email })

    await getCurrentUserAction()

    expect(createUserMock).toHaveBeenCalledWith({
      cognitoSub: session.sub,
      email: session.email,
      firstName: session.givenName,
      lastName: session.familyName,
    })
    expect(addUserRoleMock).toHaveBeenCalledWith(7, "student")
  })

  it("retries profile updates without email after a uniqueness conflict", async () => {
    getUserByCognitoSubMock.mockResolvedValue(existingUser)
    updateUserMock
      .mockRejectedValueOnce(new Error("duplicate email"))
      .mockResolvedValueOnce(existingUser)

    const result = await getCurrentUserAction()

    expect(result.isSuccess).toBe(true)
    expect(updateUserMock).toHaveBeenNthCalledWith(
      2,
      7,
      expect.not.objectContaining({ email: expect.anything() })
    )
  })
})
