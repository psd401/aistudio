import { SQSEvent, Context, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Readable } from 'stream';
import { DocumentProcessorFactory } from './processors/factory';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { createLambdaLogger } from './utils/lambda-logger';

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});

// Environment variables
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET_NAME!;
const DOCUMENT_JOBS_TABLE = process.env.DOCUMENT_JOBS_TABLE!;
const HIGH_MEMORY_QUEUE_URL = process.env.HIGH_MEMORY_QUEUE_URL;
const PROCESSOR_TYPE = process.env.PROCESSOR_TYPE || 'STANDARD'; // STANDARD or HIGH_MEMORY

interface ProcessingContext {
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

// Update job status in DynamoDB - preserving complete job data
async function updateJobStatus(
  jobId: string,
  status: string,
  updates: Record<string, any> = {},
  logger = createLambdaLogger({ operation: 'updateJobStatus' })
): Promise<void> {
  const timestamp = Date.now();
  const ttl = Math.floor(timestamp / 1000) + 86400 * 7; // 7 days TTL

  try {
    // First, get the complete job data from the latest entry
    const existingJobResponse = await dynamoClient.send(
      new QueryCommand({
        TableName: DOCUMENT_JOBS_TABLE,
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: marshall({
          ':jobId': jobId,
        }),
        ScanIndexForward: false, // Get latest first
        Limit: 1,
      })
    );

    if (!existingJobResponse.Items || existingJobResponse.Items.length === 0) {
      logger.error('No existing job found', { jobId });
      throw new Error(`Job not found: ${jobId}`);
    }

    // Get the existing job data and preserve all fields
    const existingJob = unmarshall(existingJobResponse.Items[0]);
    
    // Create new status entry with complete job data preserved
    await dynamoClient.send(
      new PutItemCommand({
        TableName: DOCUMENT_JOBS_TABLE,
        Item: marshall({
          // Preserve ALL existing job data
          ...existingJob,
          // Update the status and timestamp
          jobId,
          timestamp,
          status,
          ttl,
          // Apply any additional updates
          ...updates,
          // Add completion timestamp if completed
          ...(status === 'completed' && !updates.completedAt && {
            completedAt: new Date().toISOString(),
          }),
        }),
      })
    );
    
    logger.info('Job status updated successfully', { jobId, status, updates });
  } catch (error) {
    logger.error('Failed to update job status', error, { jobId, status });
    throw error;
  }
}

// Store processing results
async function storeResults(jobId: string, result: Record<string, any>): Promise<void> {
  const resultSize = JSON.stringify(result).length;
  
  if (resultSize > 400 * 1024) { // 400KB limit for DynamoDB
    // Store large results in S3
    const resultKey = `v2/results/${jobId}/result.json`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: resultKey,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
    }));
    
    await updateJobStatus(jobId, 'completed', {
      resultLocation: 's3',
      resultS3Key: resultKey,
      completedAt: new Date().toISOString(),
    });
  } else {
    // Store small results directly in DynamoDB
    await updateJobStatus(jobId, 'completed', {
      result,
      completedAt: new Date().toISOString(),
    });
  }
}

// Send to high-memory queue
async function sendToHighMemoryQueue(context: ProcessingContext): Promise<void> {
  if (!HIGH_MEMORY_QUEUE_URL) {
    throw new Error('HIGH_MEMORY_QUEUE_URL not configured');
  }
  
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: HIGH_MEMORY_QUEUE_URL,
    MessageBody: JSON.stringify(context),
  }));
  
  const logger = createLambdaLogger({ operation: 'sendToHighMemoryQueue', jobId: context.jobId });
  logger.info('Job sent to high-memory queue', { jobId: context.jobId, queueUrl: HIGH_MEMORY_QUEUE_URL });
}

// Failed documents are re-thrown from processDocument and reported by the handler via
// batchItemFailures (REV-INFRA-091); SQS then retries and redrives them to the
// configured DLQ (processingQueue.deadLetterQueue, maxReceiveCount) automatically, so
// the previous eager manual DLQ send is no longer needed.

// Stream to buffer converter
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Process a single document
async function processDocument(context: ProcessingContext): Promise<void> {
  const { jobId, bucket, key, fileName, fileSize, fileType, processingOptions } = context;
  const logger = createLambdaLogger({ 
    operation: 'processDocument', 
    jobId, 
    fileName, 
    fileType,
    processorType: PROCESSOR_TYPE
  });
  const timer = logger.startTimer('document-processing');
  
  logger.info('Starting document processing', { 
    fileName, 
    fileSize, 
    fileType, 
    bucket, 
    key, 
    processingOptions 
  });
  
  try {
    // Update status to processing
    await updateJobStatus(jobId, 'processing', { 
      processingStage: 'initializing',
      progress: 10,
      startTime: new Date().toISOString(),
    }, logger);
    
    // Check if this should be routed to high-memory processor
    if (PROCESSOR_TYPE === 'STANDARD' && fileSize > 50 * 1024 * 1024) {
      logger.info('Routing large file to high-memory processor', { 
        fileSize, 
        threshold: 50 * 1024 * 1024 
      });
      await sendToHighMemoryQueue(context);
      await updateJobStatus(jobId, 'processing', {
        processingStage: 'routing_to_high_memory',
        progress: 15,
      }, logger);
      return;
    }
    
    // Download file from S3
    await updateJobStatus(jobId, 'processing', {
      processingStage: 'downloading',
      progress: 20,
    }, logger);
    
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const response = await s3Client.send(getObjectCommand);
    const stream = response.Body as Readable;
    const buffer = await streamToBuffer(stream);
    
    logger.info('File downloaded from S3', { 
      downloadedBytes: buffer.length, 
      bucket, 
      key 
    });
    
    // Select and configure processor
    await updateJobStatus(jobId, 'processing', {
      processingStage: 'selecting_processor',
      progress: 30,
    }, logger);
    
    const processor = DocumentProcessorFactory.create(fileType, {
      enableOCR: processingOptions.ocrEnabled,
      convertToMarkdown: processingOptions.convertToMarkdown,
      extractImages: processingOptions.extractImages,
      generateEmbeddings: processingOptions.generateEmbeddings,
    }, buffer, fileName);
    
    // Process document with progress callbacks
    const result = await processor.process({
      buffer,
      fileName,
      fileType,
      jobId,
      options: processingOptions,
      onProgress: async (stage: string, progress: number) => {
        await updateJobStatus(jobId, 'processing', { 
          processingStage: stage, 
          progress: Math.max(30, Math.min(95, progress)) // Keep between 30-95%
        }, logger);
      },
    });
    
    // Store results
    await updateJobStatus(jobId, 'processing', {
      processingStage: 'storing_results',
      progress: 95,
    }, logger);
    
    await storeResults(jobId, result);
    
    timer();
    logger.info('Document processing completed successfully', { 
      fileName, 
      fileType,
      resultSize: JSON.stringify(result).length 
    });
    
  } catch (error) {
    timer();
    logger.error('Document processing failed', error, { fileName, fileType });
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await updateJobStatus(jobId, 'failed', {
      errorMessage,
      failedAt: new Date().toISOString(),
      processingStage: 'failed',
    }, logger);

    // Re-throw so the handler reports this record in batchItemFailures. SQS then
    // retries it (maxReceiveCount) and redrives it to the DLQ on exhaustion
    // (REV-INFRA-091). The previous eager sendToDLQ here fired on the FIRST failure,
    // DLQ-ing transient failures before SQS's retry budget was used.
    throw error;
  }
}

// A processing context paired with the SQS messageId it came from, so the handler
// can report per-record success/failure via the reportBatchItemFailures contract.
interface ProcessingItem {
  context: ProcessingContext;
  messageId: string;
}

interface ExtractedRecords {
  items: ProcessingItem[];
  // messageIds whose body failed JSON.parse — reported as batchItemFailures too, so
  // SQS retries/redrives them instead of deleting them as if they were processed
  // (REV-INFRA-097): a void/skip here previously left them out of batchItemFailures
  // entirely, and any record NOT in that list is treated by SQS as a success.
  parseFailureMessageIds: string[];
}

// Extract processing contexts from SQS events
function extractProcessingContexts(event: SQSEvent): ExtractedRecords {
  const items: ProcessingItem[] = [];
  const parseFailureMessageIds: string[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);

      // Handle both direct processing messages and S3 event notifications
      if (message.jobId) {
        // Direct processing message — keep its messageId for batchItemFailures.
        items.push({ context: message as ProcessingContext, messageId: record.messageId });
      } else if (message.Records && message.Records[0]?.s3) {
        // S3 event notification - skip since we use direct job processing
        const logger = createLambdaLogger({ operation: 'extractProcessingContexts' });
        logger.info('Received S3 event but skipping in favor of direct job processing', {
          eventType: 'S3',
          objectKey: message.Records[0].s3.object.key
        });
      }
    } catch (parseError) {
      // A malformed body cannot be fixed by processing logic, but it CAN be fixed by
      // a human (bad producer, truncated message, etc.) — report it as a batch item
      // failure so it stays on the queue for SQS retry / DLQ redrive rather than
      // being silently deleted as a false success (REV-INFRA-097).
      const logger = createLambdaLogger({ operation: 'extractProcessingContexts' });
      logger.error('Failed to parse SQS record', parseError, { messageId: record.messageId });
      parseFailureMessageIds.push(record.messageId);
    }
  }

  return { items, parseFailureMessageIds };
}

// Lambda handler
export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const logger = createLambdaLogger({
    operation: 'lambda-handler',
    requestId: context.awsRequestId,
    processorType: PROCESSOR_TYPE
  });

  logger.info('Lambda handler invoked', {
    recordCount: event.Records.length,
    processorType: PROCESSOR_TYPE,
    memoryLimit: context.memoryLimitInMB,
    remainingTime: context.getRemainingTimeInMillis()
  });

  const { items, parseFailureMessageIds } = extractProcessingContexts(event);

  // Parse failures are reported regardless of whether any record parsed successfully
  // (REV-INFRA-097) — they are independent of the items array below.
  const batchItemFailures: SQSBatchItemFailure[] = parseFailureMessageIds.map(
    (messageId) => ({ itemIdentifier: messageId })
  );

  if (items.length === 0) {
    logger.warn('No valid processing contexts found in event', {
      parseFailureCount: parseFailureMessageIds.length
    });
    return { batchItemFailures };
  }

  // Process documents concurrently (but limited by Lambda concurrency settings)
  const results = await Promise.allSettled(
    items.map(item => processDocument(item.context))
  );

  // Report per-record failures via the reportBatchItemFailures contract (REV-INFRA-091).
  // Both SQS event sources set reportBatchItemFailures: true, so returning the failed
  // records' itemIdentifiers keeps ONLY those messages on the queue for SQS retry and
  // DLQ redrive (maxReceiveCount reached) — the previous void return made Lambda treat
  // a partial-batch failure as a full success and silently delete the failed messages.
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      batchItemFailures.push({ itemIdentifier: items[index].messageId });
      logger.error('Document processing failed — record left on queue for retry', {
        jobId: items[index].context.jobId,
        messageId: items[index].messageId,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
    }
  });

  logger.info('Lambda execution completed', {
    successCount: results.length - (batchItemFailures.length - parseFailureMessageIds.length),
    failureCount: batchItemFailures.length,
    totalCount: results.length + parseFailureMessageIds.length
  });

  // An all-failed batch is naturally a subset of this: every itemIdentifier is
  // returned, so SQS retries the whole batch.
  return { batchItemFailures };
}