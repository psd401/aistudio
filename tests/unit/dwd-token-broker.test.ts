/**
 * DWD token broker (#1232).
 *
 * The GCP/WIF legs cannot be exercised without IT's Google-side setup, so the
 * tests mock the impersonated-SA-token seam + fetch and assert the parts that
 * ARE security-critical and deterministic: the agnt_ derivation guard (the
 * containment invariant), the signJwt claim shape, the returned token, and the
 * invalid_grant -> AccountNotProvisionedError mapping (the provisioning probe).
 */

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sanitizeForLogging: (x: unknown) => x,
}))

import {
  deriveAgentEmail,
  loadBrokerConfig,
  mintAgentWorkspaceToken,
  AGENT_DWD_SCOPES,
  BrokerNotConfiguredError,
  AccountNotProvisionedError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"

describe("deriveAgentEmail — the containment guard", () => {
  it("derives agnt_<localpart>@<domain> for a valid owner", () => {
    expect(deriveAgentEmail("hagelk@psd401.net", "psd401.net")).toBe("agnt_hagelk@psd401.net")
  })
  it("forces the agent domain to the allowed domain and is case-insensitive on domain", () => {
    expect(deriveAgentEmail("hagelk@PSD401.NET", "psd401.net")).toBe("agnt_hagelk@psd401.net")
  })
  it("normalizes local-part case so callers deriving from differently-cased owner emails agree", () => {
    expect(deriveAgentEmail("Hagelk@psd401.net", "psd401.net")).toBe("agnt_hagelk@psd401.net")
  })
  it("rejects an owner outside the allowed domain", () => {
    expect(() => deriveAgentEmail("someone@gmail.com", "psd401.net")).toThrow(InvalidOwnerError)
  })
  it("rejects a malformed email", () => {
    expect(() => deriveAgentEmail("not-an-email", "psd401.net")).toThrow(InvalidOwnerError)
  })
  it("refuses to re-derive from an already-agent address (no agnt_agnt_)", () => {
    expect(() => deriveAgentEmail("agnt_hagelk@psd401.net", "psd401.net")).toThrow(InvalidOwnerError)
  })
})

describe("loadBrokerConfig", () => {
  const KEYS = ["GCP_PROJECT_NUMBER", "GCP_WIF_POOL_ID", "GCP_WIF_PROVIDER_ID", "GCP_DWD_SERVICE_ACCOUNT_EMAIL"]
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]))

  it("throws BrokerNotConfiguredError listing every missing key", () => {
    expect(() => loadBrokerConfig()).toThrow(BrokerNotConfiguredError)
    try {
      loadBrokerConfig()
    } catch (e) {
      expect((e as Error).message).toMatch(/GCP_PROJECT_NUMBER/)
      expect((e as Error).message).toMatch(/GCP_DWD_SERVICE_ACCOUNT_EMAIL/)
    }
  })

  it("returns config with the default allowed domain when all keys are set", () => {
    process.env.GCP_PROJECT_NUMBER = "123456789"
    process.env.GCP_WIF_POOL_ID = "psd-agents"
    process.env.GCP_WIF_PROVIDER_ID = "aws-provider"
    process.env.GCP_DWD_SERVICE_ACCOUNT_EMAIL = "dwd@proj.iam.gserviceaccount.com"
    expect(loadBrokerConfig()).toEqual({
      projectNumber: "123456789",
      poolId: "psd-agents",
      providerId: "aws-provider",
      serviceAccountEmail: "dwd@proj.iam.gserviceaccount.com",
      allowedDomain: "psd401.net",
    })
  })
})

describe("mintAgentWorkspaceToken", () => {
  const SA = "dwd@proj.iam.gserviceaccount.com"
  beforeEach(() => {
    process.env.GCP_PROJECT_NUMBER = "123456789"
    process.env.GCP_WIF_POOL_ID = "psd-agents"
    process.env.GCP_WIF_PROVIDER_ID = "aws-provider"
    process.env.GCP_DWD_SERVICE_ACCOUNT_EMAIL = SA
  })

  function fakeFetch(handlers: { sign?: () => unknown; token?: () => unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const impl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes(":signJwt")) {
        return handlers.sign ? handlers.sign() : { ok: true, json: async () => ({ signedJwt: "signed.jwt" }) }
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return handlers.token ? handlers.token() : { ok: true, json: async () => ({ access_token: "ya29.at", expires_in: 3600 }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    return { impl: impl as unknown as typeof fetch, calls }
  }

  it("mints a token and signs a JWT bound to the derived agnt_ subject + DWD scopes", async () => {
    const { impl, calls } = fakeFetch({})
    const fixedNow = 1_700_000_000_000
    const result = await mintAgentWorkspaceToken("hagelk@psd401.net", {
      getServiceAccountToken: async () => "sa-access-token",
      fetchImpl: impl,
      now: () => fixedNow,
    })
    expect(result.agentEmail).toBe("agnt_hagelk@psd401.net")
    expect(result.accessToken).toBe("ya29.at")
    expect(result.expiresAt).toBe(new Date(fixedNow + 3600 * 1000).toISOString())

    const signCall = calls.find((c) => c.url.includes(":signJwt"))!
    expect(signCall.url).toContain(encodeURIComponent(SA))
    expect((signCall.init.headers as Record<string, string>).Authorization).toBe("Bearer sa-access-token")
    const payload = JSON.parse(JSON.parse(signCall.init.body as string).payload)
    expect(payload.iss).toBe(SA)
    expect(payload.sub).toBe("agnt_hagelk@psd401.net") // NOT the human, NOT a caller-supplied target
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token")
    expect(payload.scope).toBe(AGENT_DWD_SCOPES.join(" "))
    expect(payload.scope).not.toContain("openid")
  })

  it("maps invalid_grant to AccountNotProvisionedError (the existence probe)", async () => {
    const { impl } = fakeFetch({
      token: () => ({ ok: false, json: async () => ({ error: "invalid_grant", error_description: "account not found" }) }),
    })
    await expect(
      mintAgentWorkspaceToken("newuser@psd401.net", { getServiceAccountToken: async () => "sa", fetchImpl: impl })
    ).rejects.toBeInstanceOf(AccountNotProvisionedError)
  })

  it("throws on a signJwt failure", async () => {
    const { impl } = fakeFetch({ sign: () => ({ ok: false, status: 403, text: async () => "PERMISSION_DENIED" }) })
    await expect(
      mintAgentWorkspaceToken("hagelk@psd401.net", { getServiceAccountToken: async () => "sa", fetchImpl: impl })
    ).rejects.toThrow(/signJwt failed/)
  })

  it("refuses an owner outside the allowed domain before any network call", async () => {
    const { impl, calls } = fakeFetch({})
    await expect(
      mintAgentWorkspaceToken("evil@gmail.com", { getServiceAccountToken: async () => "sa", fetchImpl: impl })
    ).rejects.toBeInstanceOf(InvalidOwnerError)
    expect(calls).toHaveLength(0)
  })
})
