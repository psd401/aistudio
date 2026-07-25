import type {
  Client,
  Configuration,
  KoaContextWithOIDC,
} from "oidc-provider"

jest.mock("oidc-provider", () => {
  type CheckFunction = (context: KoaContextWithOIDC) => boolean
  type DetailsFunction = (
    context: KoaContextWithOIDC
  ) => Record<string, unknown>

  class Check {
    static readonly REQUEST_PROMPT = true
    static readonly NO_NEED_TO_PROMPT = false

    readonly error: string | undefined
    readonly check: CheckFunction
    readonly details: DetailsFunction

    constructor(
      readonly reason: string,
      readonly description: string,
      errorOrCheck: string | CheckFunction,
      checkOrDetails?: CheckFunction | DetailsFunction,
      details: DetailsFunction = () => ({})
    ) {
      if (typeof errorOrCheck === "function") {
        this.error = undefined
        this.check = errorOrCheck
        this.details =
          (checkOrDetails as DetailsFunction | undefined) ?? (() => ({}))
      } else {
        this.error = errorOrCheck
        this.check = checkOrDetails as CheckFunction
        this.details = details
      }
    }
  }

  class Checks extends Array<Check> {
    get(reason: string) {
      return this.find((check) => check.reason === reason)
    }

    remove(reason: string) {
      const index = this.findIndex((check) => check.reason === reason)
      if (index >= 0) this.splice(index, 1)
    }

    add(check: Check, index = this.length) {
      this.splice(index, 0, check)
    }
  }

  class Prompt {
    readonly checks: Checks

    constructor(readonly name: string, ...checks: Check[]) {
      this.checks = new Checks(...checks)
    }
  }

  function base() {
    const nativeCheck = new Check(
      "native_client_prompt",
      "native",
      "interaction_required",
      () => true
    )
    const oidcScopeCheck = new Check(
      "op_scopes_missing",
      "scopes",
      () => true
    )
    const prompts = [
      new Prompt("login"),
      new Prompt("consent", nativeCheck, oidcScopeCheck),
    ]
    return Object.assign(prompts, {
      get: (name: string) =>
        prompts.find((prompt) => prompt.name === name),
      remove: jest.fn(),
      clear: jest.fn(),
      add: jest.fn(),
    })
  }

  return {
    interactionPolicy: {
      Check,
      base,
    },
  }
})

import {
  createFirstPartyLoadExistingGrant,
  createOAuthInteractionPolicy,
  partitionRegisteredFirstPartyScopes,
} from "@/lib/oauth/first-party-grants"

type LoadExistingGrant = NonNullable<Configuration["loadExistingGrant"]>
type LoadContext = Parameters<LoadExistingGrant>[0]

class MockGrant {
  static existing: MockGrant | undefined
  static created = 0

  readonly jti = "grant-1"
  readonly accountId: string
  readonly clientId: string
  readonly addOIDCScope = jest.fn()
  readonly addResourceScope = jest.fn()
  readonly save = jest.fn(async () => this.jti)

  constructor(properties: { accountId: string; clientId: string }) {
    this.accountId = properties.accountId
    this.clientId = properties.clientId
    MockGrant.created += 1
  }

  static find = jest.fn(async () => MockGrant.existing)
}

function mockClient(isFirstParty: boolean, scope: string): Client {
  const metadata = {
    client_id: "atrium-client",
    is_first_party: isFirstParty,
  }
  return {
    clientId: "atrium-client",
    scope,
    applicationType: "native",
    metadata: () => metadata,
  } as unknown as Client
}

function loadContext(options: {
  isFirstParty: boolean
  requestedScope: string
  registeredScope: string
  accountId?: string
}): LoadContext {
  const client = mockClient(
    options.isFirstParty,
    options.registeredScope
  )
  return {
    oidc: {
      client,
      account: options.accountId
        ? { accountId: options.accountId }
        : undefined,
      params: { scope: options.requestedScope },
      provider: {
        Grant: MockGrant,
      },
    },
  } as unknown as LoadContext
}

describe("first-party OAuth grants", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    MockGrant.created = 0
    MockGrant.existing = undefined
  })

  it("does not create a grant before an authenticated account exists", async () => {
    const load = createFirstPartyLoadExistingGrant(
      "https://aistudio.example/api/oauth"
    )

    await expect(
      load(
        loadContext({
          isFirstParty: true,
          requestedScope: "openid content:read",
          registeredScope: "openid content:read",
        })
      )
    ).resolves.toBeUndefined()
    expect(MockGrant.created).toBe(0)
  })

  it("grants only requested scopes present in the client allowlist", async () => {
    const load = createFirstPartyLoadExistingGrant(
      "https://aistudio.example/api/oauth"
    )

    const grant = (await load(
      loadContext({
        isFirstParty: true,
        accountId: "42",
        requestedScope:
          "openid profile offline_access content:read content:update",
        registeredScope:
          "openid profile offline_access content:read",
      })
    )) as unknown as MockGrant

    expect(grant.addOIDCScope).toHaveBeenCalledWith(
      "openid profile offline_access"
    )
    expect(grant.addResourceScope).toHaveBeenCalledWith(
      "https://aistudio.example/api/oauth",
      "content:read"
    )
    expect(grant.addResourceScope).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("content:update")
    )
    expect(grant.save).toHaveBeenCalledTimes(1)
  })

  it("does not pre-authorize an untrusted client", async () => {
    const load = createFirstPartyLoadExistingGrant(
      "https://aistudio.example/api/oauth"
    )

    await expect(
      load(
        loadContext({
          isFirstParty: false,
          accountId: "42",
          requestedScope: "openid content:read",
          registeredScope: "openid content:read",
        })
      )
    ).resolves.toBeUndefined()
    expect(MockGrant.created).toBe(0)
  })

  it("exempts only explicitly trusted native clients from repeat consent", async () => {
    const policy = createOAuthInteractionPolicy()
    const nativeCheck = policy
      .get("consent")
      ?.checks.get("native_client_prompt")
    expect(nativeCheck).toBeDefined()

    const context = (isFirstParty: boolean) =>
      ({
        oidc: {
          client: mockClient(isFirstParty, "openid"),
          params: { response_type: "code" },
        },
      }) as unknown as KoaContextWithOIDC

    expect(nativeCheck?.check(context(true))).toBe(false)
    expect(nativeCheck?.check(context(false))).toBe(true)
  })

  it("keeps resource scopes out of the OIDC missing-scope check", () => {
    const check = createOAuthInteractionPolicy()
      .get("consent")
      ?.checks.get("op_scopes_missing")
    expect(check).toBeDefined()

    const context = {
      oidc: {
        grant: {
          getOIDCScopeEncountered: () => "openid",
        },
        requestParamOIDCScopes: new Set([
          "openid",
          "profile",
          "content:read",
        ]),
      },
    } as unknown as KoaContextWithOIDC

    expect(check?.check(context)).toBe(true)
    expect(check?.details(context)).toEqual({
      missingOIDCScope: ["profile"],
    })
  })

  it("partitions no unregistered scope into either grant section", () => {
    expect(
      partitionRegisteredFirstPartyScopes(
        "openid content:read content:update",
        "openid content:read"
      )
    ).toEqual({
      oidcScopes: ["openid"],
      contentScopes: ["content:read"],
    })
  })
})
