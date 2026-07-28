import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createLogger } from '@/lib/logger';

const sqsClient = new SQSClient({});
const log = createLogger({ service: 'lambda-trigger' });

// Dynamic environment variable loading for test compatibility
function getProcessingQueueUrl(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.PROCESSING_QUEUE_URL || 'test-processing-queue-url';
  }

  if (!process.env.PROCESSING_QUEUE_URL) {
    throw new Error('PROCESSING_QUEUE_URL environment variable not configured');
  }

  return process.env.PROCESSING_QUEUE_URL;
}

function getHighMemoryQueueUrl(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.HIGH_MEMORY_QUEUE_URL || 'test-high-memory-queue-url';
  }

  if (!process.env.HIGH_MEMORY_QUEUE_URL) {
    throw new Error('HIGH_MEMORY_QUEUE_URL environment variable not configured');
  }

  return process.env.HIGH_MEMORY_QUEUE_URL;
}

export interface ProcessingJobMessage {
  jobId: string;
  bucket: string;
  key: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  userId: string;
  processingOptions: {
    extractText: boolean;
    convertToMarkdown: boolean;
    extractImages: boolean;
    generateEmbeddings: boolean;
    ocrEnabled: boolean;
  };
}

export async function triggerLambdaProcessing(jobId: string, options?: { priority?: boolean }): Promise<void> {
  try {
    const queueUrl = getProcessingQueueUrl();

    // Send a priority message to trigger immediate processing
    const message = {
      type: 'PROCESS_DOCUMENT',
      jobId,
      timestamp: Date.now(),
      priority: options?.priority || false,
    };

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          jobId: {
            StringValue: jobId,
            DataType: 'String',
          },
          priority: {
            StringValue: options?.priority ? 'high' : 'normal',
            DataType: 'String',
          },
        },
      })
    );

    log.info('Triggered Lambda processing', { jobId, priority: options?.priority });
  } catch (error) {
    log.error('Failed to trigger Lambda processing', { error, jobId });
    throw new Error(`Failed to trigger processing: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
  }
}

export async function sendToProcessingQueue(message: ProcessingJobMessage): Promise<void> {
  try {
    const standardQueueUrl = getProcessingQueueUrl();

    // Determine which queue to use based on file size
    const queueUrl = message.fileSize > 50 * 1024 * 1024 // 50MB threshold
      ? getHighMemoryQueueUrl()
      : standardQueueUrl;

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          jobId: {
            StringValue: message.jobId,
            DataType: 'String',
          },
          fileSize: {
            StringValue: message.fileSize.toString(),
            DataType: 'Number',
          },
          fileType: {
            StringValue: message.fileType,
            DataType: 'String',
          },
          processorType: {
            StringValue: message.fileSize > 50 * 1024 * 1024 ? 'high-memory' : 'standard',
            DataType: 'String',
          },
        },
        // Delay processing slightly to allow for S3 consistency
        DelaySeconds: 2,
      })
    );

    log.info('Sent message to processing queue', {
      jobId: message.jobId,
      fileName: message.fileName,
      fileSize: message.fileSize,
      queueType: message.fileSize > 50 * 1024 * 1024 ? 'high-memory' : 'standard'
    });
  } catch (error) {
    log.error('Failed to send message to processing queue', { error, jobId: message.jobId });
    throw new Error(`Failed to queue processing: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
  }
}

export async function sendBatchToProcessingQueue(messages: ProcessingJobMessage[]): Promise<void> {
  if (messages.length === 0) return;

  try {
    // Just delegate to individual sendToProcessingQueue calls for simplicity
    await Promise.all(
      messages.map(message => sendToProcessingQueue(message))
    );

    log.info('Sent batch messages to processing queues', {
      totalMessages: messages.length,
    });
  } catch (error) {
    log.error('Failed to send batch messages to processing queue', {
      error,
      messageCount: messages.length
    });
    throw new Error(`Failed to queue batch processing: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
  }
}

export async function retryFailedJob(jobId: string, attempt: number = 1): Promise<void> {
  try {

    const retryMessage = {
      type: 'RETRY_PROCESSING',
      jobId,
      attempt,
      timestamp: Date.now(),
    };

    // Exponential backoff delay
    const delaySeconds = Math.min(2 ** attempt, 300); // Max 5 minutes

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: getProcessingQueueUrl(),
        MessageBody: JSON.stringify(retryMessage),
        DelaySeconds: delaySeconds,
        MessageAttributes: {
          jobId: {
            StringValue: jobId,
            DataType: 'String',
          },
          attempt: {
            StringValue: attempt.toString(),
            DataType: 'Number',
          },
          retryType: {
            StringValue: 'exponential-backoff',
            DataType: 'String',
          },
        },
      })
    );

    log.info('Queued job retry', { jobId, attempt, delaySeconds });
  } catch (error) {
    log.error('Failed to queue job retry', { error, jobId, attempt });
    throw new Error(`Failed to queue retry: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
  }
}