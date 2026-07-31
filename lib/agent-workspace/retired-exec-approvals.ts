export const RETIRED_EXEC_APPROVALS_SOURCE_PATH = "exec-approvals.json"
export const RETIRED_EXEC_APPROVALS_CLAIM_PATH =
  "exec-approvals.json.doctor-importing"
export const MAX_RETIRED_EXEC_APPROVALS_BYTES = 4 * 1024

const EXPECTED_SOCKET_PATH = "/home/node/.openclaw/exec-approvals.sock"
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/
const TOP_LEVEL_FIELDS = new Set([
  "version",
  "socket",
  "defaults",
  "agents",
])
const SOCKET_FIELDS = new Set(["path", "token"])

export type RetiredExecApprovalsValidationReason =
  | "claim-present"
  | "unexpected-path"
  | "body-too-large"
  | "invalid-size"
  | "missing-etag"
  | "etag-mismatch"
  | "size-mismatch"
  | "body-size-mismatch"
  | "invalid-utf8"
  | "malformed-json"
  | "invalid-top-level"
  | "unknown-top-level-field"
  | "missing-top-level-field"
  | "unsupported-version"
  | "invalid-socket"
  | "unknown-socket-field"
  | "missing-socket-field"
  | "invalid-socket-path"
  | "invalid-socket-token"
  | "invalid-defaults"
  | "nonempty-defaults"
  | "invalid-agents"
  | "nonempty-agents"

type RetiredExecApprovalsReadMetadata = {
  size: number
  eTag: string
}

type RetiredExecApprovalsRead = RetiredExecApprovalsReadMetadata & {
  body: Uint8Array
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fieldSetReason(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  unknownReason:
    | "unknown-top-level-field"
    | "unknown-socket-field",
  missingReason:
    | "missing-top-level-field"
    | "missing-socket-field",
): RetiredExecApprovalsValidationReason | null {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    return unknownReason
  }
  if (required.some((field) => !Object.hasOwn(value, field))) {
    return missingReason
  }
  return null
}

function validateSocket(
  socket: unknown,
): RetiredExecApprovalsValidationReason | null {
  if (!isRecord(socket)) return "invalid-socket"
  const socketFields = fieldSetReason(
    socket,
    SOCKET_FIELDS,
    ["path", "token"],
    "unknown-socket-field",
    "missing-socket-field",
  )
  if (socketFields) return socketFields
  if (socket.path !== EXPECTED_SOCKET_PATH) return "invalid-socket-path"
  if (typeof socket.token !== "string" || !TOKEN_PATTERN.test(socket.token)) {
    return "invalid-socket-token"
  }
  return null
}

function validateEmptyPolicyMap(
  value: unknown,
  invalidReason: "invalid-defaults" | "invalid-agents",
  nonemptyReason: "nonempty-defaults" | "nonempty-agents",
): RetiredExecApprovalsValidationReason | null {
  if (!isRecord(value)) return invalidReason
  return Object.keys(value).length === 0 ? null : nonemptyReason
}

/**
 * Only the generated source is safe to retire. An interrupted migration claim
 * is evidence of unknown state and must always stop the release audit.
 */
export function validateRetiredExecApprovalsPath(
  relativePath: string,
): RetiredExecApprovalsValidationReason | null {
  if (relativePath === RETIRED_EXEC_APPROVALS_SOURCE_PATH) return null
  if (relativePath === RETIRED_EXEC_APPROVALS_CLAIM_PATH) {
    return "claim-present"
  }
  return "unexpected-path"
}

/**
 * Validate the exact OpenClaw-generated, socket-only approvals control file.
 * The result deliberately contains no parsed fields so callers cannot log the
 * socket token or source body by accident.
 */
export function validateRetiredExecApprovalsBody(
  body: Uint8Array,
): RetiredExecApprovalsValidationReason | null {
  if (body.byteLength > MAX_RETIRED_EXEC_APPROVALS_BYTES) {
    return "body-too-large"
  }

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    return "invalid-utf8"
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return "malformed-json"
  }
  if (!isRecord(parsed)) return "invalid-top-level"

  const topLevelFields = fieldSetReason(
    parsed,
    TOP_LEVEL_FIELDS,
    ["version", "socket", "defaults", "agents"],
    "unknown-top-level-field",
    "missing-top-level-field",
  )
  if (topLevelFields) return topLevelFields
  if (parsed.version !== 1) return "unsupported-version"

  const socketReason = validateSocket(parsed.socket)
  if (socketReason) return socketReason
  const defaultsReason = validateEmptyPolicyMap(
    parsed.defaults,
    "invalid-defaults",
    "nonempty-defaults",
  )
  if (defaultsReason) return defaultsReason
  return validateEmptyPolicyMap(
    parsed.agents,
    "invalid-agents",
    "nonempty-agents",
  )
}

/** Validate that a bounded conditional read still represents the listed S3 object. */
export function validateRetiredExecApprovalsRead(
  expected: RetiredExecApprovalsReadMetadata,
  actual: RetiredExecApprovalsRead,
): RetiredExecApprovalsValidationReason | null {
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    !Number.isSafeInteger(actual.size) ||
    actual.size < 0
  ) {
    return "invalid-size"
  }
  if (
    expected.size > MAX_RETIRED_EXEC_APPROVALS_BYTES ||
    actual.size > MAX_RETIRED_EXEC_APPROVALS_BYTES ||
    actual.body.byteLength > MAX_RETIRED_EXEC_APPROVALS_BYTES
  ) {
    return "body-too-large"
  }
  if (!expected.eTag || !actual.eTag) return "missing-etag"
  if (expected.eTag !== actual.eTag) return "etag-mismatch"
  if (expected.size !== actual.size) return "size-mismatch"
  if (actual.size !== actual.body.byteLength) return "body-size-mismatch"
  return validateRetiredExecApprovalsBody(actual.body)
}
