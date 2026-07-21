import type {
  RepositoryProcessingJobStatus,
  RepositoryProcessingStage,
} from "@/lib/db/schema";

export const CONTENT_PROCESSOR_CONTRACT_VERSION = "unified-content-v1";

export interface ProcessingJobState {
  status: RepositoryProcessingJobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}
export type ProcessingJobEvent =
  | { type: "queue" }
  | { type: "start"; workerId: string; leaseDurationMs: number }
  | { type: "succeed" }
  | { type: "fail" }
  | { type: "retry"; delayMs: number }
  | { type: "cancel" };

const ALLOWED_TRANSITIONS: Record<
  RepositoryProcessingJobStatus,
  readonly RepositoryProcessingJobStatus[]
> = {
  pending: ["queued", "cancelled"],
  queued: ["running", "pending", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: ["pending", "cancelled"],
  cancelled: [],
};

export function buildProcessingIdempotencyKey(
  itemVersionId: string,
  stage: RepositoryProcessingStage,
  processorVersion = CONTENT_PROCESSOR_CONTRACT_VERSION
): string {
  return `${itemVersionId}:${stage}:${processorVersion}`;
}

export function canTransitionProcessingJob(
  from: RepositoryProcessingJobStatus,
  to: RepositoryProcessingJobStatus
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function assertTransition(
  from: RepositoryProcessingJobStatus,
  to: RepositoryProcessingJobStatus
): void {
  if (!canTransitionProcessingJob(from, to)) {
    throw new Error(`Invalid processing job transition: ${from} -> ${to}`);
  }
}

export function transitionProcessingJob(
  current: ProcessingJobState,
  event: ProcessingJobEvent,
  now = new Date()
): ProcessingJobState {
  if (event.type === "queue") {
    assertTransition(current.status, "queued");
    return { ...current, status: "queued" };
  }

  if (event.type === "start") {
    assertTransition(current.status, "running");
    if (!event.workerId.trim()) throw new Error("Worker id is required");
    if (event.leaseDurationMs <= 0) {
      throw new Error("Lease duration must be positive");
    }
    if (current.attempt >= current.maxAttempts) {
      throw new Error("Processing job has exhausted its attempts");
    }
    return {
      ...current,
      status: "running",
      attempt: current.attempt + 1,
      leaseOwner: event.workerId,
      leaseExpiresAt: new Date(now.getTime() + event.leaseDurationMs),
      startedAt: now,
      finishedAt: null,
    };
  }

  if (event.type === "succeed") {
    assertTransition(current.status, "succeeded");
    return {
      ...current,
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
    };
  }

  if (event.type === "fail") {
    assertTransition(current.status, "failed");
    return {
      ...current,
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
    };
  }

  if (event.type === "retry") {
    assertTransition(current.status, "pending");
    if (current.attempt >= current.maxAttempts) {
      throw new Error("Processing job has exhausted its attempts");
    }
    if (event.delayMs < 0) throw new Error("Retry delay cannot be negative");
    return {
      ...current,
      status: "pending",
      availableAt: new Date(now.getTime() + event.delayMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
    };
  }

  assertTransition(current.status, "cancelled");
  return {
    ...current,
    status: "cancelled",
    leaseOwner: null,
    leaseExpiresAt: null,
    finishedAt: now,
  };
}
