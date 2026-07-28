import type { RunTelemetry } from "../../infra/lambdas/agent-cron/run-telemetry"
import { runSchedulePreflight } from "../../infra/lambdas/agent-cron/schedule-preflight"

const event = {
  ownerEmail: "owner@psd401.net",
  scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
  version: 2,
}

function harness() {
  const recordRun = jest.fn().mockResolvedValue(undefined)
  const recordCronFailure = jest.fn().mockResolvedValue(undefined)
  const telemetry = {
    recordRun,
    recordCronFailure,
  } satisfies RunTelemetry
  const log = {
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { telemetry, recordRun, log }
}

describe("agent-cron pre-invocation telemetry", () => {
  it.each([
    "not-found",
    "owner-mismatch",
    "version-mismatch",
    "disabled",
  ] as const)("records %s schedule references as skipped", async (reason) => {
    const { telemetry, recordRun, log } = harness()

    await expect(
      runSchedulePreflight(event, {
        requestId: "cron_request",
        startedAt: Date.now(),
        load: async () => ({ authorized: false, reason }),
        telemetry,
        log,
      }),
    ).resolves.toEqual({
      loaded: { authorized: false, reason },
      referencedScheduleId: event.scheduleId,
    })
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: event.ownerEmail,
        scheduleId: event.scheduleId,
        status: "skipped",
        errorMessage: `Schedule reference rejected: ${reason}`,
      }),
      log,
    )
  })

  it("records and rethrows DynamoDB lookup failures for retry and alarms", async () => {
    const { telemetry, recordRun, log } = harness()
    const lookupError = new Error("DynamoDB unavailable")

    await expect(
      runSchedulePreflight(event, {
        requestId: "cron_request",
        startedAt: Date.now(),
        load: async () => {
          throw lookupError
        },
        telemetry,
        log,
      }),
    ).rejects.toThrow(lookupError)
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: event.ownerEmail,
        scheduleId: event.scheduleId,
        status: "error",
        errorMessage:
          "Authoritative schedule lookup failed: DynamoDB unavailable",
      }),
      log,
    )
  })
})
