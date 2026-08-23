import {
  classifyContentProcessingError,
  deferDelaySeconds,
  elapsedWaitMs,
  PermanentContentProcessingError,
  prepareDeferredProcessingMetrics,
  processingRetryDelaySeconds,
  RetryableManagedServiceJobError,
} from "../lifecycle";
import { RepositoryPublicationContentionError } from "../../../../lib/repositories/content-platform/publication-contention";

describe("repository publication contention lifecycle", () => {
  test("refunds a retry when repository publication loses the lock race", () => {
    expect(
      classifyContentProcessingError(
        new RepositoryPublicationContentionError(
          Object.assign(new Error("canceling statement due to lock timeout"), {
            code: "55P03",
          })
        )
      )
    ).toEqual({
      terminal: false,
      code: "REPOSITORY_PUBLICATION_CONTENTION",
      message: "canceling statement due to lock timeout",
      refundAttempt: true,
    });
  });
});

describe("unified content lifecycle policy", () => {
  test("classifies deterministic source failures as terminal", () => {
    expect(
      classifyContentProcessingError(
        new PermanentContentProcessingError(
          "SOURCE_NAMESPACE_INVALID",
          "Object is outside its repository namespace"
        )
      )
    ).toEqual({
      terminal: true,
      code: "SOURCE_NAMESPACE_INVALID",
      message: "Object is outside its repository namespace",
    });
  });

  test("treats upstream 4xx errors as terminal except throttling", () => {
    const invalid = Object.assign(new Error("Bad request"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });
    expect(classifyContentProcessingError(invalid)).toMatchObject({
      terminal: true,
      code: "VALIDATION_EXCEPTION",
    });

    const throttled = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 400 },
    });
    expect(classifyContentProcessingError(throttled)).toMatchObject({
      terminal: false,
      code: "TRANSIENT_PROCESSING_ERROR",
    });
  });

  test("restarts a managed-service run after the provider job itself fails", () => {
    expect(
      classifyContentProcessingError(
        new RetryableManagedServiceJobError(
          "bedrock-data-automation",
          "BDA_JOB_FAILED",
          "BDA returned ServiceError"
        )
      )
    ).toEqual({
      terminal: false,
      code: "BDA_JOB_FAILED",
      message: "BDA returned ServiceError",
      resetManagedService: "bedrock-data-automation",
    });
  });

  test("restarts a failed Textract run with a fresh provider token", () => {
    expect(
      classifyContentProcessingError(
        new RetryableManagedServiceJobError(
          "textract",
          "TEXTRACT_JOB_FAILED",
          "Textract returned FAILED"
        )
      )
    ).toEqual({
      terminal: false,
      code: "TEXTRACT_JOB_FAILED",
      message: "Textract returned FAILED",
      resetManagedService: "textract",
    });
  });

  test("uses a short exponential retry with bounded jitter", () => {
    expect(processingRetryDelaySeconds(1, () => 0)).toBe(4);
    expect(processingRetryDelaySeconds(2, () => 0.5)).toBe(10);
    expect(processingRetryDelaySeconds(20, () => 1)).toBe(900);
  });

  test("starts a wait clock and preserves it for the same reason", () => {
    const started = prepareDeferredProcessingMetrics(
      { provider: "guardduty" },
      "AWAITING_SECURITY_SCAN",
      new Date("2026-07-22T12:00:00.000Z")
    );
    expect(started).toMatchObject({
      provider: "guardduty",
      waitReason: "AWAITING_SECURITY_SCAN",
      waitStartedAt: "2026-07-22T12:00:00.000Z",
    });

    expect(
      prepareDeferredProcessingMetrics(
        started,
        "AWAITING_SECURITY_SCAN",
        new Date("2026-07-22T13:59:59.000Z")
      ).waitStartedAt
    ).toBe("2026-07-22T12:00:00.000Z");
  });

  test("fails managed-service waits at their deadline and resets for a new stage", () => {
    const scanWait = {
      waitReason: "AWAITING_SECURITY_SCAN" as const,
      waitStartedAt: "2026-07-22T12:00:00.000Z",
    };
    expect(() =>
      prepareDeferredProcessingMetrics(
        scanWait,
        "AWAITING_SECURITY_SCAN",
        new Date("2026-07-22T14:00:00.000Z")
      )
    ).toThrow("timed out");

    expect(
      prepareDeferredProcessingMetrics(
        scanWait,
        "AWAITING_OCR",
        new Date("2026-07-22T14:00:00.000Z")
      )
    ).toMatchObject({
      waitReason: "AWAITING_OCR",
      waitStartedAt: "2026-07-22T14:00:00.000Z",
    });
  });

  test("keeps an overdue BDA writer pollable and records reconciliation state", () => {
    const mediaWait = {
      waitReason: "AWAITING_MEDIA_ANALYSIS" as const,
      waitStartedAt: "2026-07-22T12:00:00.000Z",
    };
    const overdue = prepareDeferredProcessingMetrics(
      mediaWait,
      "AWAITING_MEDIA_ANALYSIS",
      new Date("2026-07-22T18:00:00.000Z")
    );
    expect(overdue).toEqual({
      ...mediaWait,
      waitDeadlineExceededAt: "2026-07-22T18:00:00.000Z",
    });
    expect(
      prepareDeferredProcessingMetrics(
        overdue,
        "AWAITING_MEDIA_ANALYSIS",
        new Date("2026-07-23T18:00:00.000Z")
      ).waitDeadlineExceededAt
    ).toBe("2026-07-22T18:00:00.000Z");
  });
});

// The exact rejection SQS returned for the 188 poisoned index generations.
// Each burned all five retry attempts on a failure that could never succeed.
const SQS_INVALID_BINARY_CHARACTER =
  "Invalid binary character '#xFFFF' was found in the message body, the set of allowed " +
  "characters is #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].";

describe("SQS invalid message body classification", () => {
  test("classifies the exact production rejection as terminal on attempt 1", () => {
    expect(
      classifyContentProcessingError(new Error(SQS_INVALID_BINARY_CHARACTER))
    ).toEqual({
      terminal: true,
      code: "INVALID_SOURCE_CONTENT",
      message: SQS_INVALID_BINARY_CHARACTER,
    });
  });

  test("stays terminal when the SDK error carries no HTTP metadata", () => {
    const error = Object.assign(new Error(SQS_INVALID_BINARY_CHARACTER), {
      name: "InvalidMessageContents",
    });
    expect(classifyContentProcessingError(error)).toMatchObject({
      terminal: true,
      code: "INVALID_SOURCE_CONTENT",
    });
  });

  test("matches either half of the rejection independently", () => {
    expect(
      classifyContentProcessingError(
        new Error("Invalid binary character was found in the message body")
      )
    ).toMatchObject({ terminal: true, code: "INVALID_SOURCE_CONTENT" });
    expect(
      classifyContentProcessingError(
        new Error("the set of allowed characters is #x9 | #xA | #xD")
      )
    ).toMatchObject({ terminal: true, code: "INVALID_SOURCE_CONTENT" });
  });

  test("does not make unrelated SQS failures terminal", () => {
    expect(
      classifyContentProcessingError(new Error("SQS connection reset by peer"))
    ).toMatchObject({ terminal: false, code: "TRANSIENT_PROCESSING_ERROR" });
    expect(
      classifyContentProcessingError(new Error("Request timeout contacting SQS"))
    ).toMatchObject({ terminal: false, code: "TRANSIENT_PROCESSING_ERROR" });
  });
});

// A canonical-artifact replay mismatch means the processor produced different
// bytes for an item version that was already published. Retrying replays the
// same deterministic output, so the whole budget is burned for nothing.
describe("canonical artifact replay mismatch classification", () => {
  test.each([
    "Existing canonical artifact coordinates do not match the replay",
    "Existing canonical artifact object key does not match the replay",
    "Existing canonical artifact inline text does not match the replay",
    "Existing canonical artifact SHA-256 does not match the replay",
    "Existing canonical artifact has no bound payload",
  ])("classifies %s as terminal", (message) => {
    expect(classifyContentProcessingError(new Error(message))).toMatchObject({
      terminal: true,
      code: "INVALID_SOURCE_CONTENT",
    });
  });

  test("does not swallow unrelated 'match' wording as terminal", () => {
    expect(
      classifyContentProcessingError(new Error("Connection reset while matching"))
    ).toMatchObject({ terminal: false });
  });
});

describe("deferred wait cadence", () => {
  test("re-polls fast-answering services in seconds, not a flat minute", () => {
    // Every reason used to defer a flat 60s. GuardDuty tags a small object and
    // Textract returns a single image within seconds, so a minute per stage was
    // pure dead time: a Nexus image paid 60s for the scan plus 60s for OCR.
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 0)).toBe(5);
    expect(deferDelaySeconds("AWAITING_OCR", 0)).toBe(5);
  });

  test("backs off as a wait drags on, bounded by the per-reason cap", () => {
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 60_000)).toBe(10);
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 120_000)).toBe(20);
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 180_000)).toBe(40);
    // Capped at 60s however long the wait runs.
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 240_000)).toBe(60);
    expect(deferDelaySeconds("AWAITING_SECURITY_SCAN", 60 * 60_000)).toBe(60);
  });

  test("polls minutes-scale and operator-gated waits slowly from the start", () => {
    expect(deferDelaySeconds("AWAITING_MEDIA_ANALYSIS", 0)).toBe(15);
    expect(deferDelaySeconds("AWAITING_MEDIA_ANALYSIS", 10 * 60_000)).toBe(120);
    // Nothing changes until an operator re-enables the platform.
    expect(deferDelaySeconds("CONTENT_PLATFORM_DISABLED", 0)).toBe(300);
    expect(deferDelaySeconds("CONTENT_PLATFORM_DISABLED", 60 * 60_000)).toBe(900);
  });

  test("never exceeds the SQS DelaySeconds ceiling", () => {
    const reasons = [
      "CONTENT_PLATFORM_DISABLED",
      "AWAITING_SECURITY_SCAN",
      "AWAITING_OCR",
      "AWAITING_MEDIA_ANALYSIS",
    ] as const;
    for (const reason of reasons) {
      for (const elapsed of [0, 1, 60_000, 3_600_000, Number.MAX_SAFE_INTEGER]) {
        const delay = deferDelaySeconds(reason, elapsed);
        expect(delay).toBeGreaterThanOrEqual(1);
        expect(delay).toBeLessThanOrEqual(900);
      }
    }
  });

  test("treats a corrupt or absent elapsed value as the start of the wait", () => {
    expect(deferDelaySeconds("AWAITING_OCR")).toBe(5);
    expect(deferDelaySeconds("AWAITING_OCR", Number.NaN)).toBe(5);
    expect(deferDelaySeconds("AWAITING_OCR", -1)).toBe(5);
  });

  test("measures elapsed wait only while the reason is unchanged", () => {
    const now = new Date("2026-07-22T12:02:00.000Z");
    const metrics = {
      waitReason: "AWAITING_SECURITY_SCAN" as const,
      waitStartedAt: "2026-07-22T12:00:00.000Z",
    };
    expect(elapsedWaitMs(metrics, "AWAITING_SECURITY_SCAN", now)).toBe(120_000);
    // Scan -> OCR is a NEW wait, so the cadence restarts at its shortest delay
    // rather than inheriting the previous reason's backoff.
    expect(elapsedWaitMs(metrics, "AWAITING_OCR", now)).toBe(0);
    expect(elapsedWaitMs({}, "AWAITING_OCR", now)).toBe(0);
    expect(
      elapsedWaitMs(
        { waitReason: "AWAITING_OCR", waitStartedAt: "not-a-date" },
        "AWAITING_OCR",
        now
      )
    ).toBe(0);
  });
});
