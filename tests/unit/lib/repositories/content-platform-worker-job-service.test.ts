/** @jest-environment node */

import { resetManagedServiceMetrics } from "@/lib/repositories/content-platform/worker-job-service";

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
          bdaSourceObjectKey: "repositories/7/old.mp4",
          bdaOutputPrefix: "repositories/7/artifacts/old/",
          bdaResultObjectKey: "repositories/7/artifacts/old/result.json",
          waitReason: "AWAITING_MEDIA_ANALYSIS",
          waitStartedAt: "2026-07-22T12:00:00.000Z",
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
});
