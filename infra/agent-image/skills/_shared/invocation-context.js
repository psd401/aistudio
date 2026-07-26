"use strict";

const fs = require("node:fs");

const DEFAULT_CONTEXT_PATH = "/tmp/psd-agent-invocation-context";
const TOKEN_RE = /^v1\.[A-Za-z0-9_-]{40,3500}\.[A-Za-z0-9_-]{43}$/;

/**
 * Return the opaque router-signed invocation context.
 *
 * Skills must pass this token to a verifying service and must never treat
 * locally decoded claims as authorization. The model can read or replace this
 * file, but it cannot forge the HMAC held by the trusted router and web tier.
 */
function readInvocationContextToken() {
  const path = process.env.PSD_INVOCATION_CONTEXT_FILE || DEFAULT_CONTEXT_PATH;
  let token;
  try {
    token = fs.readFileSync(path, "ascii").trim();
  } catch {
    throw new Error("Signed agent invocation context is unavailable");
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error("Signed agent invocation context is malformed");
  }
  return token;
}

function invocationContextHeaders() {
  return {
    "X-Agent-Invocation-Context": readInvocationContextToken(),
  };
}

function agentRequestHeaders() {
  return {
    "Content-Type": "application/json",
    ...invocationContextHeaders(),
  };
}

function internalAgentRequestHeaders(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("Internal agent API key is unavailable");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...invocationContextHeaders(),
  };
}

module.exports = {
  DEFAULT_CONTEXT_PATH,
  readInvocationContextToken,
  invocationContextHeaders,
  agentRequestHeaders,
  internalAgentRequestHeaders,
};
