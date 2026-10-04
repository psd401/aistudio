import { describe, expect, test } from "bun:test"
import { agentCronTestHelpers } from "./index"

const { toInvokeResult, deliverScheduledResult } = agentCronTestHelpers

// Prod 2026-10-03: two every-15-minute watchers tell the model to reply exactly
// NO_REPLY when nothing changed. The harness now surfaces that as
// metadata.silent (scheduled runs only); this Lambda must treat it as a clean
// success and post nothing — not "No response from agent." and not the bare
// "📋 name" header.

describe("silent scheduled runs", () => {
  test("metadata.silent maps to a successful, empty, silent result", () => {
    const result = toInvokeResult({
      result: "",
      metadata: {
        silent: true,
        input_tokens: 6,
        output_tokens: 249,
        workspace_finalization_confirmed: true,
      },
    })

    expect(result.silent).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.response).toBe("")
    expect(result.errorClass).toBeUndefined()
    expect(result.inputTokens).toBe(6)
    expect(result.outputTokens).toBe(249)
    expect(result.workspaceFinalizationConfirmed).toBe(true)
  })

  test("a failed turn is never treated as silent", () => {
    const result = toInvokeResult({
      result: "I processed your message but had no response.",
      metadata: { silent: true, failed: true, error_class: "EmptyAgentResponse" },
    })

    expect(result.silent).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.response).toBe("I processed your message but had no response.")
  })

  test("an empty result without the silent flag keeps the old fallback", () => {
    const result = toInvokeResult({ result: "", metadata: {} })

    expect(result.silent).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.response).toBe("No response from agent.")
  })

  test("a silent result completes as success without posting to Chat", async () => {
    const logged: string[] = []
    const log = {
      info: (message: string) => logged.push(message),
      warn: (message: string) => logged.push(message),
      error: (message: string) => logged.push(message),
      debug: () => undefined,
    }
    const outcome = await deliverScheduledResult({
      schedule: {
        scheduleId: "sched-1",
        ownerEmail: "owner@psd401.net",
        dmSpaceName: "spaces/test",
      } as never,
      scheduleName: "Watcher",
      startTime: Date.now(),
      sessionId: "owner-sched-1",
      runtimeSessionId: "runtime-1",
      workspaceLockId: "lock-1",
      fireIdentity: null,
      result: toInvokeResult({ result: "", metadata: { silent: true } }),
      log: log as never,
    })

    expect(outcome).toEqual({ status: "success", scheduleId: "sched-1" })
    expect(logged).toContain("Scheduled run ended silently — nothing posted")
    expect(logged).not.toContain("Scheduled response sent to Google Chat")
  })
})
