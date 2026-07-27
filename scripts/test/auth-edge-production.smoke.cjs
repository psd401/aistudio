/**
 * Production-artifact regression for #1297.
 *
 * This intentionally does not import the source auth modules. It loads the
 * compiled middleware with Next's own Edge sandbox, presents a signed expired
 * session, stubs Cognito's successful InitiateAuth response inside that
 * sandbox, and proves the request stays authenticated.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS smoke loads Next's internal CJS sandbox */
/* global AbortController, process, require */

"use strict"

require("next/dist/server/node-environment")

const assert = require("node:assert/strict")
const { Buffer } = require("node:buffer")
const { existsSync, readFileSync } = require("node:fs")
const path = require("node:path")
const { getRuntimeContext } = require("next/dist/server/web/sandbox")
const { clearAllModuleContexts } = require("next/dist/server/web/sandbox/context")
const { decode, encode } = require("next-auth/jwt")

const distDir = path.resolve(process.env.NEXT_DIST_DIR || ".next")
const manifestPath = path.join(distDir, "server/middleware-manifest.json")
const secret = process.env.AUTH_SECRET

assert.ok(secret, "AUTH_SECRET is required and must match the production build")
assert.ok(existsSync(manifestPath), `Missing production middleware manifest: ${manifestPath}`)

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const entry = manifest.middleware?.["/"]

assert.ok(entry, "Production build did not emit the root middleware entry")

const middlewarePath = path.join(distDir, entry.entrypoint)
const middlewareSource = readFileSync(middlewarePath, "utf8")

assert.match(
  middlewareSource,
  /REFRESH_TOKEN_AUTH/,
  "Compiled middleware does not contain the Edge-safe Cognito refresh implementation",
)

const cookieName = "authjs.session-token"
const refreshToken = "artifact-refresh-token-123456789"
const refreshedIdToken = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ sub: "artifact-user" }),
).toString("base64url")}.signature`

async function main() {
  const cookie = await encode({
    token: {
      sub: "artifact-user",
      email: "artifact@example.test",
      name: "Artifact User",
      accessToken: "expired-access-token",
      idToken: "expired-id-token",
      refreshToken,
      expiresAt: Date.now() - 1_000,
      tokenLifetimeMs: 3_600_000,
      roleVersion: 0,
    },
    secret,
    salt: cookieName,
    maxAge: 86_400,
  })

  const paths = entry.files.map((file) => path.join(distDir, file))
  const runtime = await getRuntimeContext({
    name: entry.name,
    paths,
    useCache: false,
    edgeFunctionEntry: {
      assets: entry.assets,
      wasm: entry.wasm,
      env: entry.env,
    },
    distDir,
    clientAssetToken: "",
  })

  try {
    runtime.evaluate(`
      globalThis.__authArtifactFetchCalls = []
      globalThis.fetch = async (url, init) => {
        globalThis.__authArtifactFetchCalls.push({
          url: String(url),
          body: String(init?.body ?? ""),
        })
        return new Response(JSON.stringify({
          AuthenticationResult: {
            AccessToken: "refreshed-access-token",
            IdToken: ${JSON.stringify(refreshedIdToken)},
            RefreshToken: "rotated-refresh-token-123456789",
            ExpiresIn: 3600,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/x-amz-json-1.1" },
        })
      }
    `)

    const edgeFunction = (await runtime.context._ENTRIES[`middleware_${entry.name}`]).default
    const output = await edgeFunction({
      request: {
        headers: {
          cookie: `${cookieName}=${cookie}`,
          host: "artifact.test",
          "x-forwarded-proto": "https",
        },
        method: "GET",
        signal: new AbortController().signal,
        url: "https://artifact.test/nexus",
        waitUntil: () => {},
      },
    })

    const fetchCalls = JSON.parse(
      runtime.evaluate("JSON.stringify(globalThis.__authArtifactFetchCalls)"),
    )

    assert.equal(output.response.status, 200)
    assert.equal(output.response.headers.get("location"), null)
    const setCookie = output.response.headers.get("set-cookie")
    assert.ok(setCookie, "Refreshed session was not persisted to a response cookie")
    assert.equal(fetchCalls.length, 1)
    assert.match(fetchCalls[0].url, /^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\//)
    assert.match(fetchCalls[0].body, /"AuthFlow":"REFRESH_TOKEN_AUTH"/)
    assert.match(fetchCalls[0].body, /"ClientId":"artifact-client"/)
    assert.ok(fetchCalls[0].body.includes(refreshToken))

    const refreshedCookie = setCookie.match(/authjs\.session-token=([^;]+)/)?.[1]
    assert.ok(refreshedCookie, "Refreshed session cookie did not contain a token")
    const refreshedSession = await decode({
      token: refreshedCookie,
      secret,
      salt: cookieName,
    })
    assert.equal(refreshedSession?.sub, "artifact-user")
    assert.equal(refreshedSession?.accessToken, "refreshed-access-token")
    assert.equal(refreshedSession?.idToken, refreshedIdToken)
    assert.equal(refreshedSession?.refreshToken, "rotated-refresh-token-123456789")
    assert.ok(Number(refreshedSession?.expiresAt) > Date.now())

    process.stdout.write(
      "Auth Edge production artifact: expired session refreshed and remained authenticated\n",
    )
  } finally {
    await clearAllModuleContexts()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
