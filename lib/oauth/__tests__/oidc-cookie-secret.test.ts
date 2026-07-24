import { getOidcCookieSecret } from "../oidc-cookie-secret"

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  OIDC_COOKIE_SECRET: process.env.OIDC_COOKIE_SECRET,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
}

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

function restoreEnvironment(): void {
  setNodeEnvironment(ORIGINAL_ENV.NODE_ENV)
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (name === "NODE_ENV") continue
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

describe("getOidcCookieSecret", () => {
  beforeEach(() => {
    delete process.env.OIDC_COOKIE_SECRET
    delete process.env.AUTH_SECRET
    delete process.env.NEXTAUTH_SECRET
  })

  afterAll(restoreEnvironment)

  it("uses the dedicated OIDC secret ahead of session secrets", () => {
    process.env.OIDC_COOKIE_SECRET = "dedicated-secret"
    process.env.AUTH_SECRET = "auth-secret"
    process.env.NEXTAUTH_SECRET = "legacy-secret"

    expect(getOidcCookieSecret()).toBe("dedicated-secret")
  })

  it("requires the dedicated secret in production", () => {
    setNodeEnvironment("production")
    process.env.AUTH_SECRET = "configured-session-secret"
    process.env.NEXTAUTH_SECRET = "configured-legacy-session-secret"

    expect(() => getOidcCookieSecret()).toThrow(
      "OIDC_COOKIE_SECRET must be set in production"
    )
  })

  it("falls back to the canonical AUTH_SECRET in local development", () => {
    setNodeEnvironment("development")
    process.env.AUTH_SECRET = "local-session-secret"

    expect(getOidcCookieSecret()).toBe("local-session-secret")
  })

  it("supports the legacy NEXTAUTH_SECRET fallback outside production", () => {
    setNodeEnvironment("test")
    process.env.NEXTAUTH_SECRET = "legacy-local-secret"

    expect(getOidcCookieSecret()).toBe("legacy-local-secret")
  })

  it("preserves legacy NEXTAUTH_SECRET precedence in local development", () => {
    setNodeEnvironment("development")
    process.env.AUTH_SECRET = "canonical-local-secret"
    process.env.NEXTAUTH_SECRET = "existing-legacy-secret"

    expect(getOidcCookieSecret()).toBe("existing-legacy-secret")
  })
})
