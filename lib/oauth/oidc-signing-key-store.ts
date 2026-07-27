/**
 * Shared OIDC signing key set.
 *
 * The application/delegation signer remains KMS-backed in production. OIDC
 * provider internals require a private JWK, so OIDC uses a separate encrypted
 * Secrets Manager key set with an explicit active key and retiring verification
 * keys. Every ECS task reads the same secret, which makes tokens durable across
 * tasks and restarts.
 *
 * Issue #1285.
 */

import type { JWK } from "jose"
import { createLogger } from "@/lib/logger"

const CACHE_TTL_MS = 5 * 60 * 1000
const PRIVATE_RSA_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const

export interface StoredOidcSigningKey {
  status: "active" | "standby" | "retiring"
  createdAt: string
  activateAfter?: string
  retireAfter?: string
  jwk: JWK
}

export interface StoredOidcSigningKeySet {
  version: 1
  activeKid: string
  keys: StoredOidcSigningKey[]
}

export interface OidcSigningKeySet {
  activeKid: string
  signingKeys: JWK[]
  publicKeys: JWK[]
  source: "secrets-manager" | "local-development"
}

let cached: OidcSigningKeySet | null = null
let cacheTimestamp = 0
let loading: Promise<OidcSigningKeySet> | null = null

function requiredString(
  value: unknown,
  field: string,
  keyIndex: number
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `OIDC signing secret key ${keyIndex} is missing required JWK field ${field}`
    )
  }
  return value
}

function publicJwk(jwk: JWK): JWK {
  const withPrivateFields = jwk as JWK & { oth?: unknown }
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    oth: _oth,
    ...publicFields
  } = withPrivateFields
  return publicFields
}

function requireStoredKeySet(input: unknown): StoredOidcSigningKeySet {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("OIDC signing secret must contain a JSON object")
  }
  const candidate = input as Partial<StoredOidcSigningKeySet>
  if (candidate.version !== 1) {
    throw new TypeError(
      "OIDC signing secret has unsupported version; expected 1"
    )
  }
  if (
    typeof candidate.activeKid !== "string"
    || candidate.activeKid.length === 0
  ) {
    throw new TypeError("OIDC signing secret is missing activeKid")
  }
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new TypeError("OIDC signing secret must contain at least one key")
  }
  return candidate as StoredOidcSigningKeySet
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

const OIDC_KEY_STATUSES = new Set([
  "active",
  "standby",
  "retiring",
])

function validateStoredKey(
  entry: unknown,
  index: number
): { key: StoredOidcSigningKey; kid: string } {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError(`OIDC signing secret key ${index} must be an object`)
  }
  const key = entry as StoredOidcSigningKey
  if (!OIDC_KEY_STATUSES.has(key.status)) {
    throw new TypeError(
      `OIDC signing secret key ${index} has invalid status`
    )
  }
  if (!isValidDateString(key.createdAt)) {
    throw new TypeError(
      `OIDC signing secret key ${index} has invalid createdAt`
    )
  }
  if (typeof key.jwk !== "object" || key.jwk === null) {
    throw new TypeError(`OIDC signing secret key ${index} is missing jwk`)
  }

  const kid = requiredString(key.jwk.kid, "kid", index)
  requiredString(key.jwk.n, "n", index)
  requiredString(key.jwk.e, "e", index)
  for (const field of PRIVATE_RSA_FIELDS) {
    requiredString(key.jwk[field], field, index)
  }
  if (
    key.jwk.kty !== "RSA"
    || key.jwk.alg !== "RS256"
    || key.jwk.use !== "sig"
  ) {
    throw new TypeError(
      `OIDC signing secret key ${index} must be an RSA/RS256 signing JWK`
    )
  }
  return { key, kid }
}

interface SigningKeyAccumulator {
  usable: StoredOidcSigningKey[]
  activeCount: number
  standbyCount: number
  storedActive?: StoredOidcSigningKey
  dueStandby?: StoredOidcSigningKey
}

function addStoredKey(options: {
  key: StoredOidcSigningKey
  kid: string
  activeKid: string
  now: Date
  accumulator: SigningKeyAccumulator
}): void {
  const { key, kid, activeKid, now, accumulator } = options
  if (key.status === "active") {
    accumulator.activeCount += 1
    if (kid !== activeKid) {
      throw new TypeError(
        `OIDC signing secret active key ${kid} does not match activeKid`
      )
    }
    accumulator.storedActive = key
    accumulator.usable.push(key)
    return
  }

  if (key.status === "standby") {
    accumulator.standbyCount += 1
    if (!isValidDateString(key.activateAfter)) {
      throw new TypeError(
        `OIDC signing secret standby key ${kid} needs a valid activateAfter`
      )
    }
    if (Date.parse(key.activateAfter) <= now.getTime()) {
      accumulator.dueStandby = key
    }
    accumulator.usable.push(key)
    return
  }

  if (!isValidDateString(key.retireAfter)) {
    throw new TypeError(
      `OIDC signing secret retiring key ${kid} needs a valid retireAfter`
    )
  }
  if (Date.parse(key.retireAfter) > now.getTime()) {
    accumulator.usable.push(key)
  }
}

function getEffectiveActiveKey(
  accumulator: SigningKeyAccumulator
): StoredOidcSigningKey {
  if (accumulator.activeCount !== 1) {
    throw new TypeError(
      "OIDC signing secret must contain exactly one active key"
    )
  }
  if (accumulator.standbyCount > 1) {
    throw new TypeError(
      "OIDC signing secret may contain at most one standby key"
    )
  }
  const effectiveActive =
    accumulator.dueStandby ?? accumulator.storedActive
  if (!effectiveActive) {
    throw new TypeError("OIDC signing secret has no effective active key")
  }
  return effectiveActive
}

export function parseOidcSigningKeySet(
  input: unknown,
  now = new Date()
): OidcSigningKeySet {
  const candidate = requireStoredKeySet(input)
  const seenKids = new Set<string>()
  const accumulator: SigningKeyAccumulator = {
    usable: [],
    activeCount: 0,
    standbyCount: 0,
  }

  for (const [index, entry] of candidate.keys.entries()) {
    const { key, kid } = validateStoredKey(entry, index)
    if (seenKids.has(kid)) {
      throw new TypeError(`OIDC signing secret contains duplicate kid ${kid}`)
    }
    seenKids.add(kid)
    addStoredKey({
      key,
      kid,
      activeKid: candidate.activeKid,
      now,
      accumulator,
    })
  }

  const effectiveActive = getEffectiveActiveKey(accumulator)
  const effectiveKid = requiredString(effectiveActive.jwk.kid, "kid", 0)

  // oidc-provider chooses the first equally suitable signing key. A staged key
  // is advertised to every task before activateAfter, then becomes first
  // without a second secret write. The activation delay is longer than the
  // process cache, eliminating a mixed-task unknown-kid window.
  accumulator.usable.sort((left, right) => {
    if (left.jwk.kid === effectiveKid) return -1
    if (right.jwk.kid === effectiveKid) return 1
    if (left.status === "retiring" && right.status !== "retiring") return 1
    if (right.status === "retiring" && left.status !== "retiring") return -1
    return 0
  })

  return {
    activeKid: effectiveKid,
    signingKeys: accumulator.usable.map((entry) => ({ ...entry.jwk })),
    publicKeys: accumulator.usable.map((entry) => publicJwk(entry.jwk)),
    source: "secrets-manager",
  }
}

async function loadFromSecretsManager(
  secretId: string
): Promise<OidcSigningKeySet> {
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    "@aws-sdk/client-secrets-manager"
  )
  const result = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId })
  )
  if (!result.SecretString) {
    throw new Error("OIDC signing secret has no SecretString")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.SecretString)
  } catch {
    throw new TypeError("OIDC signing secret is not valid JSON")
  }
  return parseOidcSigningKeySet(parsed)
}

async function loadLocalDevelopmentKeySet(): Promise<OidcSigningKeySet> {
  const { getJwtSigner } = await import("./jwt-signer")
  const signer = await getJwtSigner()
  const signingJwk = await signer.getSigningJwk()
  if (!signingJwk) {
    throw new Error(
      "OIDC_SIGNING_JWKS_SECRET_ARN is required when the configured application signer is non-exportable"
    )
  }
  const jwk = signingJwk as JWK
  const kid = requiredString(jwk.kid, "kid", 0)
  return {
    activeKid: kid,
    signingKeys: [jwk],
    publicKeys: [publicJwk(jwk)],
    source: "local-development",
  }
}

async function loadKeySet(): Promise<OidcSigningKeySet> {
  const secretId = process.env.OIDC_SIGNING_JWKS_SECRET_ARN
  if (secretId) {
    return loadFromSecretsManager(secretId)
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OIDC_SIGNING_JWKS_SECRET_ARN is required in production; refusing per-process or KMS-incompatible OIDC signing fallback"
    )
  }
  return loadLocalDevelopmentKeySet()
}

export async function getOidcSigningKeySet(): Promise<OidcSigningKeySet> {
  const now = Date.now()
  if (cached && now - cacheTimestamp < CACHE_TTL_MS) return cached
  if (loading) return loading

  loading = loadKeySet()
  try {
    cached = await loading
    cacheTimestamp = now
    createLogger({ action: "oidcSigningKeys.load" }).info(
      "OIDC signing key set loaded",
      {
        activeKid: cached.activeKid,
        verificationKeyCount: cached.publicKeys.length,
        source: cached.source,
      }
    )
    return cached
  } catch (error) {
    createLogger({ action: "oidcSigningKeys.load" }).error(
      "OIDC signing key set unavailable; OAuth token issuance is disabled",
      {
        error: error instanceof Error ? error.message : String(error),
        configured: Boolean(process.env.OIDC_SIGNING_JWKS_SECRET_ARN),
      }
    )
    throw error
  } finally {
    loading = null
  }
}

export function resetOidcSigningKeySetCache(): void {
  cached = null
  cacheTimestamp = 0
  loading = null
}
