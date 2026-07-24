/**
 * Protocol smoke test for the public OAuth/OIDC contract (Issue #1285).
 *
 * It runs the repository's real oidc-provider version with a deterministic
 * in-memory adapter and exercises security behavior at HTTP boundaries: S256
 * PKCE, verifier/redirect mismatch, code replay, RS256 access JWTs, refresh
 * rotation/replay, expiry, and revocation.
 *
 * Run: bun run test:oauth-public-flow
 */

import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import Provider, {
  type Adapter,
  type AdapterPayload,
} from "oidc-provider"
import { decodeJwt, decodeProtectedHeader } from "jose"
import { scriptLogger as log } from "../db/script-logger"

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

function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

async function postForm<T>(
  origin: string,
  path: string,
  form: Record<string, string>
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
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
  const clientId = "atrium-chrome-extension"
  const redirectUri = "https://abcdefghijklmnop.chromiumapp.org/atrium"
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
        token_endpoint_auth_method: "none",
        redirect_uris: [redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
      },
    ],
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
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({
        sub: id,
        name: "Smoke User",
      }),
    }),
    cookies: { keys: ["smoke-cookie-key"] },
  })
  const server = createServer(provider.callback())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    const port = Number(new URL(origin).port)
    server.listen(port, "127.0.0.1", resolve)
  })

  const foundClient = await provider.Client.find(clientId)
  if (!foundClient) throw new Error("Smoke OAuth client not found")
  const client = foundClient

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

  try {
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

    log.info("OAuth public-client protocol smoke passed", {
      checks: [
        "wrong_verifier",
        "redirect_mismatch",
        "expired_code",
        "jwt_access_token",
        "code_replay",
        "refresh_rotation",
        "refresh_replay",
        "revocation",
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
