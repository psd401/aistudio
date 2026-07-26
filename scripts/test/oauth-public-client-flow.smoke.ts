/**
 * Protocol smoke test for the public OAuth/OIDC contract (Issue #1285).
 *
 * It runs the repository's real oidc-provider version with a deterministic
 * in-memory adapter and exercises the browser-visible authorization
 * interaction lifecycle plus token security at HTTP boundaries: first-party
 * login without consent, third-party consent, S256 PKCE, redirect mismatch,
 * code replay, RS256 access JWTs, refresh rotation/replay, expiry, revocation,
 * and native redirect matching.
 *
 * Run: bun run test:oauth-public-flow
 */

import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import Provider, {
  type Adapter,
  type AdapterPayload,
  type Interaction,
} from "oidc-provider"
import { decodeJwt, decodeProtectedHeader } from "jose"
import { scriptLogger as log } from "../db/script-logger"
import {
  createFirstPartyLoadExistingGrant,
  createOAuthInteractionPolicy,
} from "../../lib/oauth/first-party-grants"
import {
  ATRIUM_CAPTURE_EXTENSION_ORIGIN,
  isAllowedOAuthClientOrigin,
} from "../../lib/oauth/client-origin-policy"

interface Stored {
  payload: AdapterPayload
}

class SmokeAdapter implements Adapter {
  private static records = new Map<string, Stored>()

  constructor(private readonly model: string) {}

  private key(id: string): string {
    return `${this.model}:${id}`
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    _expiresIn: number
  ): Promise<void> {
    SmokeAdapter.records.set(this.key(id), {
      payload: { ...payload },
    })
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const record = SmokeAdapter.records.get(this.key(id))
    return record ? { ...record.payload } : undefined
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    for (const [key, record] of SmokeAdapter.records) {
      if (
        key.startsWith(`${this.model}:`) &&
        record.payload.uid === uid
      ) {
        return { ...record.payload }
      }
    }
    return undefined
  }

  async findByUserCode(): Promise<AdapterPayload | undefined> {
    return undefined
  }

  async consume(id: string): Promise<void> {
    const record = SmokeAdapter.records.get(this.key(id))
    if (record) {
      record.payload = {
        ...record.payload,
        consumed: Math.floor(Date.now() / 1000),
      }
    }
  }

  async destroy(id: string): Promise<void> {
    SmokeAdapter.records.delete(this.key(id))
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    for (const [key, record] of SmokeAdapter.records) {
      if (record.payload.grantId === grantId) {
        SmokeAdapter.records.delete(key)
      }
    }
  }

  static expire(model: string, id: string): void {
    const record = SmokeAdapter.records.get(`${model}:${id}`)
    assert(record, `missing ${model} record`)
    record.payload = {
      ...record.payload,
      exp: Math.floor(Date.now() / 1000) - 1,
    }
  }

  static ids(model: string): string[] {
    const prefix = `${model}:`
    return [...SmokeAdapter.records.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }
}

interface TokenSuccess {
  access_token: string
  refresh_token: string
  id_token: string
  token_type: string
  expires_in: number
}

interface OAuthError {
  error: string
  error_description?: string
}

interface AuthorizationResult {
  callback: URL
  prompts: string[]
}

class CookieJar {
  private readonly values = new Map<
    string,
    { value: string; path: string }
  >()

  capture(response: Response, requestUrl: string): void {
    const requestPath = new URL(requestUrl).pathname
    const lastSlash = requestPath.lastIndexOf("/")
    const defaultPath =
      lastSlash <= 0 ? "/" : requestPath.slice(0, lastSlash)

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]
      const separator = pair.indexOf("=")
      if (separator <= 0) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      const path =
        cookie.match(/(?:^|;)\s*path=([^;]+)/i)?.[1] ?? defaultPath
      if (
        value.length === 0 ||
        /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)
      ) {
        this.values.delete(name)
      } else {
        this.values.set(name, { value, path })
      }
    }
  }

  header(requestUrl: string): string | undefined {
    const requestPath = new URL(requestUrl).pathname
    const cookies = [...this.values].filter(([, cookie]) => {
      return (
        requestPath === cookie.path ||
        requestPath.startsWith(
          cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`
        )
      )
    })
    if (cookies.length === 0) return undefined
    return cookies
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ")
  }
}

function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string")
    ? value
    : []
}

async function fetchWithCookies(
  url: string,
  jar: CookieJar
): Promise<Response> {
  const cookie = jar.header(url)
  const response = await fetch(url, {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  })
  jar.capture(response, url)
  return response
}

async function postForm<T>(
  origin: string,
  path: string,
  form: Record<string, string>,
  requestOrigin?: string
): Promise<{ status: number; body: T; allowOrigin: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  }
  if (requestOrigin) headers.origin = requestOrigin
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(form),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    allowOrigin: response.headers.get("access-control-allow-origin"),
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

async function main(): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  const signingJwk = {
    ...privateKey.export({ format: "jwk" }),
    kid: "smoke-active",
    alg: "RS256",
    use: "sig",
  }
  const clientId = "ae781263-20c0-4b0c-8a34-8be01ab72fb1"
  const redirectUri =
    "https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org/atrium"
  const nativeClientId = "fbdaa815-1b0f-435b-805f-1732805720c1"
  const nativeRedirectUri =
    "org.psd401.atrium-capture:/oauth/callback"
  const thirdPartyClientId = "third-party-browser"
  const thirdPartyRedirectUri =
    "https://third-party.example/oauth/callback"
  const loopbackClientId = "native-loopback-smoke"
  const loopbackRedirectUri = "http://127.0.0.1/oauth/callback"
  const registeredScopes =
    "openid profile offline_access content:read content:create content:update content:publish_internal"
  const verifier = "a".repeat(64)

  const holder = createServer()
  const origin = await listen(holder)
  await close(holder)

  const provider = new Provider(origin, {
    adapter: (model) => new SmokeAdapter(model),
    clients: [
      {
        client_id: clientId,
        client_name: "Atrium Chrome extension",
        application_type: "web",
        token_endpoint_auth_method: "none",
        redirect_uris: [redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: registeredScopes,
        is_first_party: true,
      },
      {
        client_id: nativeClientId,
        client_name: "Atrium native application",
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: [nativeRedirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: registeredScopes,
        is_first_party: true,
      },
      {
        client_id: thirdPartyClientId,
        client_name: "Third-party browser",
        application_type: "web",
        token_endpoint_auth_method: "none",
        redirect_uris: [thirdPartyRedirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: registeredScopes,
        is_first_party: false,
      },
      {
        client_id: loopbackClientId,
        client_name: "Native loopback smoke client",
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: [loopbackRedirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: registeredScopes,
        is_first_party: false,
      },
    ],
    extraClientMetadata: {
      properties: ["is_first_party"],
    },
    loadExistingGrant: createFirstPartyLoadExistingGrant(origin),
    clientBasedCORS: (ctx, requestOrigin, client) =>
      isAllowedOAuthClientOrigin({
        clientId: client.clientId,
        origin: requestOrigin,
        route: ctx.oidc.route,
        grantType: ctx.oidc.params?.grant_type,
      }),
    jwks: { keys: [signingJwk] },
    pkce: { required: () => true },
    responseTypes: ["code"],
    scopes: [
      "openid",
      "profile",
      "offline_access",
      "content:read",
      "content:create",
      "content:update",
      "content:publish_internal",
      "content:not_registered",
    ],
    issueRefreshToken: () => true,
    rotateRefreshToken: true,
    formats: {
      customizers: {
        async jwt(_ctx, token, jwt) {
          await new SmokeAdapter("AccessToken").upsert(
            token.jti,
            {
              ...Object.fromEntries(Object.entries(token)),
              jti: token.jti,
              kind: token.kind,
            },
            token.remainingTTL
          )
          return jwt
        },
      },
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => origin,
        useGrantedResource: async () => true,
        getResourceServerInfo: async () => ({
          audience: origin,
          scope:
            "content:read content:create content:update content:publish_internal",
          accessTokenFormat: "jwt" as const,
          accessTokenTTL: 900,
        }),
      },
    },
    routes: {
      revocation: "/revocation",
    },
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({
        sub: id,
        name: "Smoke User",
      }),
    }),
    interactions: {
      policy: createOAuthInteractionPolicy(),
      url: (_ctx, interaction) =>
        `/oauth/authorize?uid=${interaction.uid}`,
    },
    cookies: { keys: ["smoke-cookie-key"] },
  })
  const observedPrompts: Array<{
    clientId: string
    name: string
    details: Record<string, unknown>
  }> = []
  const providerCallback = provider.callback()

  async function finishInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interaction: Interaction
  ): Promise<void> {
    const rawClientId = interaction.params.client_id
    if (typeof rawClientId !== "string") {
      throw new TypeError("interaction client_id must be a string")
    }
    const clientIdParam = rawClientId

    if (interaction.prompt.name === "login") {
      await provider.interactionFinished(
        request,
        response,
        { login: { accountId: "1" } },
        { mergeWithLastSubmission: false }
      )
      return
    }

    assert.equal(interaction.prompt.name, "consent")
    const accountId = interaction.session?.accountId
    assert(accountId)
    let grant = interaction.grantId
      ? await provider.Grant.find(interaction.grantId)
      : undefined
    grant ??= new provider.Grant({
      accountId,
      clientId: clientIdParam,
    })

    const details = interaction.prompt.details
    const oidcScopes = stringArray(details.missingOIDCScope)
    if (oidcScopes.length > 0) {
      grant.addOIDCScope(oidcScopes.join(" "))
    }
    const oidcClaims = stringArray(details.missingOIDCClaims)
    if (oidcClaims.length > 0) {
      grant.addOIDCClaims(oidcClaims)
    }
    const resources = details.missingResourceScopes
    if (
      resources &&
      typeof resources === "object" &&
      !Array.isArray(resources)
    ) {
      for (const [resource, value] of Object.entries(resources)) {
        const scopes = stringArray(value)
        if (scopes.length > 0) {
          grant.addResourceScope(resource, scopes.join(" "))
        }
      }
    }

    await provider.interactionFinished(
      request,
      response,
      { consent: { grantId: await grant.save() } },
      { mergeWithLastSubmission: true }
    )
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const path = new URL(request.url ?? "/", origin).pathname
    if (path === "/oauth/authorize") {
      const interaction = await provider.interactionDetails(
        request,
        response
      )
      const rawClientId = interaction.params.client_id
      if (typeof rawClientId !== "string") {
        throw new TypeError("interaction client_id must be a string")
      }
      observedPrompts.push({
        clientId: rawClientId,
        name: interaction.prompt.name,
        details: interaction.prompt.details,
      })
      response.statusCode = 303
      response.setHeader(
        "Location",
        `/oauth/authorize/interaction/${interaction.uid}/${interaction.prompt.name}`
      )
      response.end()
      return
    }
    if (path.startsWith("/oauth/authorize/interaction/")) {
      const interaction = await provider.interactionDetails(
        request,
        response
      )
      await finishInteraction(request, response, interaction)
      return
    }
    providerCallback(request, response)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      log.error("OAuth smoke HTTP handler failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      if (!response.headersSent) response.statusCode = 500
      if (!response.writableEnded) response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    const port = Number(new URL(origin).port)
    server.listen(port, "127.0.0.1", resolve)
  })

  const foundClient = await provider.Client.find(clientId)
  if (!foundClient) throw new Error("Smoke OAuth client not found")
  const client = foundClient
  const nativeClient = await provider.Client.find(nativeClientId)
  if (!nativeClient) throw new Error("Smoke native OAuth client not found")
  const loopbackClient = await provider.Client.find(loopbackClientId)
  if (!loopbackClient) {
    throw new Error("Smoke loopback OAuth client not found")
  }

  async function authorizationCode(
    expire = false
  ): Promise<string> {
    const grant = new provider.Grant({
      accountId: "1",
      clientId,
    })
    grant.addOIDCScope("openid profile offline_access")
    grant.addResourceScope(
      origin,
      "content:read content:create content:update content:publish_internal"
    )
    const grantId = await grant.save()
    const code = new provider.AuthorizationCode({
      accountId: "1",
      client,
      grantId,
      gty: "authorization_code",
      scope:
        "openid profile offline_access content:read content:create content:update content:publish_internal",
    })
    code.redirectUri = redirectUri
    code.codeChallenge = pkce(verifier)
    code.codeChallengeMethod = "S256"
    code.resource = origin
    const value = await code.save()
    if (expire) SmokeAdapter.expire("AuthorizationCode", value)
    return value
  }

  function authorizationUrl(options: {
    clientId: string
    redirectUri: string
    state: string
    scope?: string
    includeChallenge?: boolean
    challengeMethod?: string
  }): string {
    const params = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      response_type: "code",
      scope: options.scope ?? registeredScopes,
      state: options.state,
      resource: origin,
    })
    if (options.includeChallenge !== false) {
      params.set("code_challenge", pkce(verifier))
      params.set(
        "code_challenge_method",
        options.challengeMethod ?? "S256"
      )
    }
    return `${origin}/auth?${params.toString()}`
  }

  async function authorize(options: {
    clientId: string
    redirectUri: string
    state: string
    jar: CookieJar
  }): Promise<AuthorizationResult> {
    let current = authorizationUrl(options)
    const promptStart = observedPrompts.length

    for (let redirectCount = 0; redirectCount < 10; redirectCount += 1) {
      const response = await fetchWithCookies(current, options.jar)
      assert(
        isRedirect(response.status),
        `authorization expected redirect, got ${response.status}: ${await response.text()}`
      )
      const location = response.headers.get("location")
      assert(location, "authorization redirect missing Location")
      const next = new URL(location, current)
      if (next.href.startsWith(options.redirectUri)) {
        return {
          callback: next,
          prompts: observedPrompts
            .slice(promptStart)
            .map((prompt) => prompt.name),
        }
      }
      assert.equal(
        next.origin,
        origin,
        `unexpected authorization redirect: ${next.href}`
      )
      current = next.href
    }

    throw new Error("authorization redirect limit exceeded")
  }

  async function assertAuthorizationRejected(
    url: string,
    expectedError: string
  ): Promise<void> {
    const response = await fetchWithCookies(url, new CookieJar())
    if (isRedirect(response.status)) {
      const location = response.headers.get("location")
      assert(location, "OAuth error redirect missing Location")
      const error = new URL(location, url).searchParams.get("error")
      assert.equal(error, expectedError)
      return
    }

    assert(
      response.status >= 400,
      `OAuth rejection returned unexpected HTTP ${response.status}`
    )
    const body = await response.text()
    assert(
      body.includes(expectedError),
      `OAuth rejection did not include ${expectedError}: ${body}`
    )
  }

  try {
    const browserSession = new CookieJar()
    const signedOutBrowser = await authorize({
      clientId,
      redirectUri,
      state: "browser-signed-out",
      jar: browserSession,
    })
    assert.equal(
      signedOutBrowser.callback.searchParams.get("state"),
      "browser-signed-out"
    )
    assert(signedOutBrowser.callback.searchParams.get("code"))
    assert.deepEqual(
      signedOutBrowser.prompts,
      ["login"],
      JSON.stringify(observedPrompts, null, 2)
    )

    const signedInBrowser = await authorize({
      clientId,
      redirectUri,
      state: "browser-signed-in",
      jar: browserSession,
    })
    assert.equal(
      signedInBrowser.callback.searchParams.get("state"),
      "browser-signed-in"
    )
    assert(signedInBrowser.callback.searchParams.get("code"))
    assert.deepEqual(signedInBrowser.prompts, [])

    const nativeFirstParty = await authorize({
      clientId: nativeClientId,
      redirectUri: nativeRedirectUri,
      state: "native-first-party",
      jar: new CookieJar(),
    })
    assert.equal(
      nativeFirstParty.callback.searchParams.get("state"),
      "native-first-party"
    )
    assert(nativeFirstParty.callback.searchParams.get("code"))
    assert.deepEqual(nativeFirstParty.prompts, ["login"])

    const thirdParty = await authorize({
      clientId: thirdPartyClientId,
      redirectUri: thirdPartyRedirectUri,
      state: "third-party",
      jar: new CookieJar(),
    })
    assert.equal(
      thirdParty.callback.searchParams.get("state"),
      "third-party"
    )
    assert(thirdParty.callback.searchParams.get("code"))
    assert.deepEqual(thirdParty.prompts, ["login", "consent"])

    await assertAuthorizationRejected(
      authorizationUrl({
        clientId,
        redirectUri,
        state: "unregistered-scope",
        scope: "openid content:not_registered",
      }),
      "invalid_scope"
    )
    await assertAuthorizationRejected(
      authorizationUrl({
        clientId,
        redirectUri:
          "https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org/wrong",
        state: "callback-mismatch",
      }),
      "invalid_redirect_uri"
    )
    await assertAuthorizationRejected(
      authorizationUrl({
        clientId,
        redirectUri:
          "https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium",
        state: "retired-extension-callback",
      }),
      "invalid_redirect_uri"
    )
    await assertAuthorizationRejected(
      authorizationUrl({
        clientId,
        redirectUri,
        state: "missing-pkce",
        includeChallenge: false,
      }),
      "invalid_request"
    )
    await assertAuthorizationRejected(
      authorizationUrl({
        clientId,
        redirectUri,
        state: "plain-pkce",
        challengeMethod: "plain",
      }),
      "invalid_request"
    )
    await assertAuthorizationRejected(
      authorizationUrl({
        clientId: "inactive-or-unknown-client",
        redirectUri,
        state: "inactive-client",
      }),
      "invalid_client"
    )

    assert.equal(
      nativeClient.redirectUriAllowed(nativeRedirectUri),
      true
    )
    assert.equal(
      nativeClient.redirectUriAllowed(
        "org.psd401.atrium-capture:/oauth/wrong"
      ),
      false
    )
    assert.equal(
      loopbackClient.redirectUriAllowed(
        "http://127.0.0.1:49152/oauth/callback"
      ),
      true
    )
    assert.equal(
      loopbackClient.redirectUriAllowed(
        "http://localhost:49152/oauth/callback"
      ),
      false
    )
    assert.equal(
      loopbackClient.redirectUriAllowed(
        "http://127.0.0.1:49152/wrong"
      ),
      false
    )

    const wrongVerifierCode = await authorizationCode()
    const wrongVerifier = await postForm<OAuthError>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: wrongVerifierCode,
      code_verifier: "b".repeat(64),
    })
    assert.equal(wrongVerifier.status, 400)
    assert.equal(wrongVerifier.body.error, "invalid_grant")

    const wrongRedirectCode = await authorizationCode()
    const wrongRedirect = await postForm<OAuthError>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "https://abcdefghijklmnop.chromiumapp.org/wrong",
      code: wrongRedirectCode,
      code_verifier: verifier,
    })
    assert.equal(wrongRedirect.status, 400)
    assert.equal(wrongRedirect.body.error, "invalid_grant")

    const expiredCode = await authorizationCode(true)
    const expired = await postForm<OAuthError>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: expiredCode,
      code_verifier: verifier,
    })
    assert.equal(expired.status, 400)
    assert.equal(expired.body.error, "invalid_grant")

    const browserFakeCode = await postForm<OAuthError>(
      origin,
      "/token",
      {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: "deliberately-fake-code",
        code_verifier: "a".repeat(43),
      },
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )
    assert.equal(browserFakeCode.status, 400)
    assert.equal(browserFakeCode.body.error, "invalid_grant")
    assert.equal(
      browserFakeCode.allowOrigin,
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )

    const browserFakeRefresh = await postForm<OAuthError>(
      origin,
      "/token",
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: "deliberately-fake-refresh-token",
      },
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )
    assert.equal(browserFakeRefresh.status, 400)
    assert.equal(browserFakeRefresh.body.error, "invalid_grant")
    assert.equal(
      browserFakeRefresh.allowOrigin,
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )

    const wrongBrowserOrigin = await postForm<OAuthError>(
      origin,
      "/token",
      {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: "deliberately-fake-code",
        code_verifier: "a".repeat(43),
      },
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
    assert.equal(wrongBrowserOrigin.status, 400)
    assert.equal(wrongBrowserOrigin.body.error, "invalid_request")
    assert.equal(wrongBrowserOrigin.allowOrigin, null)

    const code = await authorizationCode()
    const token = await postForm<TokenSuccess>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    })
    assert.equal(token.status, 200, JSON.stringify(token.body))
    assert.equal(token.body.token_type, "Bearer")
    assert.equal(token.body.expires_in, 900)
    assert.equal(decodeProtectedHeader(token.body.access_token).kid, "smoke-active")
    assert(token.body.refresh_token)

    const replayedCode = await postForm<OAuthError>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    })
    assert.equal(replayedCode.status, 400)
    assert.equal(replayedCode.body.error, "invalid_grant")

    const refreshCode = await authorizationCode()
    const refreshSeed = await postForm<TokenSuccess>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: refreshCode,
      code_verifier: verifier,
    })
    assert.equal(
      refreshSeed.status,
      200,
      JSON.stringify(refreshSeed.body)
    )

    const refreshed = await postForm<TokenSuccess>(origin, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshSeed.body.refresh_token,
    })
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
    assert.notEqual(refreshed.body.refresh_token, token.body.refresh_token)

    const replayedRefresh = await postForm<OAuthError>(origin, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshSeed.body.refresh_token,
    })
    assert.equal(replayedRefresh.status, 400)
    assert.equal(replayedRefresh.body.error, "invalid_grant")

    const revokeCode = await authorizationCode()
    const revokeSeed = await postForm<TokenSuccess>(origin, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: revokeCode,
      code_verifier: verifier,
    })
    assert.equal(revokeSeed.status, 200, JSON.stringify(revokeSeed.body))

    const revokeClaims = decodeJwt(revokeSeed.body.access_token)
    if (typeof revokeClaims.jti !== "string") {
      throw new TypeError(
        `JWT missing jti; claims: ${Object.keys(revokeClaims).join(",")}`
      )
    }
    const revokeJti = revokeClaims.jti
    const accessAdapter = new SmokeAdapter("AccessToken")
    const revokeModel = await accessAdapter.find(revokeJti)
    assert(
      revokeModel,
      `AccessToken ${revokeJti} not found; stored ids=${SmokeAdapter.ids("AccessToken").join(",")}`
    )
    await accessAdapter.destroy(revokeJti)
    assert.equal(
      await accessAdapter.find(revokeJti),
      undefined
    )

    const browserRevocation = await postForm<OAuthError>(
      origin,
      "/revocation",
      {
        client_id: clientId,
        token: "deliberately-fake-token",
      },
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )
    assert.equal(browserRevocation.status, 200)
    assert.equal(
      browserRevocation.allowOrigin,
      ATRIUM_CAPTURE_EXTENSION_ORIGIN
    )

    log.info("OAuth public-client protocol smoke passed", {
      checks: [
        "first_party_signed_out_login_only",
        "first_party_signed_in_no_prompt",
        "first_party_native_login_only",
        "third_party_consent",
        "unregistered_scope_rejected",
        "authorization_redirect_mismatch",
        "missing_pkce_rejected",
        "non_s256_pkce_rejected",
        "inactive_client_rejected",
        "wrong_verifier",
        "redirect_mismatch",
        "expired_code",
        "extension_origin_authorization_code",
        "extension_origin_refresh_token",
        "extension_origin_exact_match",
        "jwt_access_token",
        "code_replay",
        "refresh_rotation",
        "refresh_replay",
        "revocation",
        "extension_origin_revocation",
        "native_custom_scheme_exact_match",
        "native_loopback_variable_port",
      ],
    })
  } finally {
    await close(server)
  }
}

main().catch((error) => {
  log.error("OAuth public-client protocol smoke failed", {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
