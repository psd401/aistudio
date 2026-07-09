import type { APIGatewayProxyEvent } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand, SqlParameter } from '@aws-sdk/client-rds-data';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import * as cheerio from 'cheerio';
import { marked } from 'marked';

// HTTP is performed with the Node 20 global `fetch` (REV-INFRA-122): the processing
// layer pinned node-fetch v3, which is ESM-only and threw ERR_REQUIRE_ESM when this
// CommonJS handler `require`d it — crashing init on every invocation. The global
// fetch needs no layer dependency.

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

// --- SSRF protection (REV-COR-434) -------------------------------------------
// The URL comes straight from the job payload with no upstream guarantee that it
// is public, so validate the scheme and the *resolved* destination before every
// fetch, and re-validate on each redirect hop (a public host can 302 to an
// internal one).
const MAX_REDIRECTS = 5;

function ipv4IsBlocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;
  if (a === 0) return true;                           // 0.0.0.0/8 "this network"
  if (a === 10) return true;                          // 10.0.0.0/8 private
  if (a === 127) return true;                         // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  return false;
}

function ipv6IsBlocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified

  // IPv4-mapped IPv6, either dotted-decimal (::ffff:127.0.0.1) or Node's
  // hex-normalized form (::ffff:7f00:1) — the URL parser rewrites the former
  // to the latter, so both must be checked or the dotted-decimal-only regex
  // is trivially bypassed (REV: Gemini SSRF finding on PR #1130).
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return ipv4IsBlocked(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const asIpv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return ipv4IsBlocked(asIpv4);
  }

  if (/^fe[89ab]/.test(lower)) return true;           // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true;              // fc00::/7 unique-local
  return false;
}

// Exported for unit testing (REV-COR-434 tests).
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4IsBlocked(ip);
  if (kind === 6) return ipv6IsBlocked(ip);
  return true; // not a parseable IP → block
}

// Reject non-http(s) schemes and any host that resolves to a private/loopback/
// link-local/metadata address. Throws on any violation. Exported for tests.
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" (only http/https allowed)`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new Error(`Blocked internal hostname: ${parsed.hostname}`);
  }
  // A literal IP host is validated directly; a name is resolved to every A/AAAA.
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error(`Blocked address ${hostname} (SSRF protection)`);
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${parsed.hostname}`);
  }
  if (records.length === 0) {
    throw new Error(`No DNS records for ${parsed.hostname}`);
  }
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new Error(`Host ${parsed.hostname} resolves to blocked address ${address} (SSRF protection)`);
    }
  }
}

// Fetch that validates the target — and every redirect hop — against the SSRF
// rules. Redirects are followed manually so each new destination is re-checked.
// Exported for tests.
export async function safeFetch(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = rawUrl;
  let redirects = 0;
  for (;;) {
    await assertUrlAllowed(currentUrl);
    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AIStudioBot/1.0; +https://aistudio.psd401.ai)',
      },
    });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (isRedirect && location) {
      await response.body?.cancel(); // drain the unused redirect body before following it
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
      }
      redirects++;
      currentUrl = new URL(location, currentUrl).toString(); // resolve relative Location
      continue;
    }
    return response;
  }
}

// Fetch and extract text content from URL
async function fetchAndExtractContent(url: string): Promise<string> {
  try {
    // Create an AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 seconds

    try {
      // Fetch the URL with a timeout (SSRF-validated on every hop — REV-COR-434)
      const response = await safeFetch(url, controller.signal);

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
// Exported for unit testing (REV-INFRA-135 lineStart test).
export function chunkText(text: string, maxChunkSize: number = 2000): ChunkData[] {
  const chunks: ChunkData[] = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let lineStart = 0;            // source line where the current chunk begins
  let currentChunkLines = 0;    // number of lines accumulated into the current chunk

  for (const line of lines) {
    if ((currentChunk + line).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { lineStart },
        chunkIndex: chunks.length,
        tokens: Math.ceil(currentChunk.length / 4), // Rough token estimate
      });
      lineStart += currentChunkLines; // next chunk starts after the flushed lines
      currentChunk = line + '\n';
      currentChunkLines = 1;
    } else {
      currentChunk += line + '\n';
      currentChunkLines++;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: { lineStart },
      chunkIndex: chunks.length,
      tokens: Math.ceil(currentChunk.length / 4),
    });
  }

  return chunks;
}

// Store chunks in database
// Targets repository_item_chunks — the knowledge-repository chunk table that has
// item_id/tokens columns (matching textract-processor). The legacy table this used
// to point at had neither column, so every insert failed (REV-INFRA-121).
// Exported for unit testing.
export async function storeChunks(itemId: number, chunks: ChunkData[]) {
  if (chunks.length === 0) return;

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
        sql: `INSERT INTO repository_item_chunks
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

// Lambda handler - can be invoked directly (async/event) or via API Gateway.
export async function handler(event: APIGatewayProxyEvent | URLProcessingJob) {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Direct/async invocation (event source, InvocationType=Event, SNS/EventBridge/S3).
  // Let processURL errors propagate out of the handler so Lambda marks the invocation
  // failed and applies its retry / on-failure destination / DLQ machinery. Returning a
  // 500-shaped object here would be recorded by Lambda as a SUCCESS and silently drop
  // the retry (REV-COR-435). processURL records 'failed' status before it re-throws.
  if ('jobId' in event && 'itemId' in event && 'url' in event) {
    await processURL(event as URLProcessingJob);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'URL processed successfully' }),
    };
  }

  // API Gateway invocation — return HTTP-shaped responses (including 4xx/5xx).
  try {
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
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}