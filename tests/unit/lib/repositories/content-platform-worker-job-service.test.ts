/** @jest-environment node */

import { jest } from "@jest/globals";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  isBdaInvocationExternallyActive,
  lockRepositoryProcessingMutationTarget,
  resetManagedServiceMetrics,
} from "@/lib/repositories/content-platform/worker-job-service";

const dialect = new PgDialect();

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
