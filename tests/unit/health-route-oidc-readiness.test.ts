/** @jest-environment node */

const getOidcSigningKeySet = jest.fn(async () => ({
  activeKid: "test-kid",
  publicKeys: [{ kid: "test-kid" }],
  source: "secrets-manager" as const,
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  validateDatabaseConnection: jest.fn(async () => ({ success: true })),
}))
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => null),
}))
jest.mock("@/lib/oauth/oidc-signing-key-store", () => ({
  getOidcSigningKeySet,
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "health-request",
  startTimer: () => jest.fn(),
}))

import { GET } from "@/app/api/health/route"

function setNodeEnvironment(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV")
    return
  }
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

describe("GET /api/health OIDC production readiness", () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalOidcCookieSecret = process.env.OIDC_COOKIE_SECRET
  const originalSigningSecretArn = process.env.OIDC_SIGNING_JWKS_SECRET_ARN

  beforeAll(() => {
    setNodeEnvironment("production")
    delete process.env.OIDC_COOKIE_SECRET
    process.env.OIDC_SIGNING_JWKS_SECRET_ARN =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:test"
  })

  afterAll(() => {
    setNodeEnvironment(originalNodeEnv)
    if (originalOidcCookieSecret === undefined) {
      delete process.env.OIDC_COOKIE_SECRET
    } else {
      process.env.OIDC_COOKIE_SECRET = originalOidcCookieSecret
    }
    if (originalSigningSecretArn === undefined) {
      delete process.env.OIDC_SIGNING_JWKS_SECRET_ARN
    } else {
      process.env.OIDC_SIGNING_JWKS_SECRET_ARN = originalSigningSecretArn
    }
  })

  it("fails readiness before loading signing keys when the dedicated cookie key is absent", async () => {
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.checks.oauthSigning).toEqual({ status: "unhealthy" })
    expect(getOidcSigningKeySet).not.toHaveBeenCalled()
  })
})
