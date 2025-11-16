import { SNSEvent } from 'aws-lambda';
import { TextractClient, GetDocumentAnalysisCommand, GetDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand, SqlParameter } from '@aws-sdk/client-rds-data';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const textractClient = new TextractClient({});
const rdsClient = new RDSDataClient({});
const sqsClient = new SQSClient({});

const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN!;
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const EMBEDDING_QUEUE_URL = process.env.EMBEDDING_QUEUE_URL;

interface TextractMessage {
  JobId: string;
  Status: string;
  DocumentLocation: {
    S3ObjectName: string;
    S3Bucket: string;
  };
  Timestamp: number;
  API: string;
}

interface JobMetadata {
  itemId: number;
  fileName: string;
}

// Helper function to create SQL parameters
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

// Get job metadata from DynamoDB or RDS
async function getJobMetadata(jobId: string): Promise<JobMetadata | null> {
  try {
    const sql = `
      SELECT item_id, file_name 
      FROM textract_jobs 
      WHERE job_id = :jobId
    `;
    
    const result = await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql,
        parameters: [createSqlParameter('jobId', jobId)]
      })
    );
    
    if (result.records && result.records.length > 0) {
      const record = result.records[0];
      return {
        itemId: record[0]?.longValue || 0,
        fileName: record[1]?.stringValue || ''
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error getting job metadata:', error);
    return null;
  }
}

// Get document text from Textract
async function getDocumentText(jobId: string, useAnalysis: boolean = true): Promise<string> {
  let nextToken: string | undefined;
  let fullText = '';
  
  do {
    try {
      let response;
      
      if (useAnalysis) {
        response = await textractClient.send(
          new GetDocumentAnalysisCommand({
            JobId: jobId,
            NextToken: nextToken
          })
        );
      } else {
        response = await textractClient.send(
          new GetDocumentTextDetectionCommand({
            JobId: jobId,
            NextToken: nextToken
          })
        );
      }
      
      // Extract text from blocks
      if (response.Blocks) {
        for (const block of response.Blocks) {
          if (block.BlockType === 'LINE' && block.Text) {
            fullText += block.Text + '\n';
          }
        }
      }
      
      nextToken = response.NextToken;
    } catch (error) {
      console.error('Error getting document text:', error);
      break;
    }
  } while (nextToken);
  
  return fullText.trim();
}

// Chunk text (same as file-processor)
function chunkText(text: string, maxChunkSize: number = 2000): Array<{
  content: string;
  metadata: Record<string, any>;
  chunkIndex: number;
  tokens?: number;
}> {
  const chunks: Array<{
    content: string;
    metadata: Record<string, any>;
    chunkIndex: number;
    tokens?: number;
  }> = [];
  
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

// Store chunks and queue for embeddings (similar to file-processor)
async function storeAndQueueChunks(itemId: number, chunks: any[]): Promise<void> {
  if (chunks.length === 0) return;
  
  // First, delete existing chunks
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
  
  const batchSize = 25;
  for (let i = 0; i < parameterSets.length; i += batchSize) {
    const batch = parameterSets.slice(i, i + batchSize);
    
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
    
    // Query for the inserted IDs
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
  
  // Queue for embeddings if configured
  if (EMBEDDING_QUEUE_URL && chunkIds.length > 0) {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: EMBEDDING_QUEUE_URL,
        MessageBody: JSON.stringify({
          itemId,
          chunkIds,
          texts
        })
      })
    );
    
    // Update status
    await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `UPDATE repository_items 
              SET processing_status = 'processing_embeddings',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = :itemId`,
        parameters: [createSqlParameter('itemId', itemId)]
      })
    );
  } else {
    // Update status to completed
    await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `UPDATE repository_items 
              SET processing_status = 'completed',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = :itemId`,
        parameters: [createSqlParameter('itemId', itemId)]
      })
    );
  }
}

// Lambda handler
export async function handler(event: SNSEvent) {
  console.log('Textract completion event:', JSON.stringify(event, null, 2));
  
  for (const record of event.Records) {
    try {
      const message: TextractMessage = JSON.parse(record.Sns.Message);
      const { JobId, Status, DocumentLocation, API } = message;
      
      console.log(`Processing Textract job: ${JobId}, Status: ${Status}, API: ${API}`);
      
      if (Status === 'SUCCEEDED') {
        // Get job metadata
        const metadata = await getJobMetadata(JobId);
        if (!metadata) {
          console.error(`No metadata found for job ${JobId}`);
          continue;
        }
        
        // Get extracted text
        const useAnalysis = API === 'StartDocumentAnalysis';
        const extractedText = await getDocumentText(JobId, useAnalysis);
        
        if (!extractedText || extractedText.trim().length === 0) {
          console.error('No text extracted from document');
          await rdsClient.send(
            new ExecuteStatementCommand({
              resourceArn: DATABASE_RESOURCE_ARN,
              secretArn: DATABASE_SECRET_ARN,
              database: DATABASE_NAME,
              sql: `UPDATE repository_items 
                    SET processing_status = 'failed',
                        processing_error = 'No text extracted from document by Textract',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :itemId`,
              parameters: [createSqlParameter('itemId', metadata.itemId)]
            })
          );
          continue;
        }
        
        console.log(`Extracted ${extractedText.length} characters from ${metadata.fileName}`);
        
        // Chunk the text
        const chunks = chunkText(extractedText);
        console.log(`Created ${chunks.length} chunks`);
        
        // Store chunks and queue for embeddings
        await storeAndQueueChunks(metadata.itemId, chunks);
        
        // Clean up the job record
        await rdsClient.send(
          new ExecuteStatementCommand({
            resourceArn: DATABASE_RESOURCE_ARN,
            secretArn: DATABASE_SECRET_ARN,
            database: DATABASE_NAME,
            sql: 'DELETE FROM textract_jobs WHERE job_id = :jobId',
            parameters: [createSqlParameter('jobId', JobId)]
          })
        );
        
      } else if (Status === 'FAILED') {
        console.error(`Textract job failed: ${JobId}`);
        
        const metadata = await getJobMetadata(JobId);
        if (metadata) {
          await rdsClient.send(
            new ExecuteStatementCommand({
              resourceArn: DATABASE_RESOURCE_ARN,
              secretArn: DATABASE_SECRET_ARN,
              database: DATABASE_NAME,
              sql: `UPDATE repository_items 
                    SET processing_status = 'failed',
                        processing_error = 'Textract processing failed',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :itemId`,
              parameters: [createSqlParameter('itemId', metadata.itemId)]
            })
          );
        }
      }
      
    } catch (error) {
      console.error('Error processing Textract completion:', error);
    }
  }
}