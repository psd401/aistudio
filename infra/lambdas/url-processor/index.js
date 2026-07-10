"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBlockedAddress = isBlockedAddress;
exports.assertUrlAllowed = assertUrlAllowed;
exports.safeFetch = safeFetch;
exports.chunkText = chunkText;
exports.storeChunks = storeChunks;
exports.handler = handler;
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const promises_1 = require("dns/promises");
const net_1 = require("net");
const cheerio = __importStar(require("cheerio"));
const marked_1 = require("marked");
// HTTP is performed with the Node 20 global `fetch` (REV-INFRA-122): the processing
// layer pinned node-fetch v3, which is ESM-only and threw ERR_REQUIRE_ESM when this
// CommonJS handler `require`d it — crashing init on every invocation. The global
// fetch needs no layer dependency.
const rdsClient = new client_rds_data_1.RDSDataClient({});
const dynamoClient = new client_dynamodb_1.DynamoDBClient({});
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE;
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN;
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN;
const DATABASE_NAME = process.env.DATABASE_NAME;
// Helper function to create SQL parameters with proper types
function createSqlParameter(name, value) {
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
// Update job status in DynamoDB
async function updateJobStatus(jobId, status, details, error) {
    const timestamp = Date.now();
    const ttl = Math.floor(timestamp / 1000) + 86400 * 7; // 7 days TTL
    await dynamoClient.send(new client_dynamodb_1.PutItemCommand({
        TableName: JOB_STATUS_TABLE,
        Item: {
            jobId: { S: jobId },
            timestamp: { N: timestamp.toString() },
            status: { S: status },
            details: details ? { S: JSON.stringify(details) } : { NULL: true },
            error: error ? { S: error } : { NULL: true },
            ttl: { N: ttl.toString() },
        },
    }));
}
// Update repository item status in database
async function updateItemStatus(itemId, status, error) {
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
    const parameters = [
        createSqlParameter('itemId', itemId),
        createSqlParameter('status', status),
    ];
    if (error) {
        parameters.push(createSqlParameter('error', error));
    }
    await rdsClient.send(new client_rds_data_1.ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql,
        parameters,
    }));
}
// --- SSRF protection (REV-COR-434) -------------------------------------------
// The URL comes straight from the job payload with no upstream guarantee that it
// is public, so validate the scheme and the *resolved* destination before every
// fetch, and re-validate on each redirect hop (a public host can 302 to an
// internal one).
const MAX_REDIRECTS = 5;
function ipv4IsBlocked(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
        return true; // malformed → block
    }
    const [a, b, c] = parts;
    if (a === 0)
        return true; // 0.0.0.0/8 "this network"
    if (a === 10)
        return true; // 10.0.0.0/8 private
    if (a === 127)
        return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254)
        return true; // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168)
        return true; // 192.168.0.0/16 private
    if (a === 192 && b === 0 && c === 0)
        return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19))
        return true; // 198.18.0.0/15 benchmarking
    if (a === 203 && b === 0 && c === 113)
        return true; // 203.0.113.0/24 documentation (TEST-NET-3)
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64.0.0/10 CGNAT
    return false;
}
function ipv6IsBlocked(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::')
        return true; // loopback / unspecified
    // IPv4-mapped IPv6, either dotted-decimal (::ffff:127.0.0.1) or Node's
    // hex-normalized form (::ffff:7f00:1) — the URL parser rewrites the former
    // to the latter, so both must be checked or the dotted-decimal-only regex
    // is trivially bypassed (REV: Gemini SSRF finding on PR #1130).
    const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted)
        return ipv4IsBlocked(dotted[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        const asIpv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return ipv4IsBlocked(asIpv4);
    }
    // Deprecated IPv4-compatible form (no "ffff:" marker), e.g. "::127.0.0.1".
    const deprecated = lower.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (deprecated)
        return ipv4IsBlocked(deprecated[1]);
    if (/^fe[89ab]/.test(lower))
        return true; // fe80::/10 link-local
    if (/^f[cd]/.test(lower))
        return true; // fc00::/7 unique-local
    return false;
}
// Exported for unit testing (REV-COR-434 tests).
function isBlockedAddress(ip) {
    const kind = (0, net_1.isIP)(ip);
    if (kind === 4)
        return ipv4IsBlocked(ip);
    if (kind === 6)
        return ipv6IsBlocked(ip);
    return true; // not a parseable IP → block
}
// Reject non-http(s) schemes and any host that resolves to a private/loopback/
// link-local/metadata address. Throws on any violation. Exported for tests.
async function assertUrlAllowed(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Blocked URL scheme "${parsed.protocol}" (only http/https allowed)`);
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')) {
        throw new Error(`Blocked internal hostname: ${parsed.hostname}`);
    }
    // A literal IP host is validated directly; a name is resolved to every A/AAAA.
    if ((0, net_1.isIP)(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new Error(`Blocked address ${hostname} (SSRF protection)`);
        }
        return;
    }
    let records;
    try {
        records = await (0, promises_1.lookup)(hostname, { all: true });
    }
    catch {
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
async function safeFetch(rawUrl, signal) {
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
async function fetchAndExtractContent(url) {
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
                const htmlContent = await marked_1.marked.parse(content);
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
        }
        catch (fetchError) {
            clearTimeout(timeout);
            if (fetchError.name === 'AbortError') {
                throw new Error('Request timeout after 30 seconds');
            }
            throw fetchError;
        }
    }
    catch (error) {
        console.error('Error fetching URL:', error);
        throw new Error(`Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
// Intelligent text chunking (same as file processor)
// Exported for unit testing (REV-INFRA-135 lineStart test).
function chunkText(text, maxChunkSize = 2000) {
    const chunks = [];
    const lines = text.split('\n');
    let currentChunk = '';
    let lineStart = 0; // source line where the current chunk begins
    let currentChunkLines = 0; // number of lines accumulated into the current chunk
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
        }
        else {
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
async function storeChunks(itemId, chunks) {
    if (chunks.length === 0)
        return;
    // First, delete existing chunks for this item
    await rdsClient.send(new client_rds_data_1.ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: 'DELETE FROM repository_item_chunks WHERE item_id = :itemId',
        parameters: [createSqlParameter('itemId', itemId)],
    }));
    // Batch insert new chunks
    const parameterSets = chunks.map(chunk => [
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
        await rdsClient.send(new client_rds_data_1.BatchExecuteStatementCommand({
            resourceArn: DATABASE_RESOURCE_ARN,
            secretArn: DATABASE_SECRET_ARN,
            database: DATABASE_NAME,
            sql: `INSERT INTO repository_item_chunks
              (item_id, content, metadata, chunk_index, tokens)
              VALUES (:itemId, :content, :metadata::jsonb, :chunkIndex, :tokens)`,
            parameterSets: batch,
        }));
    }
}
// Process a URL
async function processURL(job) {
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
    }
    catch (error) {
        console.error(`Error processing URL ${job.url}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await updateItemStatus(job.itemId, 'failed', errorMessage);
        await updateJobStatus(job.jobId, 'failed', { url: job.url }, errorMessage);
        throw error; // Re-throw to let Lambda handle retry logic
    }
}
// Lambda handler - can be invoked directly (async/event) or via API Gateway.
async function handler(event) {
    console.log('Received event:', JSON.stringify(event, null, 2));
    // Direct/async invocation (event source, InvocationType=Event, SNS/EventBridge/S3).
    // Let processURL errors propagate out of the handler so Lambda marks the invocation
    // failed and applies its retry / on-failure destination / DLQ machinery. Returning a
    // 500-shaped object here would be recorded by Lambda as a SUCCESS and silently drop
    // the retry (REV-COR-435). processURL records 'failed' status before it re-throws.
    if ('jobId' in event && 'itemId' in event && 'url' in event) {
        await processURL(event);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'URL processed successfully' }),
        };
    }
    // API Gateway invocation — return HTTP-shaped responses (including 4xx/5xx).
    try {
        const body = JSON.parse(event.body || '{}');
        if (!body.jobId || !body.itemId || !body.url) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required fields: jobId, itemId, url' }),
            };
        }
        await processURL(body);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'URL processing started' }),
        };
    }
    catch (error) {
        console.error('Handler error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error',
            }),
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXdLQSw0Q0FLQztBQUlELDRDQXdDQztBQUtELDhCQXlCQztBQWlHRCw4QkFrQ0M7QUFPRCxrQ0F3Q0M7QUE2Q0QsMEJBMENDO0FBL2ZELDhEQUE4SDtBQUM5SCw4REFBMEU7QUFDMUUsMkNBQXNDO0FBQ3RDLDZCQUEyQjtBQUMzQixpREFBbUM7QUFDbkMsbUNBQWdDO0FBRWhDLG9GQUFvRjtBQUNwRixvRkFBb0Y7QUFDcEYsaUZBQWlGO0FBQ2pGLG1DQUFtQztBQUVuQyxNQUFNLFNBQVMsR0FBRyxJQUFJLCtCQUFhLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDeEMsTUFBTSxZQUFZLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRTVDLE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBaUIsQ0FBQztBQUN2RCxNQUFNLHFCQUFxQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMscUJBQXNCLENBQUM7QUFDakUsTUFBTSxtQkFBbUIsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFvQixDQUFDO0FBQzdELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBRWpELDZEQUE2RDtBQUM3RCxTQUFTLGtCQUFrQixDQUFDLElBQVksRUFBRSxLQUF1QztJQUMvRSxJQUFJLEtBQUssS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNuQixPQUFPLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO0lBQzNDLENBQUM7SUFDRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzlCLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUM7SUFDakQsQ0FBQztJQUNELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDOUIsT0FBTyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLEVBQUUsQ0FBQztJQUMvQyxDQUFDO0lBQ0QsSUFBSSxPQUFPLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMvQixPQUFPLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLFlBQVksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO0lBQ2xELENBQUM7SUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLGtDQUFrQyxJQUFJLEtBQUssT0FBTyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0FBQzdFLENBQUM7QUFnQkQsZ0NBQWdDO0FBQ2hDLEtBQUssVUFBVSxlQUFlLENBQzVCLEtBQWEsRUFDYixNQUFjLEVBQ2QsT0FBYSxFQUNiLEtBQWM7SUFFZCxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDN0IsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLGFBQWE7SUFFbkUsTUFBTSxZQUFZLENBQUMsSUFBSSxDQUNyQixJQUFJLGdDQUFjLENBQUM7UUFDakIsU0FBUyxFQUFFLGdCQUFnQjtRQUMzQixJQUFJLEVBQUU7WUFDSixLQUFLLEVBQUUsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFO1lBQ25CLFNBQVMsRUFBRSxFQUFFLENBQUMsRUFBRSxTQUFTLENBQUMsUUFBUSxFQUFFLEVBQUU7WUFDdEMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRTtZQUNyQixPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRTtZQUNsRSxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFO1lBQzVDLEdBQUcsRUFBRSxFQUFFLENBQUMsRUFBRSxHQUFHLENBQUMsUUFBUSxFQUFFLEVBQUU7U0FDM0I7S0FDRixDQUFDLENBQ0gsQ0FBQztBQUNKLENBQUM7QUFFRCw0Q0FBNEM7QUFDNUMsS0FBSyxVQUFVLGdCQUFnQixDQUM3QixNQUFjLEVBQ2QsTUFBYyxFQUNkLEtBQWM7SUFFZCxNQUFNLEdBQUcsR0FBRyxLQUFLO1FBQ2YsQ0FBQyxDQUFDOzs7OzBCQUlvQjtRQUN0QixDQUFDLENBQUM7Ozs7MEJBSW9CLENBQUM7SUFFekIsTUFBTSxVQUFVLEdBQW1CO1FBQ2pDLGtCQUFrQixDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUM7UUFDcEMsa0JBQWtCLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQztLQUNyQyxDQUFDO0lBRUYsSUFBSSxLQUFLLEVBQUUsQ0FBQztRQUNWLFVBQVUsQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUVELE1BQU0sU0FBUyxDQUFDLElBQUksQ0FDbEIsSUFBSSx5Q0FBdUIsQ0FBQztRQUMxQixXQUFXLEVBQUUscUJBQXFCO1FBQ2xDLFNBQVMsRUFBRSxtQkFBbUI7UUFDOUIsUUFBUSxFQUFFLGFBQWE7UUFDdkIsR0FBRztRQUNILFVBQVU7S0FDWCxDQUFDLENBQ0gsQ0FBQztBQUNKLENBQUM7QUFFRCxnRkFBZ0Y7QUFDaEYsaUZBQWlGO0FBQ2pGLGdGQUFnRjtBQUNoRiwyRUFBMkU7QUFDM0UsaUJBQWlCO0FBQ2pCLE1BQU0sYUFBYSxHQUFHLENBQUMsQ0FBQztBQUV4QixTQUFTLGFBQWEsQ0FBQyxFQUFVO0lBQy9CLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2pGLE9BQU8sSUFBSSxDQUFDLENBQUMsb0JBQW9CO0lBQ25DLENBQUM7SUFDRCxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUM7SUFDeEIsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDLENBQTJCLDJCQUEyQjtJQUMvRSxJQUFJLENBQUMsS0FBSyxFQUFFO1FBQUUsT0FBTyxJQUFJLENBQUMsQ0FBMEIscUJBQXFCO0lBQ3pFLElBQUksQ0FBQyxLQUFLLEdBQUc7UUFBRSxPQUFPLElBQUksQ0FBQyxDQUF5Qix1QkFBdUI7SUFDM0UsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHO1FBQUUsT0FBTyxJQUFJLENBQUMsQ0FBWSw2Q0FBNkM7SUFDakcsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUU7UUFBRSxPQUFPLElBQUksQ0FBQyxDQUFHLHdCQUF3QjtJQUM1RSxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUc7UUFBRSxPQUFPLElBQUksQ0FBQyxDQUFZLHlCQUF5QjtJQUM3RSxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDLENBQUcseUNBQXlDO0lBQzdGLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDLENBQUMsNkJBQTZCO0lBQ25GLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxHQUFHO1FBQUUsT0FBTyxJQUFJLENBQUMsQ0FBQyw0Q0FBNEM7SUFDaEcsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUc7UUFBRSxPQUFPLElBQUksQ0FBQyxDQUFFLHNCQUFzQjtJQUMxRSxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxFQUFVO0lBQy9CLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUMvQixJQUFJLEtBQUssS0FBSyxLQUFLLElBQUksS0FBSyxLQUFLLElBQUk7UUFBRSxPQUFPLElBQUksQ0FBQyxDQUFDLHlCQUF5QjtJQUU3RSx1RUFBdUU7SUFDdkUsMkVBQTJFO0lBQzNFLDBFQUEwRTtJQUMxRSxnRUFBZ0U7SUFDaEUsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQyxDQUFDO0lBQzVFLElBQUksTUFBTTtRQUFFLE9BQU8sYUFBYSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVDLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsMENBQTBDLENBQUMsQ0FBQztJQUNwRSxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ1IsTUFBTSxJQUFJLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUNsQyxNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pDLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLEdBQUcsR0FBRyxJQUFJLEVBQUUsQ0FBQztRQUN6RixPQUFPLGFBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUMvQixDQUFDO0lBQ0QsMkVBQTJFO0lBQzNFLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsMENBQTBDLENBQUMsQ0FBQztJQUMzRSxJQUFJLFVBQVU7UUFBRSxPQUFPLGFBQWEsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUVwRCxJQUFJLFdBQVcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUMsQ0FBVyx1QkFBdUI7SUFDM0UsSUFBSSxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDLENBQWMsd0JBQXdCO0lBQzVFLE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQUVELGlEQUFpRDtBQUNqRCxTQUFnQixnQkFBZ0IsQ0FBQyxFQUFVO0lBQ3pDLE1BQU0sSUFBSSxHQUFHLElBQUEsVUFBSSxFQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3RCLElBQUksSUFBSSxLQUFLLENBQUM7UUFBRSxPQUFPLGFBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN6QyxJQUFJLElBQUksS0FBSyxDQUFDO1FBQUUsT0FBTyxhQUFhLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDekMsT0FBTyxJQUFJLENBQUMsQ0FBQyw2QkFBNkI7QUFDNUMsQ0FBQztBQUVELCtFQUErRTtBQUMvRSw0RUFBNEU7QUFDckUsS0FBSyxVQUFVLGdCQUFnQixDQUFDLE1BQWM7SUFDbkQsSUFBSSxNQUFXLENBQUM7SUFDaEIsSUFBSSxDQUFDO1FBQ0gsTUFBTSxHQUFHLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzNCLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxNQUFNLElBQUksS0FBSyxDQUFDLGdCQUFnQixNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFDRCxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssT0FBTyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDaEUsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsTUFBTSxDQUFDLFFBQVEsNkJBQTZCLENBQUMsQ0FBQztJQUN2RixDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsc0JBQXNCO0lBQzlGLElBQ0UsUUFBUSxLQUFLLFdBQVc7UUFDeEIsUUFBUSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUM7UUFDL0IsUUFBUSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUM7UUFDOUIsUUFBUSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFDM0IsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQ25FLENBQUM7SUFDRCwrRUFBK0U7SUFDL0UsSUFBSSxJQUFBLFVBQUksRUFBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBQ25CLElBQUksZ0JBQWdCLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztZQUMvQixNQUFNLElBQUksS0FBSyxDQUFDLG1CQUFtQixRQUFRLG9CQUFvQixDQUFDLENBQUM7UUFDbkUsQ0FBQztRQUNELE9BQU87SUFDVCxDQUFDO0lBQ0QsSUFBSSxPQUFtQyxDQUFDO0lBQ3hDLElBQUksQ0FBQztRQUNILE9BQU8sR0FBRyxNQUFNLElBQUEsaUJBQU0sRUFBQyxRQUFRLEVBQUUsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNsRCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsTUFBTSxJQUFJLEtBQUssQ0FBQyw2QkFBNkIsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDbEUsQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixNQUFNLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBQ0QsS0FBSyxNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksT0FBTyxFQUFFLENBQUM7UUFDbEMsSUFBSSxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQzlCLE1BQU0sSUFBSSxLQUFLLENBQUMsUUFBUSxNQUFNLENBQUMsUUFBUSxnQ0FBZ0MsT0FBTyxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3RHLENBQUM7SUFDSCxDQUFDO0FBQ0gsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSxnRkFBZ0Y7QUFDaEYsc0JBQXNCO0FBQ2YsS0FBSyxVQUFVLFNBQVMsQ0FBQyxNQUFjLEVBQUUsTUFBbUI7SUFDakUsSUFBSSxVQUFVLEdBQUcsTUFBTSxDQUFDO0lBQ3hCLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztJQUNsQixTQUFTLENBQUM7UUFDUixNQUFNLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ25DLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLFVBQVUsRUFBRTtZQUN2QyxNQUFNO1lBQ04sUUFBUSxFQUFFLFFBQVE7WUFDbEIsT0FBTyxFQUFFO2dCQUNQLFlBQVksRUFBRSx3RUFBd0U7YUFDdkY7U0FDRixDQUFDLENBQUM7UUFDSCxNQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsTUFBTSxJQUFJLEdBQUcsSUFBSSxRQUFRLENBQUMsTUFBTSxHQUFHLEdBQUcsQ0FBQztRQUNuRSxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNsRCxJQUFJLFVBQVUsSUFBSSxRQUFRLEVBQUUsQ0FBQztZQUMzQixNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxxREFBcUQ7WUFDcEYsSUFBSSxTQUFTLElBQUksYUFBYSxFQUFFLENBQUM7Z0JBQy9CLE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLGFBQWEsR0FBRyxDQUFDLENBQUM7WUFDN0QsQ0FBQztZQUNELFNBQVMsRUFBRSxDQUFDO1lBQ1osVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLDRCQUE0QjtZQUNuRixTQUFTO1FBQ1gsQ0FBQztRQUNELE9BQU8sUUFBUSxDQUFDO0lBQ2xCLENBQUM7QUFDSCxDQUFDO0FBRUQsMENBQTBDO0FBQzFDLEtBQUssVUFBVSxzQkFBc0IsQ0FBQyxHQUFXO0lBQy9DLElBQUksQ0FBQztRQUNILHdDQUF3QztRQUN4QyxNQUFNLFVBQVUsR0FBRyxJQUFJLGVBQWUsRUFBRSxDQUFDO1FBQ3pDLE1BQU0sT0FBTyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxVQUFVLENBQUMsS0FBSyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxhQUFhO1FBRTFFLElBQUksQ0FBQztZQUNILDJFQUEyRTtZQUMzRSxNQUFNLFFBQVEsR0FBRyxNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUUsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBRXpELFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUV0QixJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO2dCQUNqQixNQUFNLElBQUksS0FBSyxDQUFDLHVCQUF1QixRQUFRLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUM1RCxDQUFDO1lBRUQsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQy9ELE1BQU0sSUFBSSxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBRW5DLDhCQUE4QjtZQUM5QixNQUFNLENBQUMsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBRTdCLG1DQUFtQztZQUNuQyxDQUFDLENBQUMseUJBQXlCLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUV0QyxpQ0FBaUM7WUFDakMsSUFBSSxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBRWpCLDJCQUEyQjtZQUMzQixNQUFNLGdCQUFnQixHQUFHO2dCQUN6QixNQUFNO2dCQUNOLFNBQVM7Z0JBQ1QsZUFBZTtnQkFDZixVQUFVO2dCQUNWLFVBQVU7Z0JBQ1YsT0FBTztnQkFDUCxnQkFBZ0I7Z0JBQ2hCLGtCQUFrQjthQUNuQixDQUFDO1lBRUEsS0FBSyxNQUFNLFFBQVEsSUFBSSxnQkFBZ0IsRUFBRSxDQUFDO2dCQUN4QyxNQUFNLE9BQU8sR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQzVCLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDdkIsT0FBTyxHQUFHLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQztvQkFDekIsTUFBTTtnQkFDUixDQUFDO1lBQ0gsQ0FBQztZQUVELGtEQUFrRDtZQUNsRCxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7Z0JBQ2IsT0FBTyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUM3QixDQUFDO1lBRUQsb0JBQW9CO1lBQ3BCLE9BQU8sR0FBRyxPQUFPO2lCQUNoQixPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLGdEQUFnRDtpQkFDckUsT0FBTyxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUMsQ0FBQyxnREFBZ0Q7aUJBQzNFLElBQUksRUFBRSxDQUFDO1lBRVIsa0VBQWtFO1lBQ2xFLElBQUksV0FBVyxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsSUFBSSxHQUFHLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQzVELE1BQU0sV0FBVyxHQUFHLE1BQU0sZUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDaEQsT0FBTyxHQUFHLFdBQVcsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3ZELENBQUM7WUFFRCxtQkFBbUI7WUFDbkIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7WUFDaEUsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDLDBCQUEwQixDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDOUMsQ0FBQyxDQUFDLGlDQUFpQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUU5RSw4QkFBOEI7WUFDOUIsSUFBSSxLQUFLLEVBQUUsQ0FBQztnQkFDVixPQUFPLEdBQUcsVUFBVSxLQUFLLE9BQU8sT0FBTyxFQUFFLENBQUM7WUFDNUMsQ0FBQztZQUNELElBQUksV0FBVyxFQUFFLENBQUM7Z0JBQ2hCLE9BQU8sR0FBRyxnQkFBZ0IsV0FBVyxPQUFPLE9BQU8sRUFBRSxDQUFDO1lBQ3hELENBQUM7WUFFRCxPQUFPLE9BQU8sQ0FBQztRQUNqQixDQUFDO1FBQUMsT0FBTyxVQUFlLEVBQUUsQ0FBQztZQUN6QixZQUFZLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDdEIsSUFBSSxVQUFVLENBQUMsSUFBSSxLQUFLLFlBQVksRUFBRSxDQUFDO2dCQUNyQyxNQUFNLElBQUksS0FBSyxDQUFDLGtDQUFrQyxDQUFDLENBQUM7WUFDdEQsQ0FBQztZQUNELE1BQU0sVUFBVSxDQUFDO1FBQ25CLENBQUM7SUFDSCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMscUJBQXFCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDNUMsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsZUFBZSxFQUFFLENBQUMsQ0FBQztJQUN0RyxDQUFDO0FBQ0gsQ0FBQztBQUVELHFEQUFxRDtBQUNyRCw0REFBNEQ7QUFDNUQsU0FBZ0IsU0FBUyxDQUFDLElBQVksRUFBRSxlQUF1QixJQUFJO0lBQ2pFLE1BQU0sTUFBTSxHQUFnQixFQUFFLENBQUM7SUFDL0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUMvQixJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7SUFDdEIsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDLENBQVksNkNBQTZDO0lBQzNFLElBQUksaUJBQWlCLEdBQUcsQ0FBQyxDQUFDLENBQUkscURBQXFEO0lBRW5GLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsQ0FBQyxNQUFNLEdBQUcsWUFBWSxJQUFJLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDM0UsTUFBTSxDQUFDLElBQUksQ0FBQztnQkFDVixPQUFPLEVBQUUsWUFBWSxDQUFDLElBQUksRUFBRTtnQkFDNUIsUUFBUSxFQUFFLEVBQUUsU0FBUyxFQUFFO2dCQUN2QixVQUFVLEVBQUUsTUFBTSxDQUFDLE1BQU07Z0JBQ3pCLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEVBQUUsdUJBQXVCO2FBQ3BFLENBQUMsQ0FBQztZQUNILFNBQVMsSUFBSSxpQkFBaUIsQ0FBQyxDQUFDLDRDQUE0QztZQUM1RSxZQUFZLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQztZQUMzQixpQkFBaUIsR0FBRyxDQUFDLENBQUM7UUFDeEIsQ0FBQzthQUFNLENBQUM7WUFDTixZQUFZLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQztZQUM1QixpQkFBaUIsRUFBRSxDQUFDO1FBQ3RCLENBQUM7SUFDSCxDQUFDO0lBRUQsSUFBSSxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ25DLE1BQU0sQ0FBQyxJQUFJLENBQUM7WUFDVixPQUFPLEVBQUUsWUFBWSxDQUFDLElBQUksRUFBRTtZQUM1QixRQUFRLEVBQUUsRUFBRSxTQUFTLEVBQUU7WUFDdkIsVUFBVSxFQUFFLE1BQU0sQ0FBQyxNQUFNO1lBQ3pCLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1NBQzNDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBRUQsMkJBQTJCO0FBQzNCLGlGQUFpRjtBQUNqRixtRkFBbUY7QUFDbkYsMEVBQTBFO0FBQzFFLDZCQUE2QjtBQUN0QixLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQWMsRUFBRSxNQUFtQjtJQUNuRSxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU87SUFFaEMsOENBQThDO0lBQzlDLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FDbEIsSUFBSSx5Q0FBdUIsQ0FBQztRQUMxQixXQUFXLEVBQUUscUJBQXFCO1FBQ2xDLFNBQVMsRUFBRSxtQkFBbUI7UUFDOUIsUUFBUSxFQUFFLGFBQWE7UUFDdkIsR0FBRyxFQUFFLDREQUE0RDtRQUNqRSxVQUFVLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLENBQUM7S0FDbkQsQ0FBQyxDQUNILENBQUM7SUFFRiwwQkFBMEI7SUFDMUIsTUFBTSxhQUFhLEdBQXFCLE1BQU0sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUMxRCxrQkFBa0IsQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDO1FBQ3BDLGtCQUFrQixDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQzVDLGtCQUFrQixDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM5RCxrQkFBa0IsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQztRQUNsRCxrQkFBa0IsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUM7S0FDbkQsQ0FBQyxDQUFDO0lBRUgseURBQXlEO0lBQ3pELE1BQU0sU0FBUyxHQUFHLEVBQUUsQ0FBQztJQUNyQixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsYUFBYSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksU0FBUyxFQUFFLENBQUM7UUFDekQsTUFBTSxLQUFLLEdBQUcsYUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsQ0FBQyxDQUFDO1FBRXBELE1BQU0sU0FBUyxDQUFDLElBQUksQ0FDbEIsSUFBSSw4Q0FBNEIsQ0FBQztZQUMvQixXQUFXLEVBQUUscUJBQXFCO1lBQ2xDLFNBQVMsRUFBRSxtQkFBbUI7WUFDOUIsUUFBUSxFQUFFLGFBQWE7WUFDdkIsR0FBRyxFQUFFOztpRkFFb0U7WUFDekUsYUFBYSxFQUFFLEtBQUs7U0FDckIsQ0FBQyxDQUNILENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQUVELGdCQUFnQjtBQUNoQixLQUFLLFVBQVUsVUFBVSxDQUFDLEdBQXFCO0lBQzdDLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLEdBQUcsQ0FBQyxHQUFHLGNBQWMsR0FBRyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFcEUsSUFBSSxDQUFDO1FBQ0gsOEJBQThCO1FBQzlCLE1BQU0sZ0JBQWdCLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxZQUFZLENBQUMsQ0FBQztRQUNqRCxNQUFNLGVBQWUsQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLFlBQVksRUFBRSxFQUFFLEdBQUcsRUFBRSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUVqRSxxQ0FBcUM7UUFDckMsTUFBTSxPQUFPLEdBQUcsTUFBTSxzQkFBc0IsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFdEQsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMsK0JBQStCLENBQUMsQ0FBQztRQUNuRCxDQUFDO1FBRUQsYUFBYTtRQUNiLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNsQyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsTUFBTSxDQUFDLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO1FBRWpFLGVBQWU7UUFDZixNQUFNLFdBQVcsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBRXRDLDZCQUE2QjtRQUM3QixNQUFNLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDaEQsTUFBTSxlQUFlLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxXQUFXLEVBQUU7WUFDNUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHO1lBQ1osYUFBYSxFQUFFLE1BQU0sQ0FBQyxNQUFNO1lBQzVCLFdBQVcsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7U0FDekUsQ0FBQyxDQUFDO0lBRUwsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixHQUFHLENBQUMsR0FBRyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDekQsTUFBTSxZQUFZLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDO1FBRTlFLE1BQU0sZ0JBQWdCLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDM0QsTUFBTSxlQUFlLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxRQUFRLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsRUFBRSxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBRTNFLE1BQU0sS0FBSyxDQUFDLENBQUMsNENBQTRDO0lBQzNELENBQUM7QUFDSCxDQUFDO0FBRUQsNkVBQTZFO0FBQ3RFLEtBQUssVUFBVSxPQUFPLENBQUMsS0FBOEM7SUFDMUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUUvRCxvRkFBb0Y7SUFDcEYsb0ZBQW9GO0lBQ3BGLHFGQUFxRjtJQUNyRixvRkFBb0Y7SUFDcEYsbUZBQW1GO0lBQ25GLElBQUksT0FBTyxJQUFJLEtBQUssSUFBSSxRQUFRLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLEVBQUUsQ0FBQztRQUM1RCxNQUFNLFVBQVUsQ0FBQyxLQUF5QixDQUFDLENBQUM7UUFDNUMsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxPQUFPLEVBQUUsNEJBQTRCLEVBQUUsQ0FBQztTQUNoRSxDQUFDO0lBQ0osQ0FBQztJQUVELDZFQUE2RTtJQUM3RSxJQUFJLENBQUM7UUFDSCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFFLEtBQThCLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxDQUFDO1FBRXRFLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUM3QyxPQUFPO2dCQUNMLFVBQVUsRUFBRSxHQUFHO2dCQUNmLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDZDQUE2QyxFQUFFLENBQUM7YUFDL0UsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLFVBQVUsQ0FBQyxJQUF3QixDQUFDLENBQUM7UUFFM0MsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsQ0FBQztTQUM1RCxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixLQUFLLEVBQUUsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsZUFBZTthQUNoRSxDQUFDO1NBQ0gsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBBUElHYXRld2F5UHJveHlFdmVudCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgUkRTRGF0YUNsaWVudCwgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQsIEJhdGNoRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQsIFNxbFBhcmFtZXRlciB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1yZHMtZGF0YSc7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCwgUHV0SXRlbUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgbG9va3VwIH0gZnJvbSAnZG5zL3Byb21pc2VzJztcbmltcG9ydCB7IGlzSVAgfSBmcm9tICduZXQnO1xuaW1wb3J0ICogYXMgY2hlZXJpbyBmcm9tICdjaGVlcmlvJztcbmltcG9ydCB7IG1hcmtlZCB9IGZyb20gJ21hcmtlZCc7XG5cbi8vIEhUVFAgaXMgcGVyZm9ybWVkIHdpdGggdGhlIE5vZGUgMjAgZ2xvYmFsIGBmZXRjaGAgKFJFVi1JTkZSQS0xMjIpOiB0aGUgcHJvY2Vzc2luZ1xuLy8gbGF5ZXIgcGlubmVkIG5vZGUtZmV0Y2ggdjMsIHdoaWNoIGlzIEVTTS1vbmx5IGFuZCB0aHJldyBFUlJfUkVRVUlSRV9FU00gd2hlbiB0aGlzXG4vLyBDb21tb25KUyBoYW5kbGVyIGByZXF1aXJlYGQgaXQg4oCUIGNyYXNoaW5nIGluaXQgb24gZXZlcnkgaW52b2NhdGlvbi4gVGhlIGdsb2JhbFxuLy8gZmV0Y2ggbmVlZHMgbm8gbGF5ZXIgZGVwZW5kZW5jeS5cblxuY29uc3QgcmRzQ2xpZW50ID0gbmV3IFJEU0RhdGFDbGllbnQoe30pO1xuY29uc3QgZHluYW1vQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcblxuY29uc3QgSk9CX1NUQVRVU19UQUJMRSA9IHByb2Nlc3MuZW52LkpPQl9TVEFUVVNfVEFCTEUhO1xuY29uc3QgREFUQUJBU0VfUkVTT1VSQ0VfQVJOID0gcHJvY2Vzcy5lbnYuREFUQUJBU0VfUkVTT1VSQ0VfQVJOITtcbmNvbnN0IERBVEFCQVNFX1NFQ1JFVF9BUk4gPSBwcm9jZXNzLmVudi5EQVRBQkFTRV9TRUNSRVRfQVJOITtcbmNvbnN0IERBVEFCQVNFX05BTUUgPSBwcm9jZXNzLmVudi5EQVRBQkFTRV9OQU1FITtcblxuLy8gSGVscGVyIGZ1bmN0aW9uIHRvIGNyZWF0ZSBTUUwgcGFyYW1ldGVycyB3aXRoIHByb3BlciB0eXBlc1xuZnVuY3Rpb24gY3JlYXRlU3FsUGFyYW1ldGVyKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCBudWxsKTogU3FsUGFyYW1ldGVyIHtcbiAgaWYgKHZhbHVlID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgbmFtZSwgdmFsdWU6IHsgaXNOdWxsOiB0cnVlIH0gfTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiB7IG5hbWUsIHZhbHVlOiB7IHN0cmluZ1ZhbHVlOiB2YWx1ZSB9IH07XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICByZXR1cm4geyBuYW1lLCB2YWx1ZTogeyBsb25nVmFsdWU6IHZhbHVlIH0gfTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpIHtcbiAgICByZXR1cm4geyBuYW1lLCB2YWx1ZTogeyBib29sZWFuVmFsdWU6IHZhbHVlIH0gfTtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHBhcmFtZXRlciB0eXBlIGZvciAke25hbWV9OiAke3R5cGVvZiB2YWx1ZX1gKTtcbn1cblxuaW50ZXJmYWNlIFVSTFByb2Nlc3NpbmdKb2Ige1xuICBqb2JJZDogc3RyaW5nO1xuICBpdGVtSWQ6IG51bWJlcjtcbiAgdXJsOiBzdHJpbmc7XG4gIGl0ZW1OYW1lOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBDaHVua0RhdGEge1xuICBjb250ZW50OiBzdHJpbmc7XG4gIG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICBjaHVua0luZGV4OiBudW1iZXI7XG4gIHRva2Vucz86IG51bWJlcjtcbn1cblxuLy8gVXBkYXRlIGpvYiBzdGF0dXMgaW4gRHluYW1vREJcbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUpvYlN0YXR1cyhcbiAgam9iSWQ6IHN0cmluZyxcbiAgc3RhdHVzOiBzdHJpbmcsXG4gIGRldGFpbHM/OiBhbnksXG4gIGVycm9yPzogc3RyaW5nXG4pIHtcbiAgY29uc3QgdGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcih0aW1lc3RhbXAgLyAxMDAwKSArIDg2NDAwICogNzsgLy8gNyBkYXlzIFRUTFxuXG4gIGF3YWl0IGR5bmFtb0NsaWVudC5zZW5kKFxuICAgIG5ldyBQdXRJdGVtQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPQl9TVEFUVVNfVEFCTEUsXG4gICAgICBJdGVtOiB7XG4gICAgICAgIGpvYklkOiB7IFM6IGpvYklkIH0sXG4gICAgICAgIHRpbWVzdGFtcDogeyBOOiB0aW1lc3RhbXAudG9TdHJpbmcoKSB9LFxuICAgICAgICBzdGF0dXM6IHsgUzogc3RhdHVzIH0sXG4gICAgICAgIGRldGFpbHM6IGRldGFpbHMgPyB7IFM6IEpTT04uc3RyaW5naWZ5KGRldGFpbHMpIH0gOiB7IE5VTEw6IHRydWUgfSxcbiAgICAgICAgZXJyb3I6IGVycm9yID8geyBTOiBlcnJvciB9IDogeyBOVUxMOiB0cnVlIH0sXG4gICAgICAgIHR0bDogeyBOOiB0dGwudG9TdHJpbmcoKSB9LFxuICAgICAgfSxcbiAgICB9KVxuICApO1xufVxuXG4vLyBVcGRhdGUgcmVwb3NpdG9yeSBpdGVtIHN0YXR1cyBpbiBkYXRhYmFzZVxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlSXRlbVN0YXR1cyhcbiAgaXRlbUlkOiBudW1iZXIsXG4gIHN0YXR1czogc3RyaW5nLFxuICBlcnJvcj86IHN0cmluZ1xuKSB7XG4gIGNvbnN0IHNxbCA9IGVycm9yXG4gICAgPyBgVVBEQVRFIHJlcG9zaXRvcnlfaXRlbXMgXG4gICAgICAgU0VUIHByb2Nlc3Npbmdfc3RhdHVzID0gOnN0YXR1cywgXG4gICAgICAgICAgIHByb2Nlc3NpbmdfZXJyb3IgPSA6ZXJyb3IsXG4gICAgICAgICAgIHVwZGF0ZWRfYXQgPSBDVVJSRU5UX1RJTUVTVEFNUFxuICAgICAgIFdIRVJFIGlkID0gOml0ZW1JZGBcbiAgICA6IGBVUERBVEUgcmVwb3NpdG9yeV9pdGVtcyBcbiAgICAgICBTRVQgcHJvY2Vzc2luZ19zdGF0dXMgPSA6c3RhdHVzLFxuICAgICAgICAgICBwcm9jZXNzaW5nX2Vycm9yID0gTlVMTCxcbiAgICAgICAgICAgdXBkYXRlZF9hdCA9IENVUlJFTlRfVElNRVNUQU1QXG4gICAgICAgV0hFUkUgaWQgPSA6aXRlbUlkYDtcblxuICBjb25zdCBwYXJhbWV0ZXJzOiBTcWxQYXJhbWV0ZXJbXSA9IFtcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ2l0ZW1JZCcsIGl0ZW1JZCksXG4gICAgY3JlYXRlU3FsUGFyYW1ldGVyKCdzdGF0dXMnLCBzdGF0dXMpLFxuICBdO1xuXG4gIGlmIChlcnJvcikge1xuICAgIHBhcmFtZXRlcnMucHVzaChjcmVhdGVTcWxQYXJhbWV0ZXIoJ2Vycm9yJywgZXJyb3IpKTtcbiAgfVxuXG4gIGF3YWl0IHJkc0NsaWVudC5zZW5kKFxuICAgIG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgICByZXNvdXJjZUFybjogREFUQUJBU0VfUkVTT1VSQ0VfQVJOLFxuICAgICAgc2VjcmV0QXJuOiBEQVRBQkFTRV9TRUNSRVRfQVJOLFxuICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICBzcWwsXG4gICAgICBwYXJhbWV0ZXJzLFxuICAgIH0pXG4gICk7XG59XG5cbi8vIC0tLSBTU1JGIHByb3RlY3Rpb24gKFJFVi1DT1ItNDM0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgVVJMIGNvbWVzIHN0cmFpZ2h0IGZyb20gdGhlIGpvYiBwYXlsb2FkIHdpdGggbm8gdXBzdHJlYW0gZ3VhcmFudGVlIHRoYXQgaXRcbi8vIGlzIHB1YmxpYywgc28gdmFsaWRhdGUgdGhlIHNjaGVtZSBhbmQgdGhlICpyZXNvbHZlZCogZGVzdGluYXRpb24gYmVmb3JlIGV2ZXJ5XG4vLyBmZXRjaCwgYW5kIHJlLXZhbGlkYXRlIG9uIGVhY2ggcmVkaXJlY3QgaG9wIChhIHB1YmxpYyBob3N0IGNhbiAzMDIgdG8gYW5cbi8vIGludGVybmFsIG9uZSkuXG5jb25zdCBNQVhfUkVESVJFQ1RTID0gNTtcblxuZnVuY3Rpb24gaXB2NElzQmxvY2tlZChpcDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhcnRzID0gaXAuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCAhPT0gNCB8fCBwYXJ0cy5zb21lKChwKSA9PiBOdW1iZXIuaXNOYU4ocCkgfHwgcCA8IDAgfHwgcCA+IDI1NSkpIHtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gbWFsZm9ybWVkIOKGkiBibG9ja1xuICB9XG4gIGNvbnN0IFthLCBiLCBjXSA9IHBhcnRzO1xuICBpZiAoYSA9PT0gMCkgcmV0dXJuIHRydWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gMC4wLjAuMC84IFwidGhpcyBuZXR3b3JrXCJcbiAgaWYgKGEgPT09IDEwKSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIDEwLjAuMC4wLzggcHJpdmF0ZVxuICBpZiAoYSA9PT0gMTI3KSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAgICAgICAgICAgICAgLy8gMTI3LjAuMC4wLzggbG9vcGJhY2tcbiAgaWYgKGEgPT09IDE2OSAmJiBiID09PSAyNTQpIHJldHVybiB0cnVlOyAgICAgICAgICAgIC8vIDE2OS4yNTQuMC4wLzE2IGxpbmstbG9jYWwgKyBjbG91ZCBtZXRhZGF0YVxuICBpZiAoYSA9PT0gMTcyICYmIGIgPj0gMTYgJiYgYiA8PSAzMSkgcmV0dXJuIHRydWU7ICAgLy8gMTcyLjE2LjAuMC8xMiBwcml2YXRlXG4gIGlmIChhID09PSAxOTIgJiYgYiA9PT0gMTY4KSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAvLyAxOTIuMTY4LjAuMC8xNiBwcml2YXRlXG4gIGlmIChhID09PSAxOTIgJiYgYiA9PT0gMCAmJiBjID09PSAwKSByZXR1cm4gdHJ1ZTsgICAvLyAxOTIuMC4wLjAvMjQgSUVURiBwcm90b2NvbCBhc3NpZ25tZW50c1xuICBpZiAoYSA9PT0gMTk4ICYmIChiID09PSAxOCB8fCBiID09PSAxOSkpIHJldHVybiB0cnVlOyAvLyAxOTguMTguMC4wLzE1IGJlbmNobWFya2luZ1xuICBpZiAoYSA9PT0gMjAzICYmIGIgPT09IDAgJiYgYyA9PT0gMTEzKSByZXR1cm4gdHJ1ZTsgLy8gMjAzLjAuMTEzLjAvMjQgZG9jdW1lbnRhdGlvbiAoVEVTVC1ORVQtMylcbiAgaWYgKGEgPT09IDEwMCAmJiBiID49IDY0ICYmIGIgPD0gMTI3KSByZXR1cm4gdHJ1ZTsgIC8vIDEwMC42NC4wLjAvMTAgQ0dOQVRcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBpcHY2SXNCbG9ja2VkKGlwOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBpcC50b0xvd2VyQ2FzZSgpO1xuICBpZiAobG93ZXIgPT09ICc6OjEnIHx8IGxvd2VyID09PSAnOjonKSByZXR1cm4gdHJ1ZTsgLy8gbG9vcGJhY2sgLyB1bnNwZWNpZmllZFxuXG4gIC8vIElQdjQtbWFwcGVkIElQdjYsIGVpdGhlciBkb3R0ZWQtZGVjaW1hbCAoOjpmZmZmOjEyNy4wLjAuMSkgb3IgTm9kZSdzXG4gIC8vIGhleC1ub3JtYWxpemVkIGZvcm0gKDo6ZmZmZjo3ZjAwOjEpIOKAlCB0aGUgVVJMIHBhcnNlciByZXdyaXRlcyB0aGUgZm9ybWVyXG4gIC8vIHRvIHRoZSBsYXR0ZXIsIHNvIGJvdGggbXVzdCBiZSBjaGVja2VkIG9yIHRoZSBkb3R0ZWQtZGVjaW1hbC1vbmx5IHJlZ2V4XG4gIC8vIGlzIHRyaXZpYWxseSBieXBhc3NlZCAoUkVWOiBHZW1pbmkgU1NSRiBmaW5kaW5nIG9uIFBSICMxMTMwKS5cbiAgY29uc3QgZG90dGVkID0gbG93ZXIubWF0Y2goL146OmZmZmY6KFxcZHsxLDN9XFwuXFxkezEsM31cXC5cXGR7MSwzfVxcLlxcZHsxLDN9KSQvKTtcbiAgaWYgKGRvdHRlZCkgcmV0dXJuIGlwdjRJc0Jsb2NrZWQoZG90dGVkWzFdKTtcbiAgY29uc3QgaGV4ID0gbG93ZXIubWF0Y2goL146OmZmZmY6KFswLTlhLWZdezEsNH0pOihbMC05YS1mXXsxLDR9KSQvKTtcbiAgaWYgKGhleCkge1xuICAgIGNvbnN0IGhpZ2ggPSBwYXJzZUludChoZXhbMV0sIDE2KTtcbiAgICBjb25zdCBsb3cgPSBwYXJzZUludChoZXhbMl0sIDE2KTtcbiAgICBjb25zdCBhc0lwdjQgPSBgJHsoaGlnaCA+PiA4KSAmIDB4ZmZ9LiR7aGlnaCAmIDB4ZmZ9LiR7KGxvdyA+PiA4KSAmIDB4ZmZ9LiR7bG93ICYgMHhmZn1gO1xuICAgIHJldHVybiBpcHY0SXNCbG9ja2VkKGFzSXB2NCk7XG4gIH1cbiAgLy8gRGVwcmVjYXRlZCBJUHY0LWNvbXBhdGlibGUgZm9ybSAobm8gXCJmZmZmOlwiIG1hcmtlciksIGUuZy4gXCI6OjEyNy4wLjAuMVwiLlxuICBjb25zdCBkZXByZWNhdGVkID0gbG93ZXIubWF0Y2goL146OihcXGR7MSwzfVxcLlxcZHsxLDN9XFwuXFxkezEsM31cXC5cXGR7MSwzfSkkLyk7XG4gIGlmIChkZXByZWNhdGVkKSByZXR1cm4gaXB2NElzQmxvY2tlZChkZXByZWNhdGVkWzFdKTtcblxuICBpZiAoL15mZVs4OWFiXS8udGVzdChsb3dlcikpIHJldHVybiB0cnVlOyAgICAgICAgICAgLy8gZmU4MDo6LzEwIGxpbmstbG9jYWxcbiAgaWYgKC9eZltjZF0vLnRlc3QobG93ZXIpKSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAgIC8vIGZjMDA6Oi83IHVuaXF1ZS1sb2NhbFxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIEV4cG9ydGVkIGZvciB1bml0IHRlc3RpbmcgKFJFVi1DT1ItNDM0IHRlc3RzKS5cbmV4cG9ydCBmdW5jdGlvbiBpc0Jsb2NrZWRBZGRyZXNzKGlwOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qga2luZCA9IGlzSVAoaXApO1xuICBpZiAoa2luZCA9PT0gNCkgcmV0dXJuIGlwdjRJc0Jsb2NrZWQoaXApO1xuICBpZiAoa2luZCA9PT0gNikgcmV0dXJuIGlwdjZJc0Jsb2NrZWQoaXApO1xuICByZXR1cm4gdHJ1ZTsgLy8gbm90IGEgcGFyc2VhYmxlIElQIOKGkiBibG9ja1xufVxuXG4vLyBSZWplY3Qgbm9uLWh0dHAocykgc2NoZW1lcyBhbmQgYW55IGhvc3QgdGhhdCByZXNvbHZlcyB0byBhIHByaXZhdGUvbG9vcGJhY2svXG4vLyBsaW5rLWxvY2FsL21ldGFkYXRhIGFkZHJlc3MuIFRocm93cyBvbiBhbnkgdmlvbGF0aW9uLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0VXJsQWxsb3dlZChyYXdVcmw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChyYXdVcmwpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgVVJMOiAke3Jhd1VybH1gKTtcbiAgfVxuICBpZiAocGFyc2VkLnByb3RvY29sICE9PSAnaHR0cDonICYmIHBhcnNlZC5wcm90b2NvbCAhPT0gJ2h0dHBzOicpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEJsb2NrZWQgVVJMIHNjaGVtZSBcIiR7cGFyc2VkLnByb3RvY29sfVwiIChvbmx5IGh0dHAvaHR0cHMgYWxsb3dlZClgKTtcbiAgfVxuICBjb25zdCBob3N0bmFtZSA9IHBhcnNlZC5ob3N0bmFtZS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL15cXFt8XFxdJC9nLCAnJyk7IC8vIHN0cmlwIElQdjYgYnJhY2tldHNcbiAgaWYgKFxuICAgIGhvc3RuYW1lID09PSAnbG9jYWxob3N0JyB8fFxuICAgIGhvc3RuYW1lLmVuZHNXaXRoKCcubG9jYWxob3N0JykgfHxcbiAgICBob3N0bmFtZS5lbmRzV2l0aCgnLmludGVybmFsJykgfHxcbiAgICBob3N0bmFtZS5lbmRzV2l0aCgnLmxvY2FsJylcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBCbG9ja2VkIGludGVybmFsIGhvc3RuYW1lOiAke3BhcnNlZC5ob3N0bmFtZX1gKTtcbiAgfVxuICAvLyBBIGxpdGVyYWwgSVAgaG9zdCBpcyB2YWxpZGF0ZWQgZGlyZWN0bHk7IGEgbmFtZSBpcyByZXNvbHZlZCB0byBldmVyeSBBL0FBQUEuXG4gIGlmIChpc0lQKGhvc3RuYW1lKSkge1xuICAgIGlmIChpc0Jsb2NrZWRBZGRyZXNzKGhvc3RuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBCbG9ja2VkIGFkZHJlc3MgJHtob3N0bmFtZX0gKFNTUkYgcHJvdGVjdGlvbilgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZWNvcmRzOiBBcnJheTx7IGFkZHJlc3M6IHN0cmluZyB9PjtcbiAgdHJ5IHtcbiAgICByZWNvcmRzID0gYXdhaXQgbG9va3VwKGhvc3RuYW1lLCB7IGFsbDogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBETlMgcmVzb2x1dGlvbiBmYWlsZWQgZm9yICR7cGFyc2VkLmhvc3RuYW1lfWApO1xuICB9XG4gIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgTm8gRE5TIHJlY29yZHMgZm9yICR7cGFyc2VkLmhvc3RuYW1lfWApO1xuICB9XG4gIGZvciAoY29uc3QgeyBhZGRyZXNzIH0gb2YgcmVjb3Jkcykge1xuICAgIGlmIChpc0Jsb2NrZWRBZGRyZXNzKGFkZHJlc3MpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEhvc3QgJHtwYXJzZWQuaG9zdG5hbWV9IHJlc29sdmVzIHRvIGJsb2NrZWQgYWRkcmVzcyAke2FkZHJlc3N9IChTU1JGIHByb3RlY3Rpb24pYCk7XG4gICAgfVxuICB9XG59XG5cbi8vIEZldGNoIHRoYXQgdmFsaWRhdGVzIHRoZSB0YXJnZXQg4oCUIGFuZCBldmVyeSByZWRpcmVjdCBob3Ag4oCUIGFnYWluc3QgdGhlIFNTUkZcbi8vIHJ1bGVzLiBSZWRpcmVjdHMgYXJlIGZvbGxvd2VkIG1hbnVhbGx5IHNvIGVhY2ggbmV3IGRlc3RpbmF0aW9uIGlzIHJlLWNoZWNrZWQuXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2FmZUZldGNoKHJhd1VybDogc3RyaW5nLCBzaWduYWw6IEFib3J0U2lnbmFsKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBsZXQgY3VycmVudFVybCA9IHJhd1VybDtcbiAgbGV0IHJlZGlyZWN0cyA9IDA7XG4gIGZvciAoOzspIHtcbiAgICBhd2FpdCBhc3NlcnRVcmxBbGxvd2VkKGN1cnJlbnRVcmwpO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goY3VycmVudFVybCwge1xuICAgICAgc2lnbmFsLFxuICAgICAgcmVkaXJlY3Q6ICdtYW51YWwnLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnVXNlci1BZ2VudCc6ICdNb3ppbGxhLzUuMCAoY29tcGF0aWJsZTsgQUlTdHVkaW9Cb3QvMS4wOyAraHR0cHM6Ly9haXN0dWRpby5wc2Q0MDEuYWkpJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgaXNSZWRpcmVjdCA9IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDAgJiYgcmVzcG9uc2Uuc3RhdHVzIDwgNDAwO1xuICAgIGNvbnN0IGxvY2F0aW9uID0gcmVzcG9uc2UuaGVhZGVycy5nZXQoJ2xvY2F0aW9uJyk7XG4gICAgaWYgKGlzUmVkaXJlY3QgJiYgbG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHJlc3BvbnNlLmJvZHk/LmNhbmNlbCgpOyAvLyBkcmFpbiB0aGUgdW51c2VkIHJlZGlyZWN0IGJvZHkgYmVmb3JlIGZvbGxvd2luZyBpdFxuICAgICAgaWYgKHJlZGlyZWN0cyA+PSBNQVhfUkVESVJFQ1RTKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9vIG1hbnkgcmVkaXJlY3RzICg+ICR7TUFYX1JFRElSRUNUU30pYCk7XG4gICAgICB9XG4gICAgICByZWRpcmVjdHMrKztcbiAgICAgIGN1cnJlbnRVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLCBjdXJyZW50VXJsKS50b1N0cmluZygpOyAvLyByZXNvbHZlIHJlbGF0aXZlIExvY2F0aW9uXG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG59XG5cbi8vIEZldGNoIGFuZCBleHRyYWN0IHRleHQgY29udGVudCBmcm9tIFVSTFxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbmRFeHRyYWN0Q29udGVudCh1cmw6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIHRyeSB7XG4gICAgLy8gQ3JlYXRlIGFuIEFib3J0Q29udHJvbGxlciBmb3IgdGltZW91dFxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCAzMDAwMCk7IC8vIDMwIHNlY29uZHNcblxuICAgIHRyeSB7XG4gICAgICAvLyBGZXRjaCB0aGUgVVJMIHdpdGggYSB0aW1lb3V0IChTU1JGLXZhbGlkYXRlZCBvbiBldmVyeSBob3Ag4oCUIFJFVi1DT1ItNDM0KVxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzYWZlRmV0Y2godXJsLCBjb250cm9sbGVyLnNpZ25hbCk7XG5cbiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblxuICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgZXJyb3IhIHN0YXR1czogJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNvbnRlbnRUeXBlID0gcmVzcG9uc2UuaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnO1xuICAgICAgY29uc3QgaHRtbCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcblxuICAgICAgLy8gUGFyc2UgSFRNTCBhbmQgZXh0cmFjdCB0ZXh0XG4gICAgICBjb25zdCAkID0gY2hlZXJpby5sb2FkKGh0bWwpO1xuXG4gICAgICAvLyBSZW1vdmUgc2NyaXB0IGFuZCBzdHlsZSBlbGVtZW50c1xuICAgICAgJCgnc2NyaXB0LCBzdHlsZSwgbm9zY3JpcHQnKS5yZW1vdmUoKTtcblxuICAgICAgLy8gVHJ5IHRvIGZpbmQgbWFpbiBjb250ZW50IGFyZWFzXG4gICAgICBsZXQgY29udGVudCA9ICcnO1xuICAgIFxuICAgICAgLy8gQ29tbW9uIGNvbnRlbnQgc2VsZWN0b3JzXG4gICAgICBjb25zdCBjb250ZW50U2VsZWN0b3JzID0gW1xuICAgICAgJ21haW4nLFxuICAgICAgJ2FydGljbGUnLFxuICAgICAgJ1tyb2xlPVwibWFpblwiXScsXG4gICAgICAnLmNvbnRlbnQnLFxuICAgICAgJyNjb250ZW50JyxcbiAgICAgICcucG9zdCcsXG4gICAgICAnLmVudHJ5LWNvbnRlbnQnLFxuICAgICAgJy5hcnRpY2xlLWNvbnRlbnQnLFxuICAgIF07XG5cbiAgICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgY29udGVudFNlbGVjdG9ycykge1xuICAgICAgICBjb25zdCBlbGVtZW50ID0gJChzZWxlY3Rvcik7XG4gICAgICAgIGlmIChlbGVtZW50Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb250ZW50ID0gZWxlbWVudC50ZXh0KCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSWYgbm8gc3BlY2lmaWMgY29udGVudCBhcmVhIGZvdW5kLCBnZXQgYWxsIHRleHRcbiAgICAgIGlmICghY29udGVudCkge1xuICAgICAgICBjb250ZW50ID0gJCgnYm9keScpLnRleHQoKTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2xlYW4gdXAgdGhlIHRleHRcbiAgICAgIGNvbnRlbnQgPSBjb250ZW50XG4gICAgICAucmVwbGFjZSgvXFxzKy9nLCAnICcpIC8vIFJlcGxhY2UgbXVsdGlwbGUgd2hpdGVzcGFjZSB3aXRoIHNpbmdsZSBzcGFjZVxuICAgICAgLnJlcGxhY2UoL1xcbnszLH0vZywgJ1xcblxcbicpIC8vIFJlcGxhY2UgbXVsdGlwbGUgbmV3bGluZXMgd2l0aCBkb3VibGUgbmV3bGluZVxuICAgICAgLnRyaW0oKTtcblxuICAgICAgLy8gSWYgY29udGVudCBpcyBtYXJrZG93biBvciBoYXMgbWFya2Rvd24tbGlrZSBjb250ZW50LCBwcm9jZXNzIGl0XG4gICAgICBpZiAoY29udGVudFR5cGUuaW5jbHVkZXMoJ21hcmtkb3duJykgfHwgdXJsLmVuZHNXaXRoKCcubWQnKSkge1xuICAgICAgICBjb25zdCBodG1sQ29udGVudCA9IGF3YWl0IG1hcmtlZC5wYXJzZShjb250ZW50KTtcbiAgICAgICAgY29udGVudCA9IGh0bWxDb250ZW50LnJlcGxhY2UoLzxbXj5dKj4vZywgJycpLnRyaW0oKTtcbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCBtZXRhZGF0YVxuICAgICAgY29uc3QgdGl0bGUgPSAkKCd0aXRsZScpLnRleHQoKSB8fCAkKCdoMScpLmZpcnN0KCkudGV4dCgpIHx8ICcnO1xuICAgICAgY29uc3QgZGVzY3JpcHRpb24gPSAkKCdtZXRhW25hbWU9XCJkZXNjcmlwdGlvblwiXScpLmF0dHIoJ2NvbnRlbnQnKSB8fCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAkKCdtZXRhW3Byb3BlcnR5PVwib2c6ZGVzY3JpcHRpb25cIl0nKS5hdHRyKCdjb250ZW50JykgfHwgJyc7XG5cbiAgICAgIC8vIFByZXBlbmQgbWV0YWRhdGEgdG8gY29udGVudFxuICAgICAgaWYgKHRpdGxlKSB7XG4gICAgICAgIGNvbnRlbnQgPSBgVGl0bGU6ICR7dGl0bGV9XFxuXFxuJHtjb250ZW50fWA7XG4gICAgICB9XG4gICAgICBpZiAoZGVzY3JpcHRpb24pIHtcbiAgICAgICAgY29udGVudCA9IGBEZXNjcmlwdGlvbjogJHtkZXNjcmlwdGlvbn1cXG5cXG4ke2NvbnRlbnR9YDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGNvbnRlbnQ7XG4gICAgfSBjYXRjaCAoZmV0Y2hFcnJvcjogYW55KSB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICBpZiAoZmV0Y2hFcnJvci5uYW1lID09PSAnQWJvcnRFcnJvcicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdSZXF1ZXN0IHRpbWVvdXQgYWZ0ZXIgMzAgc2Vjb25kcycpO1xuICAgICAgfVxuICAgICAgdGhyb3cgZmV0Y2hFcnJvcjtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgZmV0Y2hpbmcgVVJMOicsIGVycm9yKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBmZXRjaCBVUkw6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAnVW5rbm93biBlcnJvcid9YCk7XG4gIH1cbn1cblxuLy8gSW50ZWxsaWdlbnQgdGV4dCBjaHVua2luZyAoc2FtZSBhcyBmaWxlIHByb2Nlc3Nvcilcbi8vIEV4cG9ydGVkIGZvciB1bml0IHRlc3RpbmcgKFJFVi1JTkZSQS0xMzUgbGluZVN0YXJ0IHRlc3QpLlxuZXhwb3J0IGZ1bmN0aW9uIGNodW5rVGV4dCh0ZXh0OiBzdHJpbmcsIG1heENodW5rU2l6ZTogbnVtYmVyID0gMjAwMCk6IENodW5rRGF0YVtdIHtcbiAgY29uc3QgY2h1bmtzOiBDaHVua0RhdGFbXSA9IFtdO1xuICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoJ1xcbicpO1xuICBsZXQgY3VycmVudENodW5rID0gJyc7XG4gIGxldCBsaW5lU3RhcnQgPSAwOyAgICAgICAgICAgIC8vIHNvdXJjZSBsaW5lIHdoZXJlIHRoZSBjdXJyZW50IGNodW5rIGJlZ2luc1xuICBsZXQgY3VycmVudENodW5rTGluZXMgPSAwOyAgICAvLyBudW1iZXIgb2YgbGluZXMgYWNjdW11bGF0ZWQgaW50byB0aGUgY3VycmVudCBjaHVua1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmICgoY3VycmVudENodW5rICsgbGluZSkubGVuZ3RoID4gbWF4Q2h1bmtTaXplICYmIGN1cnJlbnRDaHVuay5sZW5ndGggPiAwKSB7XG4gICAgICBjaHVua3MucHVzaCh7XG4gICAgICAgIGNvbnRlbnQ6IGN1cnJlbnRDaHVuay50cmltKCksXG4gICAgICAgIG1ldGFkYXRhOiB7IGxpbmVTdGFydCB9LFxuICAgICAgICBjaHVua0luZGV4OiBjaHVua3MubGVuZ3RoLFxuICAgICAgICB0b2tlbnM6IE1hdGguY2VpbChjdXJyZW50Q2h1bmsubGVuZ3RoIC8gNCksIC8vIFJvdWdoIHRva2VuIGVzdGltYXRlXG4gICAgICB9KTtcbiAgICAgIGxpbmVTdGFydCArPSBjdXJyZW50Q2h1bmtMaW5lczsgLy8gbmV4dCBjaHVuayBzdGFydHMgYWZ0ZXIgdGhlIGZsdXNoZWQgbGluZXNcbiAgICAgIGN1cnJlbnRDaHVuayA9IGxpbmUgKyAnXFxuJztcbiAgICAgIGN1cnJlbnRDaHVua0xpbmVzID0gMTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3VycmVudENodW5rICs9IGxpbmUgKyAnXFxuJztcbiAgICAgIGN1cnJlbnRDaHVua0xpbmVzKys7XG4gICAgfVxuICB9XG5cbiAgaWYgKGN1cnJlbnRDaHVuay50cmltKCkubGVuZ3RoID4gMCkge1xuICAgIGNodW5rcy5wdXNoKHtcbiAgICAgIGNvbnRlbnQ6IGN1cnJlbnRDaHVuay50cmltKCksXG4gICAgICBtZXRhZGF0YTogeyBsaW5lU3RhcnQgfSxcbiAgICAgIGNodW5rSW5kZXg6IGNodW5rcy5sZW5ndGgsXG4gICAgICB0b2tlbnM6IE1hdGguY2VpbChjdXJyZW50Q2h1bmsubGVuZ3RoIC8gNCksXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gY2h1bmtzO1xufVxuXG4vLyBTdG9yZSBjaHVua3MgaW4gZGF0YWJhc2Vcbi8vIFRhcmdldHMgcmVwb3NpdG9yeV9pdGVtX2NodW5rcyDigJQgdGhlIGtub3dsZWRnZS1yZXBvc2l0b3J5IGNodW5rIHRhYmxlIHRoYXQgaGFzXG4vLyBpdGVtX2lkL3Rva2VucyBjb2x1bW5zIChtYXRjaGluZyB0ZXh0cmFjdC1wcm9jZXNzb3IpLiBUaGUgbGVnYWN5IHRhYmxlIHRoaXMgdXNlZFxuLy8gdG8gcG9pbnQgYXQgaGFkIG5laXRoZXIgY29sdW1uLCBzbyBldmVyeSBpbnNlcnQgZmFpbGVkIChSRVYtSU5GUkEtMTIxKS5cbi8vIEV4cG9ydGVkIGZvciB1bml0IHRlc3RpbmcuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RvcmVDaHVua3MoaXRlbUlkOiBudW1iZXIsIGNodW5rczogQ2h1bmtEYXRhW10pIHtcbiAgaWYgKGNodW5rcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAvLyBGaXJzdCwgZGVsZXRlIGV4aXN0aW5nIGNodW5rcyBmb3IgdGhpcyBpdGVtXG4gIGF3YWl0IHJkc0NsaWVudC5zZW5kKFxuICAgIG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgICByZXNvdXJjZUFybjogREFUQUJBU0VfUkVTT1VSQ0VfQVJOLFxuICAgICAgc2VjcmV0QXJuOiBEQVRBQkFTRV9TRUNSRVRfQVJOLFxuICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICBzcWw6ICdERUxFVEUgRlJPTSByZXBvc2l0b3J5X2l0ZW1fY2h1bmtzIFdIRVJFIGl0ZW1faWQgPSA6aXRlbUlkJyxcbiAgICAgIHBhcmFtZXRlcnM6IFtjcmVhdGVTcWxQYXJhbWV0ZXIoJ2l0ZW1JZCcsIGl0ZW1JZCldLFxuICAgIH0pXG4gICk7XG4gIFxuICAvLyBCYXRjaCBpbnNlcnQgbmV3IGNodW5rc1xuICBjb25zdCBwYXJhbWV0ZXJTZXRzOiBTcWxQYXJhbWV0ZXJbXVtdID0gY2h1bmtzLm1hcChjaHVuayA9PiBbXG4gICAgY3JlYXRlU3FsUGFyYW1ldGVyKCdpdGVtSWQnLCBpdGVtSWQpLFxuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcignY29udGVudCcsIGNodW5rLmNvbnRlbnQpLFxuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcignbWV0YWRhdGEnLCBKU09OLnN0cmluZ2lmeShjaHVuay5tZXRhZGF0YSkpLFxuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcignY2h1bmtJbmRleCcsIGNodW5rLmNodW5rSW5kZXgpLFxuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcigndG9rZW5zJywgY2h1bmsudG9rZW5zID8/IG51bGwpLFxuICBdKTtcbiAgXG4gIC8vIEJhdGNoRXhlY3V0ZVN0YXRlbWVudCBoYXMgYSBsaW1pdCBvZiAyNSBwYXJhbWV0ZXIgc2V0c1xuICBjb25zdCBiYXRjaFNpemUgPSAyNTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXJhbWV0ZXJTZXRzLmxlbmd0aDsgaSArPSBiYXRjaFNpemUpIHtcbiAgICBjb25zdCBiYXRjaCA9IHBhcmFtZXRlclNldHMuc2xpY2UoaSwgaSArIGJhdGNoU2l6ZSk7XG4gICAgXG4gICAgYXdhaXQgcmRzQ2xpZW50LnNlbmQoXG4gICAgICBuZXcgQmF0Y2hFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgICAgIHJlc291cmNlQXJuOiBEQVRBQkFTRV9SRVNPVVJDRV9BUk4sXG4gICAgICAgIHNlY3JldEFybjogREFUQUJBU0VfU0VDUkVUX0FSTixcbiAgICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICAgIHNxbDogYElOU0VSVCBJTlRPIHJlcG9zaXRvcnlfaXRlbV9jaHVua3NcbiAgICAgICAgICAgICAgKGl0ZW1faWQsIGNvbnRlbnQsIG1ldGFkYXRhLCBjaHVua19pbmRleCwgdG9rZW5zKVxuICAgICAgICAgICAgICBWQUxVRVMgKDppdGVtSWQsIDpjb250ZW50LCA6bWV0YWRhdGE6Ompzb25iLCA6Y2h1bmtJbmRleCwgOnRva2VucylgLFxuICAgICAgICBwYXJhbWV0ZXJTZXRzOiBiYXRjaCxcbiAgICAgIH0pXG4gICAgKTtcbiAgfVxufVxuXG4vLyBQcm9jZXNzIGEgVVJMXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzVVJMKGpvYjogVVJMUHJvY2Vzc2luZ0pvYikge1xuICBjb25zb2xlLmxvZyhgUHJvY2Vzc2luZyBVUkw6ICR7am9iLnVybH0gZm9yIGl0ZW06ICR7am9iLml0ZW1OYW1lfWApO1xuICBcbiAgdHJ5IHtcbiAgICAvLyBVcGRhdGUgc3RhdHVzIHRvIHByb2Nlc3NpbmdcbiAgICBhd2FpdCB1cGRhdGVJdGVtU3RhdHVzKGpvYi5pdGVtSWQsICdwcm9jZXNzaW5nJyk7XG4gICAgYXdhaXQgdXBkYXRlSm9iU3RhdHVzKGpvYi5qb2JJZCwgJ3Byb2Nlc3NpbmcnLCB7IHVybDogam9iLnVybCB9KTtcbiAgICBcbiAgICAvLyBGZXRjaCBhbmQgZXh0cmFjdCBjb250ZW50IGZyb20gVVJMXG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGZldGNoQW5kRXh0cmFjdENvbnRlbnQoam9iLnVybCk7XG4gICAgXG4gICAgaWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyBjb250ZW50IGV4dHJhY3RlZCBmcm9tIFVSTCcpO1xuICAgIH1cbiAgICBcbiAgICAvLyBDaHVuayB0ZXh0XG4gICAgY29uc3QgY2h1bmtzID0gY2h1bmtUZXh0KGNvbnRlbnQpO1xuICAgIGNvbnNvbGUubG9nKGBFeHRyYWN0ZWQgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZnJvbSAke2pvYi51cmx9YCk7XG4gICAgXG4gICAgLy8gU3RvcmUgY2h1bmtzXG4gICAgYXdhaXQgc3RvcmVDaHVua3Moam9iLml0ZW1JZCwgY2h1bmtzKTtcbiAgICBcbiAgICAvLyBVcGRhdGUgc3RhdHVzIHRvIGNvbXBsZXRlZFxuICAgIGF3YWl0IHVwZGF0ZUl0ZW1TdGF0dXMoam9iLml0ZW1JZCwgJ2NvbXBsZXRlZCcpO1xuICAgIGF3YWl0IHVwZGF0ZUpvYlN0YXR1cyhqb2Iuam9iSWQsICdjb21wbGV0ZWQnLCB7XG4gICAgICB1cmw6IGpvYi51cmwsXG4gICAgICBjaHVua3NDcmVhdGVkOiBjaHVua3MubGVuZ3RoLFxuICAgICAgdG90YWxUb2tlbnM6IGNodW5rcy5yZWR1Y2UoKHN1bSwgY2h1bmspID0+IHN1bSArIChjaHVuay50b2tlbnMgfHwgMCksIDApLFxuICAgIH0pO1xuICAgIFxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIHByb2Nlc3NpbmcgVVJMICR7am9iLnVybH06YCwgZXJyb3IpO1xuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InO1xuICAgIFxuICAgIGF3YWl0IHVwZGF0ZUl0ZW1TdGF0dXMoam9iLml0ZW1JZCwgJ2ZhaWxlZCcsIGVycm9yTWVzc2FnZSk7XG4gICAgYXdhaXQgdXBkYXRlSm9iU3RhdHVzKGpvYi5qb2JJZCwgJ2ZhaWxlZCcsIHsgdXJsOiBqb2IudXJsIH0sIGVycm9yTWVzc2FnZSk7XG4gICAgXG4gICAgdGhyb3cgZXJyb3I7IC8vIFJlLXRocm93IHRvIGxldCBMYW1iZGEgaGFuZGxlIHJldHJ5IGxvZ2ljXG4gIH1cbn1cblxuLy8gTGFtYmRhIGhhbmRsZXIgLSBjYW4gYmUgaW52b2tlZCBkaXJlY3RseSAoYXN5bmMvZXZlbnQpIG9yIHZpYSBBUEkgR2F0ZXdheS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCB8IFVSTFByb2Nlc3NpbmdKb2IpIHtcbiAgY29uc29sZS5sb2coJ1JlY2VpdmVkIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50LCBudWxsLCAyKSk7XG5cbiAgLy8gRGlyZWN0L2FzeW5jIGludm9jYXRpb24gKGV2ZW50IHNvdXJjZSwgSW52b2NhdGlvblR5cGU9RXZlbnQsIFNOUy9FdmVudEJyaWRnZS9TMykuXG4gIC8vIExldCBwcm9jZXNzVVJMIGVycm9ycyBwcm9wYWdhdGUgb3V0IG9mIHRoZSBoYW5kbGVyIHNvIExhbWJkYSBtYXJrcyB0aGUgaW52b2NhdGlvblxuICAvLyBmYWlsZWQgYW5kIGFwcGxpZXMgaXRzIHJldHJ5IC8gb24tZmFpbHVyZSBkZXN0aW5hdGlvbiAvIERMUSBtYWNoaW5lcnkuIFJldHVybmluZyBhXG4gIC8vIDUwMC1zaGFwZWQgb2JqZWN0IGhlcmUgd291bGQgYmUgcmVjb3JkZWQgYnkgTGFtYmRhIGFzIGEgU1VDQ0VTUyBhbmQgc2lsZW50bHkgZHJvcFxuICAvLyB0aGUgcmV0cnkgKFJFVi1DT1ItNDM1KS4gcHJvY2Vzc1VSTCByZWNvcmRzICdmYWlsZWQnIHN0YXR1cyBiZWZvcmUgaXQgcmUtdGhyb3dzLlxuICBpZiAoJ2pvYklkJyBpbiBldmVudCAmJiAnaXRlbUlkJyBpbiBldmVudCAmJiAndXJsJyBpbiBldmVudCkge1xuICAgIGF3YWl0IHByb2Nlc3NVUkwoZXZlbnQgYXMgVVJMUHJvY2Vzc2luZ0pvYik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbWVzc2FnZTogJ1VSTCBwcm9jZXNzZWQgc3VjY2Vzc2Z1bGx5JyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQVBJIEdhdGV3YXkgaW52b2NhdGlvbiDigJQgcmV0dXJuIEhUVFAtc2hhcGVkIHJlc3BvbnNlcyAoaW5jbHVkaW5nIDR4eC81eHgpLlxuICB0cnkge1xuICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChldmVudCBhcyBBUElHYXRld2F5UHJveHlFdmVudCkuYm9keSB8fCAne30nKTtcblxuICAgIGlmICghYm9keS5qb2JJZCB8fCAhYm9keS5pdGVtSWQgfHwgIWJvZHkudXJsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNaXNzaW5nIHJlcXVpcmVkIGZpZWxkczogam9iSWQsIGl0ZW1JZCwgdXJsJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgYXdhaXQgcHJvY2Vzc1VSTChib2R5IGFzIFVSTFByb2Nlc3NpbmdKb2IpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbWVzc2FnZTogJ1VSTCBwcm9jZXNzaW5nIHN0YXJ0ZWQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignSGFuZGxlciBlcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxufSJdfQ==