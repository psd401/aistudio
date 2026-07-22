import {
  classifyContentProcessingError,
  PermanentContentProcessingError,
  prepareDeferredProcessingMetrics,
  processingRetryDelaySeconds,
} from "../lifecycle";

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
});
