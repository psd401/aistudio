/**
 * Rotate the dedicated OIDC signing JWK set (Issue #1285).
 *
 * Safe by default: without --apply, validates the current secret and reports the
 * planned key counts without writing. A new key is first published as standby,
 * then becomes effective after OIDC_KEY_ACTIVATION_DELAY_MINUTES (default 6,
 * longer than the five-minute task cache). The previous key remains available
 * for OIDC_KEY_OVERLAP_HOURS (default 2).
 *
 * Run:
 *   OIDC_SIGNING_JWKS_SECRET_ARN=... bunx tsx scripts/oauth/rotate-oidc-signing-keys.ts
 *   OIDC_SIGNING_JWKS_SECRET_ARN=... bunx tsx scripts/oauth/rotate-oidc-signing-keys.ts --apply
 */

import { generateKeyPairSync, randomUUID } from "node:crypto"
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"
import {
  parseOidcSigningKeySet,
  type StoredOidcSigningKeySet,
  type StoredOidcSigningKey,
} from "@/lib/oauth/oidc-signing-key-store"
import { scriptLogger as log } from "../db/script-logger"

function generateSigningKey(
  now: Date,
  activateAfter: Date
): StoredOidcSigningKey {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
  })
  const kid = `oidc-${randomUUID()}`
  return {
    status: "standby",
    createdAt: now.toISOString(),
    activateAfter: activateAfter.toISOString(),
    jwk: {
      ...privateKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  }
}

export function buildRotatedOidcKeySet(
  existing: StoredOidcSigningKeySet,
  now: Date,
  overlapHours: number,
  activationDelayMinutes: number
): StoredOidcSigningKeySet {
  const current = parseOidcSigningKeySet(existing, now)
  if (!Number.isFinite(overlapHours) || overlapHours < 1) {
    throw new Error("OIDC_KEY_OVERLAP_HOURS must be at least 1")
  }
  if (
    !Number.isFinite(activationDelayMinutes) ||
    activationDelayMinutes < 6
  ) {
    throw new Error(
      "OIDC_KEY_ACTIVATION_DELAY_MINUTES must be at least 6"
    )
  }

  const retireAfter = new Date(
    now.getTime() + overlapHours * 60 * 60 * 1000
  ).toISOString()
  const activateAfter = new Date(
    now.getTime() + activationDelayMinutes * 60 * 1000
  )
  const standby = generateSigningKey(now, activateAfter)
  const effectiveActive = existing.keys.find(
    (key) => key.jwk.kid === current.activeKid
  )
  if (!effectiveActive) {
    throw new Error("Effective active OIDC key is missing from stored key set")
  }

  const retained = existing.keys
    .filter((key) => key.jwk.kid !== current.activeKid)
    .filter(
      (key) =>
        (key.retireAfter != null &&
          Date.parse(key.retireAfter) > now.getTime()) ||
        key.status === "active" ||
        key.status === "standby"
    )
    .map((key) =>
      key.status === "active" || key.status === "standby"
        ? {
            ...key,
            status: "retiring" as const,
            activateAfter: undefined,
            retireAfter,
          }
        : key
    )

  return {
    version: 1,
    activeKid: current.activeKid,
    keys: [
      {
        ...effectiveActive,
        status: "active",
        activateAfter: undefined,
        retireAfter: undefined,
      },
      standby,
      ...retained,
    ],
  }
}

async function main(): Promise<void> {
  const secretId = process.env.OIDC_SIGNING_JWKS_SECRET_ARN
  if (!secretId) {
    throw new Error("OIDC_SIGNING_JWKS_SECRET_ARN is required")
  }
  const overlapHours = Number(process.env.OIDC_KEY_OVERLAP_HOURS ?? "2")
  const activationDelayMinutes = Number(
    process.env.OIDC_KEY_ACTIVATION_DELAY_MINUTES ?? "6"
  )
  const apply = process.argv.includes("--apply")
  const secrets = new SecretsManagerClient({})
  const current = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  )
  if (!current.SecretString) {
    throw new Error("OIDC signing secret has no SecretString")
  }
  const parsed = JSON.parse(current.SecretString) as unknown
  parseOidcSigningKeySet(parsed)
  const rotated = buildRotatedOidcKeySet(
    parsed as StoredOidcSigningKeySet,
    new Date(),
    overlapHours,
    activationDelayMinutes
  )
  const standby = rotated.keys.find((key) => key.status === "standby")
  if (!standby) throw new Error("Rotation did not produce a standby key")

  log.info("OIDC signing key rotation plan", {
    apply,
    currentActiveKid: rotated.activeKid,
    stagedKid: standby.jwk.kid,
    activateAfter: standby.activateAfter,
    retiringKeyCount: rotated.keys.filter(
      (key) => key.status === "retiring"
    ).length,
    overlapHours,
    activationDelayMinutes,
  })
  if (!apply) {
    log.info("Dry run only; pass --apply to write the new key set")
    return
  }

  await secrets.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(rotated),
    })
  )
  log.info("OIDC signing key set rotated", {
    currentActiveKid: rotated.activeKid,
    stagedKid: standby.jwk.kid,
    activateAfter: standby.activateAfter,
  })
}

main().catch((error) => {
  log.error("OIDC signing key rotation failed", {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
