/** @jest-environment node */

import {
  buildProcessingIdempotencyKey,
  canTransitionProcessingJob,
  CONTENT_PROCESSING_MAX_ATTEMPTS,
  CONTENT_SWEEP_REDISPATCHABLE_STATUSES,
  transitionProcessingJob,
  type ProcessingJobState,
} from "@/lib/repositories/content-platform/job-state";

const now = new Date("2026-07-21T12:00:00.000Z");

function pendingState(): ProcessingJobState {
  return {
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

describe("repository processing job state", () => {
  it("bounds one automatic processing budget to five attempts", () => {
    expect(CONTENT_PROCESSING_MAX_ATTEMPTS).toBe(5);
  });

  it("runs the happy-path state machine with a bounded lease", () => {
    const queued = transitionProcessingJob(pendingState(), { type: "queue" }, now);
    const running = transitionProcessingJob(
      queued,
      { type: "start", workerId: "worker-1", leaseDurationMs: 60_000 },
      now
    );
    const succeeded = transitionProcessingJob(running, { type: "succeed" }, now);

    expect(running).toMatchObject({
      status: "running",
      attempt: 1,
      leaseOwner: "worker-1",
      startedAt: now,
    });
    expect(running.leaseExpiresAt?.toISOString()).toBe(
      "2026-07-21T12:01:00.000Z"
    );
    expect(succeeded).toMatchObject({
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
    });
  });

  it("schedules a retry only while attempts remain", () => {
    const failed: ProcessingJobState = {
      ...pendingState(),
      status: "failed",
      attempt: 2,
      finishedAt: now,
    };
    const retried = transitionProcessingJob(
      failed,
      { type: "retry", delayMs: 30_000 },
      now
    );
    expect(retried.status).toBe("pending");
    expect(retried.availableAt.toISOString()).toBe("2026-07-21T12:00:30.000Z");

    expect(() =>
      transitionProcessingJob(
        { ...failed, attempt: 3 },
        { type: "retry", delayMs: 0 },
        now
      )
    ).toThrow("exhausted");
  });

  it("rejects invalid or terminal transitions", () => {
    expect(canTransitionProcessingJob("succeeded", "pending")).toBe(false);
    expect(() =>
      transitionProcessingJob(
        { ...pendingState(), status: "succeeded" },
        { type: "queue" },
        now
      )
    ).toThrow("succeeded -> queued");
    expect(() =>
      transitionProcessingJob(
        { ...pendingState(), status: "queued" },
        { type: "start", workerId: "", leaseDurationMs: 1000 },
        now
      )
    ).toThrow("Worker id");
  });

  it("creates a stable stage and processor-version idempotency key", () => {
    expect(buildProcessingIdempotencyKey("version-1", "inspect")).toBe(
      "version-1:inspect:unified-content-v1"
    );
    expect(buildProcessingIdempotencyKey("version-1", "inspect", "pdf-v2")).toBe(
      "version-1:inspect:pdf-v2"
    );
  });

  it("leaves failed-delivery retry ownership with SQS", () => {
    expect(CONTENT_SWEEP_REDISPATCHABLE_STATUSES).toEqual(["pending"]);
    expect(CONTENT_SWEEP_REDISPATCHABLE_STATUSES).not.toContain("failed");
  });
});
