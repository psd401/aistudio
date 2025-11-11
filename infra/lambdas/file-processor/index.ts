import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand, SqlParameter } from '@aws-sdk/client-rds-data';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { TextractClient, StartDocumentAnalysisCommand, StartDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import { Readable } from 'stream';
import pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { parse as csvParse } from 'csv-parse/sync';
import { marked } from 'marked';
import { TextractUsageTracker } from './textract-usage';

const s3Client = new S3Client({});
const rdsClient = new RDSDataClient({});
const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});
const textractClient = new TextractClient({});

const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET_NAME!;
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE!;
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN!;
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const EMBEDDING_QUEUE_URL = process.env.EMBEDDING_QUEUE_URL;
const TEXTRACT_SNS_TOPIC_ARN = process.env.TEXTRACT_SNS_TOPIC_ARN;
const TEXTRACT_ROLE_ARN = process.env.TEXTRACT_ROLE_ARN;

// Helper function to create SQL parameters with proper types
function createSqlParameter(name: string, value: string | number | boolean | null): SqlParameter {
  if (value === null) {
    return { name, value: { isNull: true } };
  }
  if (typeof value === 'string') {
    return { name, value: { stringValue: value } };
  }
  if (typeof value === 'number') {
    return { name, value: { longValue: value } };
  }
  if (typeof value === 'boolean') {
    return { name, value: { booleanValue: value } };
  }
  throw new Error(`Unsupported parameter type for ${name}: ${typeof value}`);
}

interface ProcessingJob {
  jobId: string;
  itemId: number;
  fileKey: string;
  fileName: string;
  fileType: string;
  bucketName: string;
}

interface ChunkData {
  content: string;
  metadata: Record<string, any>;
  chunkIndex: number;
  tokens?: number;
}

// Update job status in DynamoDB
async function updateJobStatus(
  jobId: string,
  status: string,
  details?: any,
  error?: string
) {
  const timestamp = Date.now();
  const ttl = Math.floor(timestamp / 1000) + 86400 * 7; // 7 days TTL

  await dynamoClient.send(
    new PutItemCommand({
      TableName: JOB_STATUS_TABLE,
      Item: {
        jobId: { S: jobId },
        timestamp: { N: timestamp.toString() },
        status: { S: status },
        details: details ? { S: JSON.stringify(details) } : { NULL: true },
        error: error ? { S: error } : { NULL: true },
        ttl: { N: ttl.toString() },
      },
    })
  );
}

// Start Textract job for PDF OCR
async function startTextractJob(
  bucketName: string,
  fileKey: string,
  itemId: number,
  fileName: string,
  pageCount: number = 1
): Promise<string | null> {
  try {
    console.log(`Starting Textract job for ${fileName} (${pageCount} pages)`);
    
    // Check if we have free tier capacity
    const usageTracker = new TextractUsageTracker(
      DATABASE_RESOURCE_ARN,
      DATABASE_SECRET_ARN,
      DATABASE_NAME
    );
    
    const canProcess = await usageTracker.canProcessPages(pageCount);
    if (!canProcess) {
      const remaining = await usageTracker.getRemainingPages();
      console.warn(`Textract free tier limit would be exceeded. Remaining pages: ${remaining}`);
      throw new Error(`Cannot process ${pageCount} pages. Only ${remaining} pages remaining in free tier this month.`);
    }
    
    const params = {
      DocumentLocation: {
        S3Object: {
          Bucket: bucketName,
          Name: fileKey
        }
      }
    };

    // Add notification if SNS topic is configured
    if (TEXTRACT_SNS_TOPIC_ARN && TEXTRACT_ROLE_ARN) {
      (params as any).NotificationChannel = {
        RoleArn: TEXTRACT_ROLE_ARN,
        SNSTopicArn: TEXTRACT_SNS_TOPIC_ARN
      };
    }

    // Use StartDocumentTextDetection instead of StartDocumentAnalysis to save costs
    // Text detection is cheaper and sufficient for most PDFs
    const response = await textractClient.send(new StartDocumentTextDetectionCommand(params));
    
    if (response.JobId) {
      // Store job metadata for later processing
      await rdsClient.send(
        new ExecuteStatementCommand({
          resourceArn: DATABASE_RESOURCE_ARN,
          secretArn: DATABASE_SECRET_ARN,
          database: DATABASE_NAME,
          sql: `INSERT INTO textract_jobs (job_id, item_id, file_name, created_at)
                VALUES (:jobId, :itemId, :fileName, CURRENT_TIMESTAMP)`,
          parameters: [
            createSqlParameter('jobId', response.JobId),
            createSqlParameter('itemId', itemId),
            createSqlParameter('fileName', fileName)
          ]
        })
      );
      
      console.log(`Textract job started with ID: ${response.JobId}`);
      
      // Record usage
      await usageTracker.recordUsage(pageCount);
      
      return response.JobId;
    }
    
    return null;
  } catch (error) {
    console.error('Error starting Textract job:', error);
    return null;
  }
}

// Update repository item status in database
async function updateItemStatus(
  itemId: number,
  status: string,
  error?: string
) {
  const sql = error
    ? `UPDATE repository_items 
       SET processing_status = :status, 
           processing_error = :error,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :itemId`
    : `UPDATE repository_items 
       SET processing_status = :status,
           processing_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :itemId`;

  const parameters: SqlParameter[] = [
    createSqlParameter('itemId', itemId),
    createSqlParameter('status', status),
  ];

  if (error) {
    parameters.push(createSqlParameter('error', error));
  }

  await rdsClient.send(
    new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql,
      parameters,
    })
  );
}

// Stream to buffer converter
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Text extraction functions for different file types
interface PDFExtractionResult {
  text: string | null;
  pageCount: number;
}

async function extractTextFromPDF(buffer: Buffer): Promise<PDFExtractionResult> {
  try {
    console.log(`Attempting to parse PDF, buffer size: ${buffer.length} bytes`);
    
    // Try parsing the PDF
    const data = await pdfParse(buffer);
    console.log(`PDF parsed successfully, text length: ${data.text?.length || 0} characters`);
    console.log(`PDF info - pages: ${data.numpages}, version: ${data.version}`);
    
    const pageCount = data.numpages || 1;
    
    // If no text extracted, it might be a scanned PDF
    if (!data.text || data.text.trim().length === 0) {
      console.warn('No text found in PDF - it might be a scanned image PDF');
      // Return null to indicate OCR is needed
      return { text: null, pageCount };
    }
    
    // Also check if extracted text is suspiciously short for the number of pages
    const avgCharsPerPage = data.text.length / pageCount;
    if (avgCharsPerPage < 100 && pageCount > 1) {
      console.warn(`Suspiciously low text content: ${avgCharsPerPage} chars/page for ${pageCount} pages`);
      return { text: null, pageCount };
    }
    
    return { text: data.text, pageCount };
  } catch (error) {
    console.error('PDF parsing error:', error);
    // Try a more basic extraction as fallback
    try {
      const basicData = await pdfParse(buffer);
      if (basicData.text) {
        console.log('Basic extraction succeeded');
        return { text: basicData.text, pageCount: basicData.numpages || 1 };
      }
    } catch (fallbackError) {
      console.error('Fallback PDF parsing also failed:', fallbackError);
    }
    // Return null text to trigger OCR
    console.error(`Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { text: null, pageCount: 1 };
  }
}

async function extractTextFromDOCX(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractTextFromExcel(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer);
  let text = '';
  
  workbook.SheetNames.forEach((sheetName: string) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    text += `\n\n## Sheet: ${sheetName}\n${csv}`;
  });
  
  return text.trim();
}

async function extractTextFromCSV(buffer: Buffer): Promise<string> {
  const records = csvParse(buffer.toString(), {
    columns: true,
    skip_empty_lines: true,
  });
  
  return JSON.stringify(records, null, 2);
}

async function extractTextFromMarkdown(buffer: Buffer): Promise<string> {
  const markdown = buffer.toString();
  // Convert to plain text by removing markdown syntax
  const html = await marked.parse(markdown);
  // Simple HTML to text conversion
  return html.replace(/<[^>]*>/g, '').trim();
}

// Result type for text extraction
interface TextExtractionResult {
  text: string | null;
  pageCount?: number;
}

// Main text extraction dispatcher
async function extractText(buffer: Buffer, fileType: string): Promise<TextExtractionResult> {
  const lowerType = fileType.toLowerCase();
  
  if (lowerType.includes('pdf')) {
    return extractTextFromPDF(buffer);
  } else if (lowerType.includes('word') || lowerType.endsWith('.docx')) {
    const text = await extractTextFromDOCX(buffer);
    return { text };
  } else if (lowerType.includes('sheet') || lowerType.endsWith('.xlsx') || lowerType.endsWith('.xls')) {
    const text = await extractTextFromExcel(buffer);
    return { text };
  } else if (lowerType.endsWith('.csv')) {
    const text = await extractTextFromCSV(buffer);
    return { text };
  } else if (lowerType.endsWith('.md') || lowerType.includes('markdown')) {
    const text = await extractTextFromMarkdown(buffer);
    return { text };
  } else if (lowerType.endsWith('.txt') || lowerType.includes('text')) {
    return { text: buffer.toString() };
  } else {
    throw new Error(`Unsupported file type: ${fileType}`);
  }
}

// Intelligent text chunking
function chunkText(text: string, maxChunkSize: number = 2000): ChunkData[] {
  const chunks: ChunkData[] = [];
  const lines = text.split('\n');
  let currentChunk = '';
  const chunkIndex = 0;
  
  for (const line of lines) {
    if ((currentChunk + line).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { lineStart: chunkIndex },
        chunkIndex: chunks.length,
        tokens: Math.ceil(currentChunk.length / 4), // Rough token estimate
      });
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: { lineStart: chunkIndex },
      chunkIndex: chunks.length,
      tokens: Math.ceil(currentChunk.length / 4),
    });
  }
  
  return chunks;
}

// Store chunks in database and return chunk IDs
async function storeChunks(itemId: number, chunks: ChunkData[]): Promise<{ chunkIds: number[]; texts: string[] }> {
  if (chunks.length === 0) return { chunkIds: [], texts: [] };
  
  // First, delete existing chunks for this item
  await rdsClient.send(
    new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: 'DELETE FROM repository_item_chunks WHERE item_id = :itemId',
      parameters: [createSqlParameter('itemId', itemId)],
    })
  );
  
  const chunkIds: number[] = [];
  const texts: string[] = [];
  
  // Batch insert new chunks
  const parameterSets: SqlParameter[][] = chunks.map(chunk => [
    createSqlParameter('itemId', itemId),
    createSqlParameter('content', chunk.content),
    createSqlParameter('metadata', JSON.stringify(chunk.metadata)),
    createSqlParameter('chunkIndex', chunk.chunkIndex),
    createSqlParameter('tokens', chunk.tokens ?? null),
  ]);
  
  // BatchExecuteStatement has a limit of 25 parameter sets
  const batchSize = 25;
  for (let i = 0; i < parameterSets.length; i += batchSize) {
    const batch = parameterSets.slice(i, i + batchSize);
    const batchChunks = chunks.slice(i, i + batchSize);
    
    await rdsClient.send(
      new BatchExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO repository_item_chunks 
              (item_id, content, metadata, chunk_index, tokens)
              VALUES (:itemId, :content, :metadata::jsonb, :chunkIndex, :tokens)`,
        parameterSets: batch,
      })
    );
    
    // BatchExecuteStatement doesn't support RETURNING, so query for the IDs
    const chunkResult = await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `SELECT id, content FROM repository_item_chunks 
              WHERE item_id = :itemId 
              AND chunk_index >= :startIndex 
              AND chunk_index < :endIndex
              ORDER BY chunk_index`,
        parameters: [
          createSqlParameter('itemId', itemId),
          createSqlParameter('startIndex', i),
          createSqlParameter('endIndex', i + batch.length)
        ]
      })
    );
    
    if (chunkResult.records) {
      chunkResult.records.forEach(record => {
        if (record[0]?.longValue && record[1]?.stringValue) {
          chunkIds.push(record[0].longValue);
          texts.push(record[1].stringValue);
        }
      });
    }
  }
  
  return { chunkIds, texts };
}

// Process a single file
async function processFile(job: ProcessingJob) {
  console.log(`Processing file: ${job.fileName} (${job.fileType})`);
  
  try {
    // Update status to processing
    await updateItemStatus(job.itemId, 'processing');
    await updateJobStatus(job.jobId, 'processing', { fileName: job.fileName });
    
    // Download file from S3
    const getObjectCommand = new GetObjectCommand({
      Bucket: job.bucketName,
      Key: job.fileKey,
    });
    
    console.log(`Downloading from S3: ${job.bucketName}/${job.fileKey}`);
    const response = await s3Client.send(getObjectCommand);
    const stream = response.Body as Readable;
    const buffer = await streamToBuffer(stream);
    console.log(`Downloaded ${buffer.length} bytes from S3`);
    
    // Extract text
    const extractionResult = await extractText(buffer, job.fileType);
    const text = extractionResult.text;
    
    // Check if this is a PDF that needs OCR
    if (text === null && job.fileType.toLowerCase().includes('pdf')) {
      console.log('PDF needs OCR processing, starting Textract job...');
      
      // Use page count from extraction result
      const pageCount = extractionResult.pageCount || 1;
      
      const textractJobId = await startTextractJob(
        job.bucketName,
        job.fileKey,
        job.itemId,
        job.fileName,
        pageCount
      );
      
      if (textractJobId) {
        // Update status to indicate OCR processing
        await updateItemStatus(job.itemId, 'processing_ocr');
        await updateJobStatus(job.jobId, 'ocr_processing', { 
          fileName: job.fileName,
          textractJobId 
        });
        
        // Exit early - Textract will handle the rest via SNS
        console.log('File queued for OCR processing');
        return;
      } else {
        throw new Error('Failed to start Textract job for OCR processing');
      }
    }
    
    if (!text || text.trim().length === 0) {
      throw new Error('No text content extracted from file');
    }
    
    // Chunk text
    const chunks = chunkText(text);
    console.log(`Extracted ${chunks.length} chunks from ${job.fileName}`);
    
    // Store chunks and get their IDs
    const { chunkIds, texts } = await storeChunks(job.itemId, chunks);
    
    // Queue embeddings if enabled and chunks were created
    if (EMBEDDING_QUEUE_URL && chunkIds.length > 0) {
      try {
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: EMBEDDING_QUEUE_URL,
            MessageBody: JSON.stringify({
              itemId: job.itemId,
              chunkIds,
              texts
            })
          })
        );
        console.log(`Successfully queued ${chunkIds.length} chunks for embedding generation`);
        // Update status to indicate embeddings are being processed
        await updateItemStatus(job.itemId, 'processing_embeddings');
      } catch (error) {
        console.error('Failed to queue embeddings:', error);
        // Don't fail the whole job if embedding queueing fails
        await updateItemStatus(job.itemId, 'completed');
      }
    } else {
      // Update status to completed if no embedding queue configured
      await updateItemStatus(job.itemId, 'completed');
    }
    
    await updateJobStatus(job.jobId, 'completed', {
      fileName: job.fileName,
      chunksCreated: chunks.length,
      totalTokens: chunks.reduce((sum, chunk) => sum + (chunk.tokens || 0), 0),
    });
    
  } catch (error) {
    console.error(`Error processing file ${job.fileName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await updateItemStatus(job.itemId, 'failed', errorMessage);
    await updateJobStatus(job.jobId, 'failed', { fileName: job.fileName }, errorMessage);
    
    throw error; // Re-throw to let Lambda handle retry logic
  }
}

// Validate S3 key to prevent path traversal attacks
function validateS3Key(key: string): boolean {
  // Reject keys with path traversal patterns
  if (key.includes('../') || key.includes('..\\') || key.startsWith('/')) {
    return false;
  }
  
  // Accept two valid patterns:
  // 1. New format: repositories/{repoId}/{itemId}/{filename}
  // 2. Legacy format: {userId}/{timestamp}-{filename}
  const newFormatPattern = /^repositories\/\d+\/\d+\/[^/]+$/;
  const legacyFormatPattern = /^\d+\/\d+-[^/]+$/;
  
  return newFormatPattern.test(key) || legacyFormatPattern.test(key);
}

// Lambda handler
export async function handler(event: SQSEvent) {
  console.log('Received SQS event:', JSON.stringify(event, null, 2));
  
  for (const record of event.Records) {
    try {
      const job: ProcessingJob = JSON.parse(record.body);
      
      // Validate file key before processing
      if (!validateS3Key(job.fileKey)) {
        console.error(`Invalid S3 key detected: ${job.fileKey}`);
        throw new Error(`Invalid S3 key: ${job.fileKey}`);
      }
      
      await processFile(job);
    } catch (error) {
      console.error('Failed to process record:', error);
      // Let the error bubble up so SQS can retry or send to DLQ
      throw error;
    }
  }
}