import {
  MAX_RETIRED_EXEC_APPROVALS_BYTES,
  RETIRED_EXEC_APPROVALS_CLAIM_PATH,
  RETIRED_EXEC_APPROVALS_SOURCE_PATH,
  validateRetiredExecApprovalsBody,
  validateRetiredExecApprovalsPath,
  validateRetiredExecApprovalsRead,
} from "@/lib/agent-workspace/retired-exec-approvals"

const encoder = new TextEncoder()
const VALID_APPROVALS = {
  version: 1,
  socket: {
    path: "/home/node/.openclaw/exec-approvals.sock",
    token: "AbCdEfGhIjKlMnOpQrStUvWxYz_12345",
  },
  defaults: {},
  agents: {},
}

function body(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

describe("retired exec approvals validator", () => {
  it("accepts only the exact generated socket-only source", () => {
    expect(validateRetiredExecApprovalsBody(body(VALID_APPROVALS))).toBeNull()
    expect(
      validateRetiredExecApprovalsPath(RETIRED_EXEC_APPROVALS_SOURCE_PATH),
    ).toBeNull()
  })

  it("rejects malformed JSON without returning source content", () => {
    expect(validateRetiredExecApprovalsBody(encoder.encode("{token"))).toBe(
      "malformed-json",
    )
  })

  it("rejects nonempty defaults", () => {
    expect(
      validateRetiredExecApprovalsBody(
        body({ ...VALID_APPROVALS, defaults: { security: "ask" } }),
      ),
    ).toBe("nonempty-defaults")
  })

  it("rejects every per-agent allowlist", () => {
    expect(
      validateRetiredExecApprovalsBody(
        body({ ...VALID_APPROVALS, agents: { main: { allow: ["ls"] } } }),
      ),
    ).toBe("nonempty-agents")
  })

  it("rejects unknown top-level fields", () => {
    expect(
      validateRetiredExecApprovalsBody(
        body({ ...VALID_APPROVALS, unexpected: true }),
      ),
    ).toBe("unknown-top-level-field")
  })

  it("rejects unknown socket fields", () => {
    expect(
      validateRetiredExecApprovalsBody(
        body({
          ...VALID_APPROVALS,
          socket: { ...VALID_APPROVALS.socket, mode: "private" },
        }),
      ),
    ).toBe("unknown-socket-field")
  })

  it("rejects an interrupted migration claim", () => {
    expect(
      validateRetiredExecApprovalsPath(RETIRED_EXEC_APPROVALS_CLAIM_PATH),
    ).toBe("claim-present")
  })

  it("does not retire a nested durable file with the same basename", () => {
    expect(
      validateRetiredExecApprovalsPath(
        `nested/${RETIRED_EXEC_APPROVALS_SOURCE_PATH}`,
      ),
    ).toBe("unexpected-path")
  })

  it("rejects metadata and ETag changes across the conditional read", () => {
    const validBody = body(VALID_APPROVALS)
    const expected = { size: validBody.byteLength, eTag: '"listed"' }

    expect(
      validateRetiredExecApprovalsRead(expected, {
        size: validBody.byteLength,
        eTag: '"changed"',
        body: validBody,
      }),
    ).toBe("etag-mismatch")
    expect(
      validateRetiredExecApprovalsRead(expected, {
        size: validBody.byteLength + 1,
        eTag: '"listed"',
        body: validBody,
      }),
    ).toBe("size-mismatch")
  })

  it("enforces the bounded-read ceiling", () => {
    const oversized = new Uint8Array(MAX_RETIRED_EXEC_APPROVALS_BYTES + 1)
    expect(validateRetiredExecApprovalsBody(oversized)).toBe("body-too-large")
  })
})
