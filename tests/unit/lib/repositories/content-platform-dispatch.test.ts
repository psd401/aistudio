/** @jest-environment node */

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn((input: unknown) => ({ input })),
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
}));

import { SQSClient } from "@aws-sdk/client-sqs";
import { executeQuery } from "@/lib/db/drizzle-client";
import { dispatchContentProcessingJob } from "@/lib/repositories/content-platform/dispatch-service";

const mockExecuteQuery = jest.mocked(executeQuery);
const mockSqsSend = jest.mocked(SQSClient).mock.results[0]?.value.send as jest.Mock;

const message = {
  jobId: "11111111-2222-4333-8444-555555555555",
  itemVersionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};

describe("canonical processing dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONTENT_PROCESSING_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/content";
  });

  test("does not enqueue a replayed non-pending job", async () => {
    mockExecuteQuery.mockResolvedValueOnce([]);

    await dispatchContentProcessingJob(message);

    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  test("enqueues an eligible pending job and performs the guarded state update", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{ id: message.jobId }])
      .mockResolvedValueOnce([]);
    mockSqsSend.mockResolvedValueOnce({ MessageId: "message-1" });

    await dispatchContentProcessingJob(message);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });
});
