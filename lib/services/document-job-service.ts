import { DynamoDBClient, PutItemCommand, QueryCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { createLogger, generateRequestId } from '@/lib/logger';
import { generateUUID } from '@/lib/utils/uuid';
import { UploadClassifiedError } from '@/lib/errors/upload-errors';

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
  maxAttempts: 3,
});
const log = createLogger({ service: 'document-job-service' });

// Dynamic environment variable loading for test compatibility
function getDocumentJobsTable(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DOCUMENT_JOBS_TABLE || 'test-document-jobs-table';
  }
  
  const tableName = process.env.DOCUMENT_JOBS_TABLE;
  if (!tableName) {
    const availableVars = Object.keys(process.env).filter(k => k.includes('TABLE')).join(', ');
    log.error('DOCUMENT_JOBS_TABLE not configured', { availableVars });
    throw new UploadClassifiedError(
      'CONFIG_ERROR',
      'Document processing service is misconfigured',
      500
    );
  }
  
  return tableName;
}

export interface ProcessingOptions {
  extractText: boolean;
  convertToMarkdown: boolean;
  extractImages: boolean;
  generateEmbeddings: boolean;
  ocrEnabled: boolean;
}

export interface DocumentJob {
  id: string;
  userId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  purpose: 'chat' | 'repository' | 'assistant';
  processingOptions: ProcessingOptions;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  processingStage?: string;
  result?: Record<string, unknown>;
  resultLocation?: 's3' | 'dynamodb';
  resultS3Key?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreateJobParams {
  fileName: string;
  fileSize: number;
  fileType: string;
  purpose: 'chat' | 'repository' | 'assistant';
  userId: string;
  processingOptions: ProcessingOptions;
}

export async function createDocumentJob(params: CreateJobParams): Promise<DocumentJob> {
  const requestId = generateRequestId();
  const jobLog = createLogger({ action: 'createDocumentJob', requestId });
  
  try {
    // Step 1: Validate environment and configuration
    const tableName = getDocumentJobsTable();
    jobLog.info('Creating document job', { 
      tableName, 
      hasTableName: !!tableName,
      region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION,
      environment: process.env.NODE_ENV,
      fileSize: params.fileSize,
      fileType: params.fileType,
      purpose: params.purpose,
      userId: params.userId.substring(0, 8) + '...', // Log only first 8 chars of user ID
      fileName: params.fileName ? params.fileName.substring(0, 50) + (params.fileName.length > 50 ? '...' : '') : undefined,
      hasProcessingOptions: !!params.processingOptions
    });

    // Step 2: Generate job ID
    const jobId = generateUUID();
    jobLog.info('Generated job ID', { jobId });

    const timestamp = Date.now();
    const ttl = Math.floor(timestamp / 1000) + 86400 * 7; // 7 days TTL

    const job: DocumentJob = {
      id: jobId,
      userId: params.userId,
      fileName: params.fileName,
      fileSize: params.fileSize,
      fileType: params.fileType,
      purpose: params.purpose,
      processingOptions: params.processingOptions,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Step 3: Prepare data for DynamoDB
    const itemData = {
      jobId,
      timestamp,
      userId: params.userId,
      fileName: params.fileName,
      fileSize: params.fileSize,
      fileType: params.fileType,
      purpose: params.purpose,
      processingOptions: params.processingOptions,
      status: 'pending',
      createdAt: job.createdAt,
      ttl,
    };
    
    const marshalled = marshall(itemData);
    jobLog.info('Prepared DynamoDB item', { 
      itemKeys: Object.keys(marshalled),
      itemSize: JSON.stringify(itemData).length 
    });

    // Step 4: Write to DynamoDB
    jobLog.info('Sending PutItem command to DynamoDB');
    await dynamoClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshalled,
        ConditionExpression: 'attribute_not_exists(jobId)', // Prevent duplicates
      })
    );

    jobLog.info('Document job created successfully', { jobId, fileName: params.fileName, userId: params.userId });
    return job;
  } catch (error) {
    // CRITICAL: Log the actual error details
    const errorDetails = {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error || 'No message'),
      code: 'Code' in (error as object) ? (error as { Code?: string }).Code : undefined,
      httpStatusCode: '$metadata' in (error as object) ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined,
      requestId: '$metadata' in (error as object) ? (error as { $metadata?: { requestId?: string } }).$metadata?.requestId : undefined,
      stack: error instanceof Error ? error.stack : undefined,
      totalRetryDelay: '$metadata' in (error as object) ? (error as { $metadata?: { totalRetryDelay?: number } }).$metadata?.totalRetryDelay : undefined
    };
    
    jobLog.error('Failed to create document job', { 
      error: errorDetails,
      fileSize: params.fileSize,
      fileType: params.fileType,
      purpose: params.purpose,
      fileName: params.fileName ? params.fileName.substring(0, 50) + (params.fileName.length > 50 ? '...' : '') : undefined,
      requestId
    });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      // Re-throw AWS SDK errors to preserve their structure
      throw error;
    }
    // Fallback for non-AWS errors
    throw new Error(`Failed to create document job: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getJobStatus(jobId: string, userId?: string): Promise<DocumentJob | null> {
  try {
    // Query for the latest status entry for this job
    const response = await dynamoClient.send(
      new QueryCommand({
        TableName: getDocumentJobsTable(),
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: marshall({
          ':jobId': jobId,
          ...(userId && { ':userId': userId }),
        }),
        // Add filter expression if userId is provided for security
        ...(userId && {
          FilterExpression: 'userId = :userId',
        }),
        ScanIndexForward: false, // Get latest entries first
        Limit: 1,
      })
    );

    if (!response.Items || response.Items.length === 0) {
      return null;
    }

    const item = unmarshall(response.Items[0]);
    
    return {
      id: item.jobId,
      userId: item.userId,
      fileName: item.fileName,
      fileSize: item.fileSize,
      fileType: item.fileType,
      purpose: item.purpose,
      processingOptions: item.processingOptions,
      status: item.status,
      progress: item.progress,
      processingStage: item.processingStage,
      result: item.result,
      resultLocation: item.resultLocation,
      resultS3Key: item.resultS3Key,
      errorMessage: item.errorMessage,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
    };
  } catch (error) {
    log.error('Failed to get job status', { error, jobId, userId });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to get job status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function updateJobStatus(
  jobId: string,
  status: DocumentJob['status'],
  updates: Partial<Pick<DocumentJob, 'progress' | 'processingStage' | 'result' | 'resultLocation' | 'resultS3Key' | 'errorMessage' | 'completedAt'>> = {}
): Promise<void> {
  const timestamp = Date.now();
  const ttl = Math.floor(timestamp / 1000) + 86400 * 7; // 7 days TTL

  try {
    // First, get the complete job data from the latest entry
    const existingJobResponse = await dynamoClient.send(
      new QueryCommand({
        TableName: getDocumentJobsTable(),
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: marshall({
          ':jobId': jobId,
        }),
        ScanIndexForward: false, // Get latest first
        Limit: 1,
      })
    );

    if (!existingJobResponse.Items || existingJobResponse.Items.length === 0) {
      log.error(`No existing job found for jobId: ${jobId}`);
      throw new Error(`Job not found: ${jobId}`);
    }

    // Get the existing job data and preserve all fields
    const existingJob = unmarshall(existingJobResponse.Items[0]);
    
    // Insert a new status entry (append-only pattern for DynamoDB) with complete job data preserved
    await dynamoClient.send(
      new PutItemCommand({
        TableName: getDocumentJobsTable(),
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

    log.info('Job status updated with complete data', { jobId, status, updates });
  } catch (error) {
    log.error('Failed to update job status', { error, jobId, status, updates });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to update job status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function confirmDocumentUpload(jobId: string, uploadId: string): Promise<void> {
  try {
    await updateJobStatus(jobId, 'processing', {
      processingStage: 'upload_confirmed',
      progress: 10,
    });

    log.info('Document upload confirmed', { jobId, uploadId });
  } catch (error) {
    log.error('Failed to confirm document upload', { error, jobId, uploadId });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to confirm upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getUserJobs(
  userId: string,
  limit: number = 20,
  lastEvaluatedKey?: Record<string, AttributeValue>
): Promise<{ jobs: DocumentJob[]; lastEvaluatedKey?: Record<string, AttributeValue> }> {
  try {
    const response = await dynamoClient.send(
      new QueryCommand({
        TableName: getDocumentJobsTable(),
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: marshall({
          ':userId': userId,
        }),
        ScanIndexForward: false, // Get newest first
        Limit: limit,
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const jobs = (response.Items || []).map(item => {
      const unmarshalled = unmarshall(item);
      return {
        id: unmarshalled.jobId,
        userId: unmarshalled.userId,
        fileName: unmarshalled.fileName,
        fileSize: unmarshalled.fileSize,
        fileType: unmarshalled.fileType,
        purpose: unmarshalled.purpose,
        processingOptions: unmarshalled.processingOptions,
        status: unmarshalled.status,
        progress: unmarshalled.progress,
        processingStage: unmarshalled.processingStage,
        result: unmarshalled.result,
        resultLocation: unmarshalled.resultLocation,
        resultS3Key: unmarshalled.resultS3Key,
        errorMessage: unmarshalled.errorMessage,
        createdAt: unmarshalled.createdAt,
        completedAt: unmarshalled.completedAt,
      } as DocumentJob;
    });

    return {
      jobs,
      lastEvaluatedKey: response.LastEvaluatedKey,
    };
  } catch (error) {
    log.error('Failed to get user jobs', { error, userId });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to get user jobs: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getJobsByStatus(
  status: DocumentJob['status'],
  limit: number = 50
): Promise<DocumentJob[]> {
  try {
    const response = await dynamoClient.send(
      new QueryCommand({
        TableName: getDocumentJobsTable(),
        IndexName: 'StatusIndex',
        KeyConditionExpression: 'status = :status',
        ExpressionAttributeValues: marshall({
          ':status': status,
        }),
        ScanIndexForward: false, // Get newest first
        Limit: limit,
      })
    );

    return (response.Items || []).map(item => {
      const unmarshalled = unmarshall(item);
      return {
        id: unmarshalled.jobId,
        userId: unmarshalled.userId,
        fileName: unmarshalled.fileName,
        fileSize: unmarshalled.fileSize,
        fileType: unmarshalled.fileType,
        purpose: unmarshalled.purpose,
        processingOptions: unmarshalled.processingOptions,
        status: unmarshalled.status,
        progress: unmarshalled.progress,
        processingStage: unmarshalled.processingStage,
        result: unmarshalled.result,
        resultLocation: unmarshalled.resultLocation,
        resultS3Key: unmarshalled.resultS3Key,
        errorMessage: unmarshalled.errorMessage,
        createdAt: unmarshalled.createdAt,
        completedAt: unmarshalled.completedAt,
      } as DocumentJob;
    });
  } catch (error) {
    log.error('Failed to get jobs by status', { error, status });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to get jobs by status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Helper function to fetch result from S3 if stored there
export async function fetchResultFromS3(s3Key: string): Promise<Record<string, unknown>> {
  try {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({});
    
    const bucketName = process.env.DOCUMENTS_BUCKET_NAME;
    if (!bucketName) {
      throw new Error('DOCUMENTS_BUCKET_NAME environment variable not set');
    }

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      })
    );

    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    const bodyText = await response.Body.transformToString();
    return JSON.parse(bodyText);
  } catch (error) {
    log.error('Failed to fetch result from S3', { error, s3Key });
    // Preserve AWS error context for better debugging
    if (error && typeof error === 'object' && 'name' in error && error.name) {
      throw error;
    }
    throw new Error(`Failed to fetch result from S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}