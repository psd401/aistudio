import { createHash } from "node:crypto";
import type { RepositoryProcessingMetrics } from "../../../lib/db/schema";

export interface TextractResumeState {
  metrics: RepositoryProcessingMetrics;
  jobId: string | null;
  reset: boolean;
}

export interface BdaResumeState {
  metrics: RepositoryProcessingMetrics;
  invocationArn: string | null;
  outputPrefix: string;
  reset: boolean;
}

/**
 * Managed-service identifiers are only reusable for the exact immutable S3
 * artifact that created them. Processor-version changes can intentionally move
 * derivatives to a new key, so stale Textract state must be discarded instead
 * of retried forever or attached to the wrong artifact.
 */
export function reconcileTextractState(
  source: RepositoryProcessingMetrics,
  expectedObjectKey: string
): TextractResumeState {
  const jobId = source.textractJobId;
  if (jobId && source.textractObjectKey === expectedObjectKey) {
    return { metrics: { ...source }, jobId, reset: false };
  }

  const reset = Boolean(jobId || source.textractObjectKey);
  const {
    textractJobId: _textractJobId,
    textractObjectKey: _textractObjectKey,
    ...remaining
  } = source;
  if (remaining.waitReason === "AWAITING_OCR") {
    delete remaining.waitReason;
    delete remaining.waitStartedAt;
  }

  return {
    metrics: remaining,
    jobId: null,
    reset,
  };
}

export function attachTextractJob(
  source: RepositoryProcessingMetrics,
  objectKey: string,
  jobId: string
): RepositoryProcessingMetrics {
  return {
    ...source,
    textractObjectKey: objectKey,
    textractJobId: jobId,
  };
}

/**
 * Scope every BDA invocation to its immutable source and processing run. A
 * run-specific output prefix prevents a replacement invocation from reading a
 * failed predecessor's partial standard output.
 */
export function reconcileBdaState(
  source: RepositoryProcessingMetrics,
  sourceObjectKey: string,
  baseOutputPrefix: string,
  clientToken: string
): BdaResumeState {
  const outputPrefix = `${baseOutputPrefix}runs/${clientToken}/`;
  if (
    source.bdaInvocationArn &&
    source.bdaSourceObjectKey === sourceObjectKey &&
    source.bdaOutputPrefix === outputPrefix
  ) {
    return {
      metrics: { ...source },
      invocationArn: source.bdaInvocationArn,
      outputPrefix,
      reset: false,
    };
  }

  const reset = Boolean(
    source.bdaInvocationArn ||
      source.bdaSourceObjectKey ||
      source.bdaOutputPrefix ||
      source.bdaResultObjectKey
  );
  const {
    bdaInvocationArn: _bdaInvocationArn,
    bdaSourceObjectKey: _bdaSourceObjectKey,
    bdaOutputPrefix: _bdaOutputPrefix,
    bdaResultObjectKey: _bdaResultObjectKey,
    ...remaining
  } = source;
  if (remaining.waitReason === "AWAITING_MEDIA_ANALYSIS") {
    delete remaining.waitReason;
    delete remaining.waitStartedAt;
  }
  return { metrics: remaining, invocationArn: null, outputPrefix, reset };
}

export function attachBdaInvocation(
  source: RepositoryProcessingMetrics,
  sourceObjectKey: string,
  outputPrefix: string,
  invocationArn: string
): RepositoryProcessingMetrics {
  return {
    ...source,
    bdaSourceObjectKey: sourceObjectKey,
    bdaOutputPrefix: outputPrefix,
    bdaInvocationArn: invocationArn,
  };
}

/**
 * Keep provider retries idempotent inside one durable processing run, while a
 * user retry or post-deploy reset receives a fresh token. Object identity is
 * included so a processor-version artifact change cannot resume an invocation
 * created for a different immutable input.
 */
export function buildManagedServiceClientToken(
  provider: "textract" | "bedrock-data-automation",
  jobId: string,
  processingRunStartedAt: Date,
  objectKey: string
): string {
  if (!jobId || !objectKey || Number.isNaN(processingRunStartedAt.getTime())) {
    throw new Error("Managed-service client token requires a valid processing run");
  }
  return createHash("sha256")
    .update(
      `${provider}:${jobId}:${processingRunStartedAt.toISOString()}:${objectKey}`
    )
    .digest("hex");
}
