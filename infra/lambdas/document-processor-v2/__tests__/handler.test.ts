/**
 * Unit tests for the SQS handler's reportBatchItemFailures contract (REV-INFRA-091).
 *
 * A mixed batch (some documents succeed, some reject) must return
 * { batchItemFailures: [...] } listing exactly the failed records' itemIdentifiers,
 * so SQS keeps only those messages for retry / DLQ redrive instead of deleting them.
 */

import { marshall } from '@aws-sdk/util-dynamodb';
import { Readable } from 'stream';

// DynamoDB: Query returns a job row (so updateJobStatus doesn't 404); Put resolves.
const dynamoSend = jest.fn((command: any) => {
  if (command?.input?.KeyConditionExpression) {
    return Promise.resolve({ Items: [marshall({ jobId: 'j', fileName: 'f' })] });
  }
  return Promise.resolve({});
});
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: dynamoSend })),
  QueryCommand: class { constructor(public input: any) {} },
  PutItemCommand: class { constructor(public input: any) {} },
}));

// S3: GetObject returns a small stream body.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn(() => Promise.resolve({ Body: Readable.from([Buffer.from('data')]) })) })),
  GetObjectCommand: class { constructor(public input: any) {} },
  PutObjectCommand: class { constructor(public input: any) {} },
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn(() => Promise.resolve({})) })),
  SendMessageCommand: class { constructor(public input: any) {} },
}));

// Factory: the processor rejects for a file named FAIL.txt, resolves otherwise.
jest.mock('../processors/factory', () => ({
  DocumentProcessorFactory: {
    create: (_type: string, _config: unknown, _buf: Buffer, fileName: string) => ({
      process: async () => {
        if (fileName === 'FAIL.txt') throw new Error('processor boom');
        return { text: 'ok', metadata: {} };
      },
    }),
  },
}));

import { handler } from '../index';

function record(jobId: string, fileName: string, messageId: string) {
  return {
    messageId,
    body: JSON.stringify({
      jobId, bucket: 'b', key: `k/${fileName}`, fileName, fileSize: 10, fileType: 'text/plain',
      userId: 'u',
      processingOptions: { extractText: true, convertToMarkdown: false, extractImages: false, generateEmbeddings: false, ocrEnabled: false },
    }),
  };
}

const ctx = { awsRequestId: 'req', memoryLimitInMB: '512', getRemainingTimeInMillis: () => 60000 } as any;

describe('handler reportBatchItemFailures (REV-INFRA-091)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only the failed record itemIdentifiers for a mixed batch', async () => {
    const event = {
      Records: [
        record('j1', 'ok1.txt', 'm1'),
        record('j2', 'FAIL.txt', 'm2'),
        record('j3', 'ok2.txt', 'm3'),
      ],
    } as any;

    const result = await handler(event, ctx);

    expect(result).toBeDefined();
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });

  it('returns an empty batchItemFailures when all succeed', async () => {
    const event = { Records: [record('j1', 'ok.txt', 'm1')] } as any;
    const result = await handler(event, ctx);
    expect(result.batchItemFailures).toEqual([]);
  });

  it('returns every itemIdentifier when the whole batch fails', async () => {
    const event = { Records: [record('j1', 'FAIL.txt', 'm1'), record('j2', 'FAIL.txt', 'm2')] } as any;
    const result = await handler(event, ctx);
    expect(result.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['m1', 'm2']);
  });
});
