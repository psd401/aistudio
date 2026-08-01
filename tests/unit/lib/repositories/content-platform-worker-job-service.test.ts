/** @jest-environment node */

import { jest } from "@jest/globals";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  configureRepositoryProcessingFailureTransaction,
  isBdaInvocationExternallyActive,
  lockRepositoryProcessingMutationTarget,
  MAX_REPOSITORY_PUBLICATION_CONTENTION_REFUNDS,
  resetManagedServiceMetrics,
  resolveRepositoryProcessingAttemptRefund,
} from "@/lib/repositories/content-platform/worker-job-service";

const dialect = new PgDialect();

describe("repository processing failure lock timeout", () => {
  it("bounds the lock wait when recording a refundable contention", async () => {
    const execute = jest.fn<(query: SQL) => Promise<unknown>>(async () => []);

    await configureRepositoryProcessingFailureTransaction(
      { execute },
      {
        terminal: false,
        code: "REPOSITORY_PUBLICATION_CONTENTION",
        message: "lock wait expired",
        refundAttempt: true,
      }
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const compiled = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(compiled.sql).toContain("'lock_timeout'");
    expect(compiled.params).toEqual(["5000"]);
  });

  it("preserves the existing failure transaction policy otherwise", async () => {
    const execute = jest.fn<(query: SQL) => Promise<unknown>>(async () => []);

    await configureRepositoryProcessingFailureTransaction(
      { execute },
      {
        terminal: false,
        code: "TRANSIENT_PROCESSING_ERROR",
        message: "temporary outage",
      }
    );

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("repository processing attempt refunds", () => {
  it("refunds publication contention and increments its durable counter", () => {
    expect(
      resolveRepositoryProcessingAttemptRefund({
        activeBdaInvocation: false,
        attempt: 4,
        decision: {
          terminal: false,
          code: "REPOSITORY_PUBLICATION_CONTENTION",
          message: "lock wait expired",
          refundAttempt: true,
        },
        metrics: { provider: "unified-content", contentionRefunds: 3 },
      })
    ).toEqual({
      refundAttempt: true,
      attempt: 3,
      metrics: { provider: "unified-content", contentionRefunds: 4 },
    });
  });

  it("stops refunding publication contention at the cap", () => {
    const metrics = {
      provider: "unified-content",
      contentionRefunds: MAX_REPOSITORY_PUBLICATION_CONTENTION_REFUNDS,
    };
    expect(
      resolveRepositoryProcessingAttemptRefund({
        activeBdaInvocation: false,
        attempt: 1,
        decision: {
          terminal: false,
          code: "REPOSITORY_PUBLICATION_CONTENTION",
          message: "lock wait expired",
          refundAttempt: true,
        },
        metrics,
      })
    ).toEqual({ refundAttempt: false, metrics });
  });

  it("does not refund ordinary retryable failures", () => {
    const metrics = { provider: "unified-content" };
    expect(
      resolveRepositoryProcessingAttemptRefund({
        activeBdaInvocation: false,
        attempt: 2,
        decision: {
          terminal: false,
          code: "TRANSIENT_PROCESSING_ERROR",
          message: "temporary outage",
        },
        metrics,
      })
    ).toEqual({ refundAttempt: false, metrics });
  });
});

describe("unified-content worker managed-service recovery", () => {
  it("clears all Textract run identity and its wait clock", () => {
    expect(
      resetManagedServiceMetrics(
        {
          provider: "amazon-textract",
          textractJobId: "old-job",
          textractObjectKey: "repositories/7/old.pdf",
          waitReason: "AWAITING_OCR",
          waitStartedAt: "2026-07-22T12:00:00.000Z",
        },
        "textract"
      )
    ).toEqual({ provider: "amazon-textract" });
  });

  it("clears every BDA output pointer and derived metric before retry", () => {
    expect(
      resetManagedServiceMetrics(
        {
          provider: "bedrock-data-automation",
          bdaInvocationArn: "arn:old",
          bdaInvocationState: "terminal",
          bdaTerminalStatus: "ServiceError",
          bdaSourceObjectKey: "repositories/7/old.mp4",
          bdaOutputPrefix: "repositories/7/artifacts/old/",
          bdaResultObjectKey: "repositories/7/artifacts/old/result.json",
          waitReason: "AWAITING_MEDIA_ANALYSIS",
          waitStartedAt: "2026-07-22T12:00:00.000Z",
          waitDeadlineExceededAt: "2026-07-22T18:00:00.000Z",
          mediaDurationMs: 1_000,
          mediaFormat: "mp4",
          mediaCodec: "h264",
          mediaChannels: 2,
          frameRate: 30,
          frameWidth: 1280,
          frameHeight: 720,
          wordCount: 10,
          topicCount: 2,
          shotCount: 3,
          chapterCount: 1,
          speakerCount: 2,
        },
        "bedrock-data-automation"
      )
    ).toEqual({ provider: "bedrock-data-automation" });
  });

  it("fails closed for legacy/active BDA writers and releases terminal invocations", () => {
    expect(
      isBdaInvocationExternallyActive({ bdaInvocationArn: "arn:legacy" })
    ).toBe(true);
    expect(
      isBdaInvocationExternallyActive({
        bdaInvocationArn: "arn:active",
        bdaInvocationState: "active",
      })
    ).toBe(true);
    expect(
      isBdaInvocationExternallyActive({
        bdaInvocationArn: "arn:terminal",
        bdaInvocationState: "terminal",
        bdaTerminalStatus: "ClientError",
      })
    ).toBe(false);
  });

  it("locks security/failure mutations in repository-item-job-version order", async () => {
    const execute = jest.fn<(query: SQL) => Promise<unknown>>();
    execute
      .mockResolvedValueOnce([{ repository_id: 7, item_id: 11 }])
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ id: 11 }])
      .mockResolvedValueOnce([
        { id: "11111111-2222-4333-8444-555555555555" },
      ])
      .mockResolvedValueOnce([
        { id: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
      ]);

    await expect(
      lockRepositoryProcessingMutationTarget(
        { execute },
        {
          jobId: "11111111-2222-4333-8444-555555555555",
          itemVersionId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        }
      )
    ).resolves.toEqual({ repositoryId: 7, itemId: 11 });

    const statements = execute.mock.calls.map(([query]) =>
      dialect.sqlToQuery(query).sql
    );
    expect(statements[0]).not.toContain("FOR UPDATE");
    expect(statements[1]).toContain("FOR UPDATE OF repository");
    expect(statements[2]).toContain("FOR UPDATE OF item");
    expect(statements[3]).toContain("FOR UPDATE OF job");
    expect(statements[4]).toContain("FOR UPDATE OF version");
  });

  it("does not acquire lifecycle locks for a stale job/version pair", async () => {
    const execute = jest
      .fn<(query: SQL) => Promise<unknown>>()
      .mockResolvedValueOnce([]);

    await expect(
      lockRepositoryProcessingMutationTarget(
        { execute },
        {
          jobId: "11111111-2222-4333-8444-555555555555",
          itemVersionId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        }
      )
    ).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
