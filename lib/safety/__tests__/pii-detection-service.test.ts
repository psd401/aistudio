const send = jest.fn();

jest.mock("@aws-sdk/client-comprehend", () => ({
  ComprehendClient: jest.fn(() => ({ send })),
  DetectPiiEntitiesCommand: class {
    constructor(readonly input: { Text: string; LanguageCode: string }) {}
  },
}));

import { DetectPiiEntitiesCommand } from "@aws-sdk/client-comprehend";
import {
  PIIDetectionService,
  PIIDetectionUnavailableError,
} from "../pii-detection-service";

describe("PIIDetectionService", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("uses DetectPiiEntities and retains relevant high-confidence K-12 PII", async () => {
    send.mockResolvedValue({
      Entities: [
        { Type: "NAME", BeginOffset: 0, EndOffset: 12, Score: 0.999 },
        { Type: "USERNAME", BeginOffset: 16, EndOffset: 20, Score: 0.999 },
        { Type: "DATE_TIME", BeginOffset: 24, EndOffset: 30, Score: 0.91 },
      ],
    });
    const service = new PIIDetectionService({ region: "us-west-2" });

    await expect(service.detectPII("Johnny Smith is user 8.11.2")).resolves.toEqual([
      { type: "NAME", beginOffset: 0, endOffset: 12, score: 0.999 },
    ]);
    expect(send).toHaveBeenCalledWith(expect.any(DetectPiiEntitiesCommand));
  });

  it("detects district student IDs and gives custom patterns precedence", async () => {
    send.mockResolvedValue({
      Entities: [
        { Type: "DATE_TIME", BeginOffset: 11, EndOffset: 18, Score: 0.999 },
      ],
    });
    const service = new PIIDetectionService({ region: "us-west-2" });

    await expect(service.detectPII("Student ID 2240393")).resolves.toEqual([
      { type: "STUDENT_ID", beginOffset: 11, endOffset: 18, score: 1 },
    ]);
  });

  it("propagates Comprehend errors for fail-closed consumers", async () => {
    send.mockRejectedValue(new Error("Comprehend unavailable"));
    const service = new PIIDetectionService({ region: "us-west-2" });

    await expect(service.detectPII("Johnny Smith")).rejects.toThrow(
      "Comprehend unavailable",
    );
  });

  it("is explicitly unavailable without an AWS region", async () => {
    const previousRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    const service = new PIIDetectionService();
    if (previousRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previousRegion;

    await expect(service.detectPII("Johnny Smith")).rejects.toBeInstanceOf(
      PIIDetectionUnavailableError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
