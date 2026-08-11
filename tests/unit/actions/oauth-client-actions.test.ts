/**
 * @jest-environment node
 *
 * revokeOAuthClient (REV-COR-055): a revoke that matches no client must return a
 * failure ActionState, not a false "revoked" success.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

const mockRequireRole = jest.fn<() => Promise<void>>(() => Promise.resolve())
const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))

jest.mock('@/lib/auth/role-helpers', () => ({ requireRole: mockRequireRole }))
jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: mockExecuteQuery }))
jest.mock('@/lib/auth/server-session', () => ({ getServerSession: jest.fn(() => Promise.resolve({ sub: 'admin' })) }))
jest.mock('@/lib/db/drizzle/utils', () => ({ getUserIdByCognitoSubAsNumber: jest.fn(() => Promise.resolve(1)) }))
jest.mock('@/lib/api-keys/argon2-loader', () => ({ hashArgon2: jest.fn() }))
jest.mock('@/lib/db/schema', () => ({
  oauthClients: {
    id: 'id',
    clientId: 'client_id',
    clientName: 'client_name',
    applicationType: 'application_type',
    redirectUris: 'redirect_uris',
    allowedScopes: 'allowed_scopes',
    grantTypes: 'grant_types',
    tokenEndpointAuthMethod: 'token_endpoint_auth_method',
    requirePkce: 'require_pkce',
    accessTokenTtl: 'access_token_ttl',
    refreshTokenTtl: 'refresh_token_ttl',
    isActive: 'is_active',
    isFirstParty: 'is_first_party',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({}),
}))

let revokeOAuthClient: typeof import('@/actions/oauth/oauth-client.actions').revokeOAuthClient
let createOAuthClient: typeof import('@/actions/oauth/oauth-client.actions').createOAuthClient

function defineRevokeOAuthClientREVCOR055Suite1Part1() {


  beforeAll(async () => {
    const actions = await import('@/actions/oauth/oauth-client.actions')
    revokeOAuthClient = actions.revokeOAuthClient
    createOAuthClient = actions.createOAuthClient
  })
  beforeEach(() => { jest.clearAllMocks(); mockRequireRole.mockResolvedValue(undefined) })

  it('returns a failure when no client matches the id (no false success)', async () => {
    mockExecuteQuery.mockResolvedValueOnce([]) // UPDATE matched 0 rows
    const res = await revokeOAuthClient('does-not-exist')
    expect(res.isSuccess).toBe(false)
  })

  it('returns success when an existing client is revoked', async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ id: 7 }]) // one row updated
    const res = await revokeOAuthClient('client-abc')
    expect(res.isSuccess).toBe(true)
    expect(res.data).toEqual({ clientId: 'client-abc' })
  })

  it('creates a native client without a secret and records its application type', async () => {
    const createdAt = new Date('2026-07-24T12:00:00.000Z')
    mockExecuteQuery.mockResolvedValueOnce([{
      id: 9,
      clientId: 'native-client',
      clientName: 'Atrium Desktop',
      applicationType: 'native',
      clientSecretHash: null,
      redirectUris: ['com.example.atrium:/oauth/callback'],
      allowedScopes: ['openid', 'content:read'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      requirePkce: true,
      accessTokenTtl: 900,
      refreshTokenTtl: 86400,
      isActive: true,
      isFirstParty: false,
      createdAt,
      updatedAt: createdAt,
    }])

    const res = await createOAuthClient({
      clientName: 'Atrium Desktop',
      applicationType: 'native',
      redirectUris: ['com.example.atrium:/oauth/callback'],
      allowedScopes: ['openid', 'content:read'],
      tokenEndpointAuthMethod: 'none',
    })

    expect(res.isSuccess).toBe(true)
    expect(res.data?.client.applicationType).toBe('native')
    expect(res.data?.clientSecret).toBeUndefined()
  })

  it('persists every required OIDC scope when a public caller omits them', async () => {
    const createdAt = new Date('2026-07-24T12:00:00.000Z')
    const createdRow = {
      id: 10,
      clientId: 'browser-client',
      clientName: 'Atrium Capture Browser',
      applicationType: 'browser_extension',
      clientSecretHash: null,
      redirectUris: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atrium'],
      allowedScopes: ['openid', 'profile', 'offline_access', 'content:create'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      requirePkce: true,
      accessTokenTtl: 900,
      refreshTokenTtl: 86400,
      isActive: true,
      isFirstParty: false,
      createdAt,
      updatedAt: createdAt,
    }
    let insertedValues: Record<string, unknown> | undefined
    type InsertDb = {
      insert: (table: unknown) => {
        values: (values: Record<string, unknown>) => {
          returning: () => Promise<unknown[]>
        }
      }
    }
    mockExecuteQuery.mockImplementationOnce(async (...args: unknown[]) => {
      const operation = args[0] as (db: InsertDb) => Promise<unknown[]>
      return operation({
        insert: () => ({
          values: (values) => {
            insertedValues = values
            return {
              returning: async () => [createdRow],
            }
          },
        }),
      })
    })

    const result = await createOAuthClient({
      clientName: 'Atrium Capture Browser',
      applicationType: 'browser_extension',
      redirectUris: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atrium'],
      allowedScopes: ['content:create'],
      tokenEndpointAuthMethod: 'none',
    })

    expect(result.isSuccess).toBe(true)
    expect(insertedValues?.allowedScopes).toEqual(createdRow.allowedScopes)
  })

  }

function defineRevokeOAuthClientREVCOR055Suite1Part2() {it('rejects native localhost callbacks before touching the database', async () => {
    const res = await createOAuthClient({
      clientName: 'Unsafe Desktop',
      applicationType: 'native',
      redirectUris: ['http://localhost/oauth/callback'],
      allowedScopes: ['openid'],
      tokenEndpointAuthMethod: 'none',
    })

    expect(res.isSuccess).toBe(false)
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it('rejects secrets and disabled PKCE for public application types', async () => {
    const secretResult = await createOAuthClient({
      clientName: 'Unsafe Extension',
      applicationType: 'browser_extension',
      redirectUris: [
        'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atrium',
      ],
      allowedScopes: ['openid'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    const pkceResult = await createOAuthClient({
      clientName: 'Unsafe Native',
      applicationType: 'native',
      redirectUris: ['com.example.atrium:/oauth/callback'],
      allowedScopes: ['openid'],
      tokenEndpointAuthMethod: 'none',
      requirePkce: false,
    })

    expect(secretResult.isSuccess).toBe(false)
    expect(pkceResult.isSuccess).toBe(false)
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it('rejects malformed runtime profile data before touching the database', async () => {
    const malformed = {
      clientName: '   ',
      applicationType: 'native',
      redirectUris: ['com.example.atrium:/oauth/callback'],
      allowedScopes: ['openid'],
      tokenEndpointAuthMethod: 'client_secret_post',
      requirePkce: false,
    } as unknown as import('@/actions/oauth/oauth-client.actions').CreateOAuthClientInput

    const result = await createOAuthClient(malformed)

    expect(result.isSuccess).toBe(false)
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
}

const defineRevokeOAuthClientREVCOR055Suite1 = () => {
  defineRevokeOAuthClientREVCOR055Suite1Part1()
  defineRevokeOAuthClientREVCOR055Suite1Part2()
};

describe('revokeOAuthClient (REV-COR-055)', defineRevokeOAuthClientREVCOR055Suite1)

describe('updateOAuthClientRedirectUris', () => {
  let updateOAuthClientRedirectUris: typeof import('@/actions/oauth/oauth-client.actions').updateOAuthClientRedirectUris

  beforeAll(async () => {
    const actions = await import('@/actions/oauth/oauth-client.actions')
    updateOAuthClientRedirectUris = actions.updateOAuthClientRedirectUris
  })
  beforeEach(() => { jest.clearAllMocks(); mockRequireRole.mockResolvedValue(undefined) })

  it('requires the administrator role', async () => {
    mockRequireRole.mockRejectedValueOnce(new Error('forbidden'))
    const result = await updateOAuthClientRedirectUris({
      clientId: 'c1', redirectUris: ['https://example.com/cb'],
    })
    expect(result.isSuccess).toBe(false)
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it('repairs the real localhost case and can reactivate in the same edit', async () => {
    // The migration-176 scenario, done through the UI instead.
    mockExecuteQuery
      .mockResolvedValueOnce([{ applicationType: 'native' }])
      .mockResolvedValueOnce([{ id: 1 }])
    const result = await updateOAuthClientRedirectUris({
      clientId: '7e8646f4-4091-4a34-a6b9-0d3721e8a126',
      redirectUris: [
        'http://127.0.0.1:3000/agent-connect-aistudio/callback',
        'https://aistudio.psd401.ai/agent-connect-aistudio/callback',
      ],
      isActive: true,
    })
    expect(result.isSuccess).toBe(true)
  })

  it('rejects a URI the stored application type forbids', async () => {
    // `localhost` over HTTP is exactly what broke agent-connect; a native
    // client must not be able to store it again through this path.
    mockExecuteQuery.mockResolvedValueOnce([{ applicationType: 'native' }])
    const result = await updateOAuthClientRedirectUris({
      clientId: 'c1',
      redirectUris: ['http://localhost:3000/agent-connect-aistudio/callback'],
    })
    expect(result.isSuccess).toBe(false)
    // Load happened; the UPDATE must not have.
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
  })

  it('validates against the STORED type, ignoring any caller-supplied type', async () => {
    // A web-only HTTPS host URI is invalid for a native client. Passing
    // applicationType alongside it must not relax the rules.
    mockExecuteQuery.mockResolvedValueOnce([{ applicationType: 'native' }])
    const result = await updateOAuthClientRedirectUris({
      clientId: 'c1',
      redirectUris: ['https://example.com:8443/cb'],
      ...({ applicationType: 'web' } as Record<string, unknown>),
    })
    expect(result.isSuccess).toBe(false)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
  })

  it('fails when no row matched instead of reporting a false success', async () => {
    mockExecuteQuery.mockResolvedValueOnce([])
    const result = await updateOAuthClientRedirectUris({
      clientId: 'missing', redirectUris: ['https://example.com/cb'],
    })
    expect(result.isSuccess).toBe(false)
  })
})
