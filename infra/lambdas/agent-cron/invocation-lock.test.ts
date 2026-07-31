import { describe, expect, test } from "bun:test"
import { agentCronTestHelpers } from "./index"

const {
  invokeFailure,
  toInvokeResult,
  shouldRetainScheduledTurnLock,
} = agentCronTestHelpers

describe("scheduled AgentCore completion certainty", () => {
  test("releases after a terminal wrapper result, including an empty result", () => {
    const metadata = { workspace_finalization_confirmed: true }
    const completed = toInvokeResult({ result: "done", metadata })
    const completedEmpty = toInvokeResult({ result: "", metadata })

    expect(completed.workspaceFinalizationConfirmed).toBe(true)
    expect(shouldRetainScheduledTurnLock(completed)).toBe(false)
    expect(completedEmpty.workspaceFinalizationConfirmed).toBe(true)
    expect(shouldRetainScheduledTurnLock(completedEmpty)).toBe(false)
  })

  test("retains the workspace lease when explicit finalization proof is missing", () => {
    const missingTerminal = toInvokeResult({ result: "legacy answer" })

    expect(missingTerminal.workspaceFinalizationConfirmed).toBe(false)
    expect(shouldRetainScheduledTurnLock(missingTerminal)).toBe(true)
  })

  test("preserves an explicit wrapper failure even when it has response text", () => {
    const failed = toInvokeResult({
      result: "workspace finalization failed",
      metadata: {
        failed: true,
        error_class: "WorkspaceFinalizationFailed",
        workspace_finalization_confirmed: false,
      },
    })

    expect(failed.ok).toBe(false)
    expect(failed.errorClass).toBe("WorkspaceFinalizationFailed")
    expect(shouldRetainScheduledTurnLock(failed)).toBe(true)
  })

  test("retains after transport uncertainty but releases when no call started", () => {
    const transportFailure = invokeFailure("socket disconnected")
    const localConfigurationFailure = invokeFailure(
      "Agent is not yet deployed.",
      true,
    )

    expect(shouldRetainScheduledTurnLock(transportFailure)).toBe(true)
    expect(shouldRetainScheduledTurnLock(localConfigurationFailure)).toBe(false)
  })
})
