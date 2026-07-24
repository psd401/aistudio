"use strict"

const crypto = require("node:crypto")
const https = require("node:https")
const {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} = require("@aws-sdk/client-secrets-manager")

const client = new SecretsManagerClient({})
const REQUIRED_PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi"]

function isInitialized(value) {
  try {
    const parsed = JSON.parse(value)
    const active = parsed.keys?.find(
      (entry) =>
        entry.status === "active" &&
        entry.jwk?.kid === parsed.activeKid
    )
    return (
      parsed.version === 1 &&
      typeof parsed.activeKid === "string" &&
      active?.jwk?.kty === "RSA" &&
      active.jwk.alg === "RS256" &&
      active.jwk.use === "sig" &&
      REQUIRED_PRIVATE_FIELDS.every(
        (field) => typeof active.jwk[field] === "string"
      )
    )
  } catch {
    return false
  }
}

function isBootstrapPlaceholder(value) {
  try {
    const parsed = JSON.parse(value)
    return (
      parsed.version === 0 &&
      typeof parsed.bootstrap === "string" &&
      parsed.bootstrap.length > 0
    )
  } catch {
    return false
  }
}

function newKeySet() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
  })
  const kid = `oidc-${crypto.randomUUID()}`
  return {
    version: 1,
    activeKid: kid,
    keys: [
      {
        status: "active",
        createdAt: new Date().toISOString(),
        jwk: {
          ...privateKey.export({ format: "jwk" }),
          kid,
          alg: "RS256",
          use: "sig",
        },
      },
    ],
  }
}

async function bootstrap(secretId) {
  const current = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  )
  if (current.SecretString && isInitialized(current.SecretString)) {
    return "existing"
  }
  if (
    current.SecretString &&
    !isBootstrapPlaceholder(current.SecretString)
  ) {
    throw new Error(
      "OIDC signing secret is neither initialized nor the CDK bootstrap placeholder; refusing to overwrite it"
    )
  }

  await client.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(newKeySet()),
    })
  )
  return "created"
}

async function respond(event, context, status, data, physicalResourceId) {
  const body = JSON.stringify({
    Status: status,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: true,
    Data: data,
  })
  const responseUrl = new URL(event.ResponseURL)

  await new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: responseUrl.hostname,
        path: `${responseUrl.pathname}${responseUrl.search}`,
        method: "PUT",
        headers: {
          "content-type": "",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume()
        response.on("end", resolve)
      }
    )
    request.on("error", reject)
    request.end(body)
  })
}

exports.handler = async (event, context) => {
  const secretId = event.ResourceProperties.SecretId
  const physicalResourceId =
    event.PhysicalResourceId ?? `oidc-key-bootstrap:${secretId}`

  try {
    const result =
      event.RequestType === "Delete"
        ? "retained"
        : await bootstrap(secretId)
    await respond(
      event,
      context,
      "SUCCESS",
      { Result: result },
      physicalResourceId
    )
  } catch (error) {
    // This standalone Lambda cannot import the Next.js logger.
    console.error("OIDC signing key bootstrap failed", error) // eslint-disable-line no-console
    await respond(
      event,
      context,
      "FAILED",
      { Error: error instanceof Error ? error.message : String(error) },
      physicalResourceId
    )
  }
}
