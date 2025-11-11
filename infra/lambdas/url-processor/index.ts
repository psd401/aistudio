import { APIGatewayProxyEvent } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand, SqlParameter } from '@aws-sdk/client-rds-data';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { marked } from 'marked';

const rdsClient = new RDSDataClient({});
const dynamoClient = new DynamoDBClient({});

const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE!;
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN!;
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

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

interface URLProcessingJob {
  jobId: string;
  itemId: number;
  url: string;
  itemName: string;
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

// Fetch and extract text content from URL
async function fetchAndExtractContent(url: string): Promise<string> {
  try {
    // Create an AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 seconds

    try {
      // Fetch the URL with a timeout
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AIStudioBot/1.0; +https://aistudio.psd401.ai)',
        },
      });
      
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const html = await response.text();

      // Parse HTML and extract text
      const $ = cheerio.load(html);

      // Remove script and style elements
      $('script, style, noscript').remove();

      // Try to find main content areas
      let content = '';
    
      // Common content selectors
      const contentSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.content',
      '#content',
      '.post',
      '.entry-content',
      '.article-content',
    ];

      for (const selector of contentSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          content = element.text();
          break;
        }
      }

      // If no specific content area found, get all text
      if (!content) {
        content = $('body').text();
      }

      // Clean up the text
      content = content
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newline
      .trim();

      // If content is markdown or has markdown-like content, process it
      if (contentType.includes('markdown') || url.endsWith('.md')) {
        const htmlContent = await marked.parse(content);
        content = htmlContent.replace(/<[^>]*>/g, '').trim();
      }

      // Extract metadata
      const title = $('title').text() || $('h1').first().text() || '';
      const description = $('meta[name="description"]').attr('content') || 
                         $('meta[property="og:description"]').attr('content') || '';

      // Prepend metadata to content
      if (title) {
        content = `Title: ${title}\n\n${content}`;
      }
      if (description) {
        content = `Description: ${description}\n\n${content}`;
      }

      return content;
    } catch (fetchError: any) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        throw new Error('Request timeout after 30 seconds');
      }
      throw fetchError;
    }
  } catch (error) {
    console.error('Error fetching URL:', error);
    throw new Error(`Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Intelligent text chunking (same as file processor)
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

// Store chunks in database
async function storeChunks(itemId: number, chunks: ChunkData[]) {
  if (chunks.length === 0) return;
  
  // First, delete existing chunks for this item
  await rdsClient.send(
    new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: 'DELETE FROM document_chunks WHERE item_id = :itemId',
      parameters: [createSqlParameter('itemId', itemId)],
    })
  );
  
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
    
    await rdsClient.send(
      new BatchExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO document_chunks 
              (item_id, content, metadata, chunk_index, tokens)
              VALUES (:itemId, :content, :metadata::jsonb, :chunkIndex, :tokens)`,
        parameterSets: batch,
      })
    );
  }
}

// Process a URL
async function processURL(job: URLProcessingJob) {
  console.log(`Processing URL: ${job.url} for item: ${job.itemName}`);
  
  try {
    // Update status to processing
    await updateItemStatus(job.itemId, 'processing');
    await updateJobStatus(job.jobId, 'processing', { url: job.url });
    
    // Fetch and extract content from URL
    const content = await fetchAndExtractContent(job.url);
    
    if (!content || content.trim().length === 0) {
      throw new Error('No content extracted from URL');
    }
    
    // Chunk text
    const chunks = chunkText(content);
    console.log(`Extracted ${chunks.length} chunks from ${job.url}`);
    
    // Store chunks
    await storeChunks(job.itemId, chunks);
    
    // Update status to completed
    await updateItemStatus(job.itemId, 'completed');
    await updateJobStatus(job.jobId, 'completed', {
      url: job.url,
      chunksCreated: chunks.length,
      totalTokens: chunks.reduce((sum, chunk) => sum + (chunk.tokens || 0), 0),
    });
    
  } catch (error) {
    console.error(`Error processing URL ${job.url}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await updateItemStatus(job.itemId, 'failed', errorMessage);
    await updateJobStatus(job.jobId, 'failed', { url: job.url }, errorMessage);
    
    throw error; // Re-throw to let Lambda handle retry logic
  }
}

// Lambda handler - can be invoked directly
export async function handler(event: APIGatewayProxyEvent | URLProcessingJob) {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  try {
    // Check if this is a direct invocation with job data
    if ('jobId' in event && 'itemId' in event && 'url' in event) {
      await processURL(event as URLProcessingJob);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'URL processed successfully' }),
      };
    }
    
    // Otherwise, handle as API Gateway event
    const body = JSON.parse((event as APIGatewayProxyEvent).body || '{}');
    
    if (!body.jobId || !body.itemId || !body.url) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: jobId, itemId, url' }),
      };
    }
    
    await processURL(body as URLProcessingJob);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'URL processing started' }),
    };
    
  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
    };
  }
}