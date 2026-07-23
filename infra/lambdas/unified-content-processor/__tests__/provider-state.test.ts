import {
  attachBdaInvocation,
  attachTextractJob,
  buildManagedServiceClientToken,
  markBdaInvocationTerminal,
  reconcileBdaState,
  reconcileTextractState,
} from "../provider-state";

describe("unified content managed-service state", () => {
  test("resumes Textract only for the exact immutable artifact", () => {
    const state = reconcileTextractState(
      {
        textractJobId: "textract-current",
        textractObjectKey:
          "repositories/7/artifacts/version/image-normalize-v2/ocr-source.jpg",
        waitReason: "AWAITING_OCR",
        waitStartedAt: "2026-07-22T12:00:00.000Z",
      },
      "repositories/7/artifacts/version/image-normalize-v2/ocr-source.jpg"
    );

    expect(state).toMatchObject({
      jobId: "textract-current",
      reset: false,
      metrics: {
        textractJobId: "textract-current",
        textractObjectKey:
          "repositories/7/artifacts/version/image-normalize-v2/ocr-source.jpg",
        waitReason: "AWAITING_OCR",
        waitStartedAt: "2026-07-22T12:00:00.000Z",
      },
    });
  });

  test("drops v1 Textract state and its wait deadline after an artifact-version change", () => {
    const original = {
      provider: "amazon-bedrock",
      textractJobId: "textract-v1",
      textractObjectKey:
        "repositories/7/artifacts/version/image-normalize-v1/ocr-source.jpg",
      waitReason: "AWAITING_OCR" as const,
      waitStartedAt: "2026-07-22T12:00:00.000Z",
    };

    expect(
      reconcileTextractState(
        original,
        "repositories/7/artifacts/version/image-normalize-v2/ocr-source.jpg"
      )
    ).toEqual({
      metrics: { provider: "amazon-bedrock" },
      jobId: null,
      reset: true,
    });
    expect(original.textractJobId).toBe("textract-v1");
  });

  test("does not trust legacy PDF Textract state without its source key", () => {
    expect(
      reconcileTextractState(
        {
          textractJobId: "legacy-pdf-job",
          waitReason: "AWAITING_OCR",
        },
        "repositories/7/upload/reference.pdf"
      )
    ).toEqual({ metrics: {}, jobId: null, reset: true });
  });

  test("records the immutable artifact with every newly started Textract job", () => {
    expect(
      attachTextractJob(
        { provider: "amazon-textract" },
        "repositories/7/upload/reference.pdf",
        "textract-new"
      )
    ).toEqual({
      provider: "amazon-textract",
      textractObjectKey: "repositories/7/upload/reference.pdf",
      textractJobId: "textract-new",
    });
  });

  test("keeps provider calls idempotent within a run and refreshes tokens for retries or new artifacts", () => {
    const firstRun = new Date("2026-07-22T12:00:00.000Z");
    const retryRun = new Date("2026-07-22T13:00:00.000Z");
    const source = "repositories/7/version/reference.pdf";
    const first = buildManagedServiceClientToken(
      "textract",
      "11111111-2222-4333-8444-555555555555",
      firstRun,
      source
    );

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      buildManagedServiceClientToken(
        "textract",
        "11111111-2222-4333-8444-555555555555",
        firstRun,
        source
      )
    ).toBe(first);
    expect(
      buildManagedServiceClientToken(
        "textract",
        "11111111-2222-4333-8444-555555555555",
        retryRun,
        source
      )
    ).not.toBe(first);
    expect(
      buildManagedServiceClientToken(
        "textract",
        "11111111-2222-4333-8444-555555555555",
        firstRun,
        `${source}.normalized`
      )
    ).not.toBe(first);
  });

  test("isolates BDA output by processing run and rejects stale invocation state", () => {
    const base = "repositories/7/artifacts/version/bda/";
    const source = "repositories/7/version/reference.mp4";
    const first = reconcileBdaState({}, source, base, "token-one");
    expect(first).toEqual({
      metrics: {},
      invocationArn: null,
      outputPrefix: `${base}runs/token-one/`,
      reset: false,
    });

    const attached = attachBdaInvocation(
      first.metrics,
      source,
      first.outputPrefix,
      "arn:aws:bedrock:invocation/one"
    );
    expect(attached.bdaInvocationState).toBe("active");
    expect(reconcileBdaState(attached, source, base, "token-one")).toEqual({
      metrics: attached,
      invocationArn: "arn:aws:bedrock:invocation/one",
      outputPrefix: `${base}runs/token-one/`,
      reset: false,
    });
    expect(
      markBdaInvocationTerminal(
        attached,
        "arn:aws:bedrock:invocation/one",
        "Success"
      )
    ).toMatchObject({
      bdaInvocationArn: "arn:aws:bedrock:invocation/one",
      bdaInvocationState: "terminal",
      bdaTerminalStatus: "Success",
    });

    expect(
      reconcileBdaState(
        {
          ...attached,
          waitReason: "AWAITING_MEDIA_ANALYSIS",
          waitStartedAt: "2026-07-22T12:00:00.000Z",
        },
        source,
        base,
        "token-two"
      )
    ).toEqual({
      metrics: {},
      invocationArn: null,
      outputPrefix: `${base}runs/token-two/`,
      reset: true,
    });
  });

  test("drops BDA state when the immutable source object changes", () => {
    expect(
      reconcileBdaState(
        {
          bdaInvocationArn: "arn:aws:bedrock:invocation/old-source",
          bdaSourceObjectKey: "repositories/7/version/old.mp4",
          bdaOutputPrefix: "repositories/7/artifacts/version/bda/runs/token/",
          bdaResultObjectKey:
            "repositories/7/artifacts/version/bda/runs/token/result.json",
          waitReason: "AWAITING_MEDIA_ANALYSIS",
          waitStartedAt: "2026-07-22T12:00:00.000Z",
        },
        "repositories/7/version/new.mp4",
        "repositories/7/artifacts/version/bda/",
        "token"
      )
    ).toEqual({
      metrics: {},
      invocationArn: null,
      outputPrefix: "repositories/7/artifacts/version/bda/runs/token/",
      reset: true,
    });
  });
});
