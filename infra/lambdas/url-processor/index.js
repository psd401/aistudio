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
    const [a, b] = parts;
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
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64.0.0/10 CGNAT
    return false;
}
function ipv6IsBlocked(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::')
        return true; // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped)
        return ipv4IsBlocked(mapped[1]); // IPv4-mapped IPv6
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
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
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
            currentUrl = new URL(location, currentUrl).toString(); // resolve relative Location
            continue;
        }
        return response;
    }
    throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9Vc2Vycy9oYWdlbGsvbm9uLWljLWNvZGUvYWlzdHVkaW8vaW5mcmEvbGFtYmRhcy91cmwtcHJvY2Vzc29yL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBcUpBLDRDQUtDO0FBSUQsNENBd0NDO0FBS0QsOEJBb0JDO0FBaUdELDhCQWtDQztBQU9ELGtDQXdDQztBQTZDRCwwQkEwQ0M7QUF2ZUQsOERBQThIO0FBQzlILDhEQUEwRTtBQUMxRSwyQ0FBc0M7QUFDdEMsNkJBQTJCO0FBQzNCLGlEQUFtQztBQUNuQyxtQ0FBZ0M7QUFFaEMsb0ZBQW9GO0FBQ3BGLG9GQUFvRjtBQUNwRixpRkFBaUY7QUFDakYsbUNBQW1DO0FBRW5DLE1BQU0sU0FBUyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN4QyxNQUFNLFlBQVksR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFFNUMsTUFBTSxnQkFBZ0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFpQixDQUFDO0FBQ3ZELE1BQU0scUJBQXFCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQkFBc0IsQ0FBQztBQUNqRSxNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW9CLENBQUM7QUFDN0QsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFFakQsNkRBQTZEO0FBQzdELFNBQVMsa0JBQWtCLENBQUMsSUFBWSxFQUFFLEtBQXVDO0lBQy9FLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ25CLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxFQUFFLENBQUM7SUFDM0Ms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SSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsNkNBQTZDLEVBQUUsQ0FBQzthQUMvRSxDQUFDO1FBQ0osQ0FBQztRQUVELE1BQU0sVUFBVSxDQUFDLElBQXdCLENBQUMsQ0FBQztRQUUzQyxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLE9BQU8sRUFBRSx3QkFBd0IsRUFBRSxDQUFDO1NBQzVELENBQUM7SUFDSixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDdkMsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ25CLEtBQUssRUFBRSxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxlQUFlO2FBQ2hFLENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEFQSUdhdGV3YXlQcm94eUV2ZW50IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBSRFNEYXRhQ2xpZW50LCBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCwgQmF0Y2hFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCwgU3FsUGFyYW1ldGVyIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXJkcy1kYXRhJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50LCBQdXRJdGVtQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBsb29rdXAgfSBmcm9tICdkbnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgaXNJUCB9IGZyb20gJ25ldCc7XG5pbXBvcnQgKiBhcyBjaGVlcmlvIGZyb20gJ2NoZWVyaW8nO1xuaW1wb3J0IHsgbWFya2VkIH0gZnJvbSAnbWFya2VkJztcblxuLy8gSFRUUCBpcyBwZXJmb3JtZWQgd2l0aCB0aGUgTm9kZSAyMCBnbG9iYWwgYGZldGNoYCAoUkVWLUlORlJBLTEyMik6IHRoZSBwcm9jZXNzaW5nXG4vLyBsYXllciBwaW5uZWQgbm9kZS1mZXRjaCB2Mywgd2hpY2ggaXMgRVNNLW9ubHkgYW5kIHRocmV3IEVSUl9SRVFVSVJFX0VTTSB3aGVuIHRoaXNcbi8vIENvbW1vbkpTIGhhbmRsZXIgYHJlcXVpcmVgZCBpdCDigJQgY3Jhc2hpbmcgaW5pdCBvbiBldmVyeSBpbnZvY2F0aW9uLiBUaGUgZ2xvYmFsXG4vLyBmZXRjaCBuZWVkcyBubyBsYXllciBkZXBlbmRlbmN5LlxuXG5jb25zdCByZHNDbGllbnQgPSBuZXcgUkRTRGF0YUNsaWVudCh7fSk7XG5jb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuXG5jb25zdCBKT0JfU1RBVFVTX1RBQkxFID0gcHJvY2Vzcy5lbnYuSk9CX1NUQVRVU19UQUJMRSE7XG5jb25zdCBEQVRBQkFTRV9SRVNPVVJDRV9BUk4gPSBwcm9jZXNzLmVudi5EQVRBQkFTRV9SRVNPVVJDRV9BUk4hO1xuY29uc3QgREFUQUJBU0VfU0VDUkVUX0FSTiA9IHByb2Nlc3MuZW52LkRBVEFCQVNFX1NFQ1JFVF9BUk4hO1xuY29uc3QgREFUQUJBU0VfTkFNRSA9IHByb2Nlc3MuZW52LkRBVEFCQVNFX05BTUUhO1xuXG4vLyBIZWxwZXIgZnVuY3Rpb24gdG8gY3JlYXRlIFNRTCBwYXJhbWV0ZXJzIHdpdGggcHJvcGVyIHR5cGVzXG5mdW5jdGlvbiBjcmVhdGVTcWxQYXJhbWV0ZXIobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IG51bGwpOiBTcWxQYXJhbWV0ZXIge1xuICBpZiAodmFsdWUgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyBuYW1lLCB2YWx1ZTogeyBpc051bGw6IHRydWUgfSB9O1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIHsgbmFtZSwgdmFsdWU6IHsgc3RyaW5nVmFsdWU6IHZhbHVlIH0gfTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykge1xuICAgIHJldHVybiB7IG5hbWUsIHZhbHVlOiB7IGxvbmdWYWx1ZTogdmFsdWUgfSB9O1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykge1xuICAgIHJldHVybiB7IG5hbWUsIHZhbHVlOiB7IGJvb2xlYW5WYWx1ZTogdmFsdWUgfSB9O1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgcGFyYW1ldGVyIHR5cGUgZm9yICR7bmFtZX06ICR7dHlwZW9mIHZhbHVlfWApO1xufVxuXG5pbnRlcmZhY2UgVVJMUHJvY2Vzc2luZ0pvYiB7XG4gIGpvYklkOiBzdHJpbmc7XG4gIGl0ZW1JZDogbnVtYmVyO1xuICB1cmw6IHN0cmluZztcbiAgaXRlbU5hbWU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENodW5rRGF0YSB7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgbWV0YWRhdGE6IFJlY29yZDxzdHJpbmcsIGFueT47XG4gIGNodW5rSW5kZXg6IG51bWJlcjtcbiAgdG9rZW5zPzogbnVtYmVyO1xufVxuXG4vLyBVcGRhdGUgam9iIHN0YXR1cyBpbiBEeW5hbW9EQlxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlSm9iU3RhdHVzKFxuICBqb2JJZDogc3RyaW5nLFxuICBzdGF0dXM6IHN0cmluZyxcbiAgZGV0YWlscz86IGFueSxcbiAgZXJyb3I/OiBzdHJpbmdcbikge1xuICBjb25zdCB0aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKHRpbWVzdGFtcCAvIDEwMDApICsgODY0MDAgKiA3OyAvLyA3IGRheXMgVFRMXG5cbiAgYXdhaXQgZHluYW1vQ2xpZW50LnNlbmQoXG4gICAgbmV3IFB1dEl0ZW1Db21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9CX1NUQVRVU19UQUJMRSxcbiAgICAgIEl0ZW06IHtcbiAgICAgICAgam9iSWQ6IHsgUzogam9iSWQgfSxcbiAgICAgICAgdGltZXN0YW1wOiB7IE46IHRpbWVzdGFtcC50b1N0cmluZygpIH0sXG4gICAgICAgIHN0YXR1czogeyBTOiBzdGF0dXMgfSxcbiAgICAgICAgZGV0YWlsczogZGV0YWlscyA/IHsgUzogSlNPTi5zdHJpbmdpZnkoZGV0YWlscykgfSA6IHsgTlVMTDogdHJ1ZSB9LFxuICAgICAgICBlcnJvcjogZXJyb3IgPyB7IFM6IGVycm9yIH0gOiB7IE5VTEw6IHRydWUgfSxcbiAgICAgICAgdHRsOiB7IE46IHR0bC50b1N0cmluZygpIH0sXG4gICAgICB9LFxuICAgIH0pXG4gICk7XG59XG5cbi8vIFVwZGF0ZSByZXBvc2l0b3J5IGl0ZW0gc3RhdHVzIGluIGRhdGFiYXNlXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVJdGVtU3RhdHVzKFxuICBpdGVtSWQ6IG51bWJlcixcbiAgc3RhdHVzOiBzdHJpbmcsXG4gIGVycm9yPzogc3RyaW5nXG4pIHtcbiAgY29uc3Qgc3FsID0gZXJyb3JcbiAgICA/IGBVUERBVEUgcmVwb3NpdG9yeV9pdGVtcyBcbiAgICAgICBTRVQgcHJvY2Vzc2luZ19zdGF0dXMgPSA6c3RhdHVzLCBcbiAgICAgICAgICAgcHJvY2Vzc2luZ19lcnJvciA9IDplcnJvcixcbiAgICAgICAgICAgdXBkYXRlZF9hdCA9IENVUlJFTlRfVElNRVNUQU1QXG4gICAgICAgV0hFUkUgaWQgPSA6aXRlbUlkYFxuICAgIDogYFVQREFURSByZXBvc2l0b3J5X2l0ZW1zIFxuICAgICAgIFNFVCBwcm9jZXNzaW5nX3N0YXR1cyA9IDpzdGF0dXMsXG4gICAgICAgICAgIHByb2Nlc3NpbmdfZXJyb3IgPSBOVUxMLFxuICAgICAgICAgICB1cGRhdGVkX2F0ID0gQ1VSUkVOVF9USU1FU1RBTVBcbiAgICAgICBXSEVSRSBpZCA9IDppdGVtSWRgO1xuXG4gIGNvbnN0IHBhcmFtZXRlcnM6IFNxbFBhcmFtZXRlcltdID0gW1xuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcignaXRlbUlkJywgaXRlbUlkKSxcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ3N0YXR1cycsIHN0YXR1cyksXG4gIF07XG5cbiAgaWYgKGVycm9yKSB7XG4gICAgcGFyYW1ldGVycy5wdXNoKGNyZWF0ZVNxbFBhcmFtZXRlcignZXJyb3InLCBlcnJvcikpO1xuICB9XG5cbiAgYXdhaXQgcmRzQ2xpZW50LnNlbmQoXG4gICAgbmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICAgIHJlc291cmNlQXJuOiBEQVRBQkFTRV9SRVNPVVJDRV9BUk4sXG4gICAgICBzZWNyZXRBcm46IERBVEFCQVNFX1NFQ1JFVF9BUk4sXG4gICAgICBkYXRhYmFzZTogREFUQUJBU0VfTkFNRSxcbiAgICAgIHNxbCxcbiAgICAgIHBhcmFtZXRlcnMsXG4gICAgfSlcbiAgKTtcbn1cblxuLy8gLS0tIFNTUkYgcHJvdGVjdGlvbiAoUkVWLUNPUi00MzQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZSBVUkwgY29tZXMgc3RyYWlnaHQgZnJvbSB0aGUgam9iIHBheWxvYWQgd2l0aCBubyB1cHN0cmVhbSBndWFyYW50ZWUgdGhhdCBpdFxuLy8gaXMgcHVibGljLCBzbyB2YWxpZGF0ZSB0aGUgc2NoZW1lIGFuZCB0aGUgKnJlc29sdmVkKiBkZXN0aW5hdGlvbiBiZWZvcmUgZXZlcnlcbi8vIGZldGNoLCBhbmQgcmUtdmFsaWRhdGUgb24gZWFjaCByZWRpcmVjdCBob3AgKGEgcHVibGljIGhvc3QgY2FuIDMwMiB0byBhblxuLy8gaW50ZXJuYWwgb25lKS5cbmNvbnN0IE1BWF9SRURJUkVDVFMgPSA1O1xuXG5mdW5jdGlvbiBpcHY0SXNCbG9ja2VkKGlwOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgcGFydHMgPSBpcC5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICBpZiAocGFydHMubGVuZ3RoICE9PSA0IHx8IHBhcnRzLnNvbWUoKHApID0+IE51bWJlci5pc05hTihwKSB8fCBwIDwgMCB8fCBwID4gMjU1KSkge1xuICAgIHJldHVybiB0cnVlOyAvLyBtYWxmb3JtZWQg4oaSIGJsb2NrXG4gIH1cbiAgY29uc3QgW2EsIGJdID0gcGFydHM7XG4gIGlmIChhID09PSAwKSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyAwLjAuMC4wLzggXCJ0aGlzIG5ldHdvcmtcIlxuICBpZiAoYSA9PT0gMTApIHJldHVybiB0cnVlOyAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gMTAuMC4wLjAvOCBwcml2YXRlXG4gIGlmIChhID09PSAxMjcpIHJldHVybiB0cnVlOyAgICAgICAgICAgICAgICAgICAgICAgICAvLyAxMjcuMC4wLjAvOCBsb29wYmFja1xuICBpZiAoYSA9PT0gMTY5ICYmIGIgPT09IDI1NCkgcmV0dXJuIHRydWU7ICAgICAgICAgICAgLy8gMTY5LjI1NC4wLjAvMTYgbGluay1sb2NhbCArIGNsb3VkIG1ldGFkYXRhXG4gIGlmIChhID09PSAxNzIgJiYgYiA+PSAxNiAmJiBiIDw9IDMxKSByZXR1cm4gdHJ1ZTsgICAvLyAxNzIuMTYuMC4wLzEyIHByaXZhdGVcbiAgaWYgKGEgPT09IDE5MiAmJiBiID09PSAxNjgpIHJldHVybiB0cnVlOyAgICAgICAgICAgIC8vIDE5Mi4xNjguMC4wLzE2IHByaXZhdGVcbiAgaWYgKGEgPT09IDEwMCAmJiBiID49IDY0ICYmIGIgPD0gMTI3KSByZXR1cm4gdHJ1ZTsgIC8vIDEwMC42NC4wLjAvMTAgQ0dOQVRcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBpcHY2SXNCbG9ja2VkKGlwOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBpcC50b0xvd2VyQ2FzZSgpO1xuICBpZiAobG93ZXIgPT09ICc6OjEnIHx8IGxvd2VyID09PSAnOjonKSByZXR1cm4gdHJ1ZTsgLy8gbG9vcGJhY2sgLyB1bnNwZWNpZmllZFxuICBjb25zdCBtYXBwZWQgPSBsb3dlci5tYXRjaCgvXjo6ZmZmZjooXFxkezEsM31cXC5cXGR7MSwzfVxcLlxcZHsxLDN9XFwuXFxkezEsM30pJC8pO1xuICBpZiAobWFwcGVkKSByZXR1cm4gaXB2NElzQmxvY2tlZChtYXBwZWRbMV0pOyAgICAgICAgLy8gSVB2NC1tYXBwZWQgSVB2NlxuICBpZiAoL15mZVs4OWFiXS8udGVzdChsb3dlcikpIHJldHVybiB0cnVlOyAgICAgICAgICAgLy8gZmU4MDo6LzEwIGxpbmstbG9jYWxcbiAgaWYgKC9eZltjZF0vLnRlc3QobG93ZXIpKSByZXR1cm4gdHJ1ZTsgICAgICAgICAgICAgIC8vIGZjMDA6Oi83IHVuaXF1ZS1sb2NhbFxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIEV4cG9ydGVkIGZvciB1bml0IHRlc3RpbmcgKFJFVi1DT1ItNDM0IHRlc3RzKS5cbmV4cG9ydCBmdW5jdGlvbiBpc0Jsb2NrZWRBZGRyZXNzKGlwOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qga2luZCA9IGlzSVAoaXApO1xuICBpZiAoa2luZCA9PT0gNCkgcmV0dXJuIGlwdjRJc0Jsb2NrZWQoaXApO1xuICBpZiAoa2luZCA9PT0gNikgcmV0dXJuIGlwdjZJc0Jsb2NrZWQoaXApO1xuICByZXR1cm4gdHJ1ZTsgLy8gbm90IGEgcGFyc2VhYmxlIElQIOKGkiBibG9ja1xufVxuXG4vLyBSZWplY3Qgbm9uLWh0dHAocykgc2NoZW1lcyBhbmQgYW55IGhvc3QgdGhhdCByZXNvbHZlcyB0byBhIHByaXZhdGUvbG9vcGJhY2svXG4vLyBsaW5rLWxvY2FsL21ldGFkYXRhIGFkZHJlc3MuIFRocm93cyBvbiBhbnkgdmlvbGF0aW9uLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0VXJsQWxsb3dlZChyYXdVcmw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChyYXdVcmwpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgVVJMOiAke3Jhd1VybH1gKTtcbiAgfVxuICBpZiAocGFyc2VkLnByb3RvY29sICE9PSAnaHR0cDonICYmIHBhcnNlZC5wcm90b2NvbCAhPT0gJ2h0dHBzOicpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEJsb2NrZWQgVVJMIHNjaGVtZSBcIiR7cGFyc2VkLnByb3RvY29sfVwiIChvbmx5IGh0dHAvaHR0cHMgYWxsb3dlZClgKTtcbiAgfVxuICBjb25zdCBob3N0bmFtZSA9IHBhcnNlZC5ob3N0bmFtZS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL15cXFt8XFxdJC9nLCAnJyk7IC8vIHN0cmlwIElQdjYgYnJhY2tldHNcbiAgaWYgKFxuICAgIGhvc3RuYW1lID09PSAnbG9jYWxob3N0JyB8fFxuICAgIGhvc3RuYW1lLmVuZHNXaXRoKCcubG9jYWxob3N0JykgfHxcbiAgICBob3N0bmFtZS5lbmRzV2l0aCgnLmludGVybmFsJykgfHxcbiAgICBob3N0bmFtZS5lbmRzV2l0aCgnLmxvY2FsJylcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBCbG9ja2VkIGludGVybmFsIGhvc3RuYW1lOiAke3BhcnNlZC5ob3N0bmFtZX1gKTtcbiAgfVxuICAvLyBBIGxpdGVyYWwgSVAgaG9zdCBpcyB2YWxpZGF0ZWQgZGlyZWN0bHk7IGEgbmFtZSBpcyByZXNvbHZlZCB0byBldmVyeSBBL0FBQUEuXG4gIGlmIChpc0lQKGhvc3RuYW1lKSkge1xuICAgIGlmIChpc0Jsb2NrZWRBZGRyZXNzKGhvc3RuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBCbG9ja2VkIGFkZHJlc3MgJHtob3N0bmFtZX0gKFNTUkYgcHJvdGVjdGlvbilgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZWNvcmRzOiBBcnJheTx7IGFkZHJlc3M6IHN0cmluZyB9PjtcbiAgdHJ5IHtcbiAgICByZWNvcmRzID0gYXdhaXQgbG9va3VwKGhvc3RuYW1lLCB7IGFsbDogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBETlMgcmVzb2x1dGlvbiBmYWlsZWQgZm9yICR7cGFyc2VkLmhvc3RuYW1lfWApO1xuICB9XG4gIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgTm8gRE5TIHJlY29yZHMgZm9yICR7cGFyc2VkLmhvc3RuYW1lfWApO1xuICB9XG4gIGZvciAoY29uc3QgeyBhZGRyZXNzIH0gb2YgcmVjb3Jkcykge1xuICAgIGlmIChpc0Jsb2NrZWRBZGRyZXNzKGFkZHJlc3MpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEhvc3QgJHtwYXJzZWQuaG9zdG5hbWV9IHJlc29sdmVzIHRvIGJsb2NrZWQgYWRkcmVzcyAke2FkZHJlc3N9IChTU1JGIHByb3RlY3Rpb24pYCk7XG4gICAgfVxuICB9XG59XG5cbi8vIEZldGNoIHRoYXQgdmFsaWRhdGVzIHRoZSB0YXJnZXQg4oCUIGFuZCBldmVyeSByZWRpcmVjdCBob3Ag4oCUIGFnYWluc3QgdGhlIFNTUkZcbi8vIHJ1bGVzLiBSZWRpcmVjdHMgYXJlIGZvbGxvd2VkIG1hbnVhbGx5IHNvIGVhY2ggbmV3IGRlc3RpbmF0aW9uIGlzIHJlLWNoZWNrZWQuXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2FmZUZldGNoKHJhd1VybDogc3RyaW5nLCBzaWduYWw6IEFib3J0U2lnbmFsKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBsZXQgY3VycmVudFVybCA9IHJhd1VybDtcbiAgZm9yIChsZXQgaG9wID0gMDsgaG9wIDw9IE1BWF9SRURJUkVDVFM7IGhvcCsrKSB7XG4gICAgYXdhaXQgYXNzZXJ0VXJsQWxsb3dlZChjdXJyZW50VXJsKTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGN1cnJlbnRVcmwsIHtcbiAgICAgIHNpZ25hbCxcbiAgICAgIHJlZGlyZWN0OiAnbWFudWFsJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ1VzZXItQWdlbnQnOiAnTW96aWxsYS81LjAgKGNvbXBhdGlibGU7IEFJU3R1ZGlvQm90LzEuMDsgK2h0dHBzOi8vYWlzdHVkaW8ucHNkNDAxLmFpKScsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGlzUmVkaXJlY3QgPSByZXNwb25zZS5zdGF0dXMgPj0gMzAwICYmIHJlc3BvbnNlLnN0YXR1cyA8IDQwMDtcbiAgICBjb25zdCBsb2NhdGlvbiA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdsb2NhdGlvbicpO1xuICAgIGlmIChpc1JlZGlyZWN0ICYmIGxvY2F0aW9uKSB7XG4gICAgICBjdXJyZW50VXJsID0gbmV3IFVSTChsb2NhdGlvbiwgY3VycmVudFVybCkudG9TdHJpbmcoKTsgLy8gcmVzb2x2ZSByZWxhdGl2ZSBMb2NhdGlvblxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoYFRvbyBtYW55IHJlZGlyZWN0cyAoPiAke01BWF9SRURJUkVDVFN9KWApO1xufVxuXG4vLyBGZXRjaCBhbmQgZXh0cmFjdCB0ZXh0IGNvbnRlbnQgZnJvbSBVUkxcbmFzeW5jIGZ1bmN0aW9uIGZldGNoQW5kRXh0cmFjdENvbnRlbnQodXJsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICB0cnkge1xuICAgIC8vIENyZWF0ZSBhbiBBYm9ydENvbnRyb2xsZXIgZm9yIHRpbWVvdXRcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgMzAwMDApOyAvLyAzMCBzZWNvbmRzXG5cbiAgICB0cnkge1xuICAgICAgLy8gRmV0Y2ggdGhlIFVSTCB3aXRoIGEgdGltZW91dCAoU1NSRi12YWxpZGF0ZWQgb24gZXZlcnkgaG9wIOKAlCBSRVYtQ09SLTQzNClcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc2FmZUZldGNoKHVybCwgY29udHJvbGxlci5zaWduYWwpO1xuXG4gICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG5cbiAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQIGVycm9yISBzdGF0dXM6ICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBjb250ZW50VHlwZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJztcbiAgICAgIGNvbnN0IGh0bWwgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG5cbiAgICAgIC8vIFBhcnNlIEhUTUwgYW5kIGV4dHJhY3QgdGV4dFxuICAgICAgY29uc3QgJCA9IGNoZWVyaW8ubG9hZChodG1sKTtcblxuICAgICAgLy8gUmVtb3ZlIHNjcmlwdCBhbmQgc3R5bGUgZWxlbWVudHNcbiAgICAgICQoJ3NjcmlwdCwgc3R5bGUsIG5vc2NyaXB0JykucmVtb3ZlKCk7XG5cbiAgICAgIC8vIFRyeSB0byBmaW5kIG1haW4gY29udGVudCBhcmVhc1xuICAgICAgbGV0IGNvbnRlbnQgPSAnJztcbiAgICBcbiAgICAgIC8vIENvbW1vbiBjb250ZW50IHNlbGVjdG9yc1xuICAgICAgY29uc3QgY29udGVudFNlbGVjdG9ycyA9IFtcbiAgICAgICdtYWluJyxcbiAgICAgICdhcnRpY2xlJyxcbiAgICAgICdbcm9sZT1cIm1haW5cIl0nLFxuICAgICAgJy5jb250ZW50JyxcbiAgICAgICcjY29udGVudCcsXG4gICAgICAnLnBvc3QnLFxuICAgICAgJy5lbnRyeS1jb250ZW50JyxcbiAgICAgICcuYXJ0aWNsZS1jb250ZW50JyxcbiAgICBdO1xuXG4gICAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIGNvbnRlbnRTZWxlY3RvcnMpIHtcbiAgICAgICAgY29uc3QgZWxlbWVudCA9ICQoc2VsZWN0b3IpO1xuICAgICAgICBpZiAoZWxlbWVudC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29udGVudCA9IGVsZW1lbnQudGV4dCgpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIElmIG5vIHNwZWNpZmljIGNvbnRlbnQgYXJlYSBmb3VuZCwgZ2V0IGFsbCB0ZXh0XG4gICAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgICAgY29udGVudCA9ICQoJ2JvZHknKS50ZXh0KCk7XG4gICAgICB9XG5cbiAgICAgIC8vIENsZWFuIHVwIHRoZSB0ZXh0XG4gICAgICBjb250ZW50ID0gY29udGVudFxuICAgICAgLnJlcGxhY2UoL1xccysvZywgJyAnKSAvLyBSZXBsYWNlIG11bHRpcGxlIHdoaXRlc3BhY2Ugd2l0aCBzaW5nbGUgc3BhY2VcbiAgICAgIC5yZXBsYWNlKC9cXG57Myx9L2csICdcXG5cXG4nKSAvLyBSZXBsYWNlIG11bHRpcGxlIG5ld2xpbmVzIHdpdGggZG91YmxlIG5ld2xpbmVcbiAgICAgIC50cmltKCk7XG5cbiAgICAgIC8vIElmIGNvbnRlbnQgaXMgbWFya2Rvd24gb3IgaGFzIG1hcmtkb3duLWxpa2UgY29udGVudCwgcHJvY2VzcyBpdFxuICAgICAgaWYgKGNvbnRlbnRUeXBlLmluY2x1ZGVzKCdtYXJrZG93bicpIHx8IHVybC5lbmRzV2l0aCgnLm1kJykpIHtcbiAgICAgICAgY29uc3QgaHRtbENvbnRlbnQgPSBhd2FpdCBtYXJrZWQucGFyc2UoY29udGVudCk7XG4gICAgICAgIGNvbnRlbnQgPSBodG1sQ29udGVudC5yZXBsYWNlKC88W14+XSo+L2csICcnKS50cmltKCk7XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgbWV0YWRhdGFcbiAgICAgIGNvbnN0IHRpdGxlID0gJCgndGl0bGUnKS50ZXh0KCkgfHwgJCgnaDEnKS5maXJzdCgpLnRleHQoKSB8fCAnJztcbiAgICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gJCgnbWV0YVtuYW1lPVwiZGVzY3JpcHRpb25cIl0nKS5hdHRyKCdjb250ZW50JykgfHwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgJCgnbWV0YVtwcm9wZXJ0eT1cIm9nOmRlc2NyaXB0aW9uXCJdJykuYXR0cignY29udGVudCcpIHx8ICcnO1xuXG4gICAgICAvLyBQcmVwZW5kIG1ldGFkYXRhIHRvIGNvbnRlbnRcbiAgICAgIGlmICh0aXRsZSkge1xuICAgICAgICBjb250ZW50ID0gYFRpdGxlOiAke3RpdGxlfVxcblxcbiR7Y29udGVudH1gO1xuICAgICAgfVxuICAgICAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgICAgIGNvbnRlbnQgPSBgRGVzY3JpcHRpb246ICR7ZGVzY3JpcHRpb259XFxuXFxuJHtjb250ZW50fWA7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBjb250ZW50O1xuICAgIH0gY2F0Y2ggKGZldGNoRXJyb3I6IGFueSkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgaWYgKGZldGNoRXJyb3IubmFtZSA9PT0gJ0Fib3J0RXJyb3InKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUmVxdWVzdCB0aW1lb3V0IGFmdGVyIDMwIHNlY29uZHMnKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGZldGNoRXJyb3I7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGZldGNoaW5nIFVSTDonLCBlcnJvcik7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZmV0Y2ggVVJMOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InfWApO1xuICB9XG59XG5cbi8vIEludGVsbGlnZW50IHRleHQgY2h1bmtpbmcgKHNhbWUgYXMgZmlsZSBwcm9jZXNzb3IpXG4vLyBFeHBvcnRlZCBmb3IgdW5pdCB0ZXN0aW5nIChSRVYtSU5GUkEtMTM1IGxpbmVTdGFydCB0ZXN0KS5cbmV4cG9ydCBmdW5jdGlvbiBjaHVua1RleHQodGV4dDogc3RyaW5nLCBtYXhDaHVua1NpemU6IG51bWJlciA9IDIwMDApOiBDaHVua0RhdGFbXSB7XG4gIGNvbnN0IGNodW5rczogQ2h1bmtEYXRhW10gPSBbXTtcbiAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KCdcXG4nKTtcbiAgbGV0IGN1cnJlbnRDaHVuayA9ICcnO1xuICBsZXQgbGluZVN0YXJ0ID0gMDsgICAgICAgICAgICAvLyBzb3VyY2UgbGluZSB3aGVyZSB0aGUgY3VycmVudCBjaHVuayBiZWdpbnNcbiAgbGV0IGN1cnJlbnRDaHVua0xpbmVzID0gMDsgICAgLy8gbnVtYmVyIG9mIGxpbmVzIGFjY3VtdWxhdGVkIGludG8gdGhlIGN1cnJlbnQgY2h1bmtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAoKGN1cnJlbnRDaHVuayArIGxpbmUpLmxlbmd0aCA+IG1heENodW5rU2l6ZSAmJiBjdXJyZW50Q2h1bmsubGVuZ3RoID4gMCkge1xuICAgICAgY2h1bmtzLnB1c2goe1xuICAgICAgICBjb250ZW50OiBjdXJyZW50Q2h1bmsudHJpbSgpLFxuICAgICAgICBtZXRhZGF0YTogeyBsaW5lU3RhcnQgfSxcbiAgICAgICAgY2h1bmtJbmRleDogY2h1bmtzLmxlbmd0aCxcbiAgICAgICAgdG9rZW5zOiBNYXRoLmNlaWwoY3VycmVudENodW5rLmxlbmd0aCAvIDQpLCAvLyBSb3VnaCB0b2tlbiBlc3RpbWF0ZVxuICAgICAgfSk7XG4gICAgICBsaW5lU3RhcnQgKz0gY3VycmVudENodW5rTGluZXM7IC8vIG5leHQgY2h1bmsgc3RhcnRzIGFmdGVyIHRoZSBmbHVzaGVkIGxpbmVzXG4gICAgICBjdXJyZW50Q2h1bmsgPSBsaW5lICsgJ1xcbic7XG4gICAgICBjdXJyZW50Q2h1bmtMaW5lcyA9IDE7XG4gICAgfSBlbHNlIHtcbiAgICAgIGN1cnJlbnRDaHVuayArPSBsaW5lICsgJ1xcbic7XG4gICAgICBjdXJyZW50Q2h1bmtMaW5lcysrO1xuICAgIH1cbiAgfVxuXG4gIGlmIChjdXJyZW50Q2h1bmsudHJpbSgpLmxlbmd0aCA+IDApIHtcbiAgICBjaHVua3MucHVzaCh7XG4gICAgICBjb250ZW50OiBjdXJyZW50Q2h1bmsudHJpbSgpLFxuICAgICAgbWV0YWRhdGE6IHsgbGluZVN0YXJ0IH0sXG4gICAgICBjaHVua0luZGV4OiBjaHVua3MubGVuZ3RoLFxuICAgICAgdG9rZW5zOiBNYXRoLmNlaWwoY3VycmVudENodW5rLmxlbmd0aCAvIDQpLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGNodW5rcztcbn1cblxuLy8gU3RvcmUgY2h1bmtzIGluIGRhdGFiYXNlXG4vLyBUYXJnZXRzIHJlcG9zaXRvcnlfaXRlbV9jaHVua3Mg4oCUIHRoZSBrbm93bGVkZ2UtcmVwb3NpdG9yeSBjaHVuayB0YWJsZSB0aGF0IGhhc1xuLy8gaXRlbV9pZC90b2tlbnMgY29sdW1ucyAobWF0Y2hpbmcgdGV4dHJhY3QtcHJvY2Vzc29yKS4gVGhlIGxlZ2FjeSB0YWJsZSB0aGlzIHVzZWRcbi8vIHRvIHBvaW50IGF0IGhhZCBuZWl0aGVyIGNvbHVtbiwgc28gZXZlcnkgaW5zZXJ0IGZhaWxlZCAoUkVWLUlORlJBLTEyMSkuXG4vLyBFeHBvcnRlZCBmb3IgdW5pdCB0ZXN0aW5nLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0b3JlQ2h1bmtzKGl0ZW1JZDogbnVtYmVyLCBjaHVua3M6IENodW5rRGF0YVtdKSB7XG4gIGlmIChjaHVua3MubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgLy8gRmlyc3QsIGRlbGV0ZSBleGlzdGluZyBjaHVua3MgZm9yIHRoaXMgaXRlbVxuICBhd2FpdCByZHNDbGllbnQuc2VuZChcbiAgICBuZXcgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQoe1xuICAgICAgcmVzb3VyY2VBcm46IERBVEFCQVNFX1JFU09VUkNFX0FSTixcbiAgICAgIHNlY3JldEFybjogREFUQUJBU0VfU0VDUkVUX0FSTixcbiAgICAgIGRhdGFiYXNlOiBEQVRBQkFTRV9OQU1FLFxuICAgICAgc3FsOiAnREVMRVRFIEZST00gcmVwb3NpdG9yeV9pdGVtX2NodW5rcyBXSEVSRSBpdGVtX2lkID0gOml0ZW1JZCcsXG4gICAgICBwYXJhbWV0ZXJzOiBbY3JlYXRlU3FsUGFyYW1ldGVyKCdpdGVtSWQnLCBpdGVtSWQpXSxcbiAgICB9KVxuICApO1xuICBcbiAgLy8gQmF0Y2ggaW5zZXJ0IG5ldyBjaHVua3NcbiAgY29uc3QgcGFyYW1ldGVyU2V0czogU3FsUGFyYW1ldGVyW11bXSA9IGNodW5rcy5tYXAoY2h1bmsgPT4gW1xuICAgIGNyZWF0ZVNxbFBhcmFtZXRlcignaXRlbUlkJywgaXRlbUlkKSxcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ2NvbnRlbnQnLCBjaHVuay5jb250ZW50KSxcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ21ldGFkYXRhJywgSlNPTi5zdHJpbmdpZnkoY2h1bmsubWV0YWRhdGEpKSxcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ2NodW5rSW5kZXgnLCBjaHVuay5jaHVua0luZGV4KSxcbiAgICBjcmVhdGVTcWxQYXJhbWV0ZXIoJ3Rva2VucycsIGNodW5rLnRva2VucyA/PyBudWxsKSxcbiAgXSk7XG4gIFxuICAvLyBCYXRjaEV4ZWN1dGVTdGF0ZW1lbnQgaGFzIGEgbGltaXQgb2YgMjUgcGFyYW1ldGVyIHNldHNcbiAgY29uc3QgYmF0Y2hTaXplID0gMjU7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcGFyYW1ldGVyU2V0cy5sZW5ndGg7IGkgKz0gYmF0Y2hTaXplKSB7XG4gICAgY29uc3QgYmF0Y2ggPSBwYXJhbWV0ZXJTZXRzLnNsaWNlKGksIGkgKyBiYXRjaFNpemUpO1xuICAgIFxuICAgIGF3YWl0IHJkc0NsaWVudC5zZW5kKFxuICAgICAgbmV3IEJhdGNoRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQoe1xuICAgICAgICByZXNvdXJjZUFybjogREFUQUJBU0VfUkVTT1VSQ0VfQVJOLFxuICAgICAgICBzZWNyZXRBcm46IERBVEFCQVNFX1NFQ1JFVF9BUk4sXG4gICAgICAgIGRhdGFiYXNlOiBEQVRBQkFTRV9OQU1FLFxuICAgICAgICBzcWw6IGBJTlNFUlQgSU5UTyByZXBvc2l0b3J5X2l0ZW1fY2h1bmtzXG4gICAgICAgICAgICAgIChpdGVtX2lkLCBjb250ZW50LCBtZXRhZGF0YSwgY2h1bmtfaW5kZXgsIHRva2VucylcbiAgICAgICAgICAgICAgVkFMVUVTICg6aXRlbUlkLCA6Y29udGVudCwgOm1ldGFkYXRhOjpqc29uYiwgOmNodW5rSW5kZXgsIDp0b2tlbnMpYCxcbiAgICAgICAgcGFyYW1ldGVyU2V0czogYmF0Y2gsXG4gICAgICB9KVxuICAgICk7XG4gIH1cbn1cblxuLy8gUHJvY2VzcyBhIFVSTFxuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc1VSTChqb2I6IFVSTFByb2Nlc3NpbmdKb2IpIHtcbiAgY29uc29sZS5sb2coYFByb2Nlc3NpbmcgVVJMOiAke2pvYi51cmx9IGZvciBpdGVtOiAke2pvYi5pdGVtTmFtZX1gKTtcbiAgXG4gIHRyeSB7XG4gICAgLy8gVXBkYXRlIHN0YXR1cyB0byBwcm9jZXNzaW5nXG4gICAgYXdhaXQgdXBkYXRlSXRlbVN0YXR1cyhqb2IuaXRlbUlkLCAncHJvY2Vzc2luZycpO1xuICAgIGF3YWl0IHVwZGF0ZUpvYlN0YXR1cyhqb2Iuam9iSWQsICdwcm9jZXNzaW5nJywgeyB1cmw6IGpvYi51cmwgfSk7XG4gICAgXG4gICAgLy8gRmV0Y2ggYW5kIGV4dHJhY3QgY29udGVudCBmcm9tIFVSTFxuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBmZXRjaEFuZEV4dHJhY3RDb250ZW50KGpvYi51cmwpO1xuICAgIFxuICAgIGlmICghY29udGVudCB8fCBjb250ZW50LnRyaW0oKS5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gY29udGVudCBleHRyYWN0ZWQgZnJvbSBVUkwnKTtcbiAgICB9XG4gICAgXG4gICAgLy8gQ2h1bmsgdGV4dFxuICAgIGNvbnN0IGNodW5rcyA9IGNodW5rVGV4dChjb250ZW50KTtcbiAgICBjb25zb2xlLmxvZyhgRXh0cmFjdGVkICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZyb20gJHtqb2IudXJsfWApO1xuICAgIFxuICAgIC8vIFN0b3JlIGNodW5rc1xuICAgIGF3YWl0IHN0b3JlQ2h1bmtzKGpvYi5pdGVtSWQsIGNodW5rcyk7XG4gICAgXG4gICAgLy8gVXBkYXRlIHN0YXR1cyB0byBjb21wbGV0ZWRcbiAgICBhd2FpdCB1cGRhdGVJdGVtU3RhdHVzKGpvYi5pdGVtSWQsICdjb21wbGV0ZWQnKTtcbiAgICBhd2FpdCB1cGRhdGVKb2JTdGF0dXMoam9iLmpvYklkLCAnY29tcGxldGVkJywge1xuICAgICAgdXJsOiBqb2IudXJsLFxuICAgICAgY2h1bmtzQ3JlYXRlZDogY2h1bmtzLmxlbmd0aCxcbiAgICAgIHRvdGFsVG9rZW5zOiBjaHVua3MucmVkdWNlKChzdW0sIGNodW5rKSA9PiBzdW0gKyAoY2h1bmsudG9rZW5zIHx8IDApLCAwKSxcbiAgICB9KTtcbiAgICBcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBwcm9jZXNzaW5nIFVSTCAke2pvYi51cmx9OmAsIGVycm9yKTtcbiAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICdVbmtub3duIGVycm9yJztcbiAgICBcbiAgICBhd2FpdCB1cGRhdGVJdGVtU3RhdHVzKGpvYi5pdGVtSWQsICdmYWlsZWQnLCBlcnJvck1lc3NhZ2UpO1xuICAgIGF3YWl0IHVwZGF0ZUpvYlN0YXR1cyhqb2Iuam9iSWQsICdmYWlsZWQnLCB7IHVybDogam9iLnVybCB9LCBlcnJvck1lc3NhZ2UpO1xuICAgIFxuICAgIHRocm93IGVycm9yOyAvLyBSZS10aHJvdyB0byBsZXQgTGFtYmRhIGhhbmRsZSByZXRyeSBsb2dpY1xuICB9XG59XG5cbi8vIExhbWJkYSBoYW5kbGVyIC0gY2FuIGJlIGludm9rZWQgZGlyZWN0bHkgKGFzeW5jL2V2ZW50KSBvciB2aWEgQVBJIEdhdGV3YXkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQgfCBVUkxQcm9jZXNzaW5nSm9iKSB7XG4gIGNvbnNvbGUubG9nKCdSZWNlaXZlZCBldmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuXG4gIC8vIERpcmVjdC9hc3luYyBpbnZvY2F0aW9uIChldmVudCBzb3VyY2UsIEludm9jYXRpb25UeXBlPUV2ZW50LCBTTlMvRXZlbnRCcmlkZ2UvUzMpLlxuICAvLyBMZXQgcHJvY2Vzc1VSTCBlcnJvcnMgcHJvcGFnYXRlIG91dCBvZiB0aGUgaGFuZGxlciBzbyBMYW1iZGEgbWFya3MgdGhlIGludm9jYXRpb25cbiAgLy8gZmFpbGVkIGFuZCBhcHBsaWVzIGl0cyByZXRyeSAvIG9uLWZhaWx1cmUgZGVzdGluYXRpb24gLyBETFEgbWFjaGluZXJ5LiBSZXR1cm5pbmcgYVxuICAvLyA1MDAtc2hhcGVkIG9iamVjdCBoZXJlIHdvdWxkIGJlIHJlY29yZGVkIGJ5IExhbWJkYSBhcyBhIFNVQ0NFU1MgYW5kIHNpbGVudGx5IGRyb3BcbiAgLy8gdGhlIHJldHJ5IChSRVYtQ09SLTQzNSkuIHByb2Nlc3NVUkwgcmVjb3JkcyAnZmFpbGVkJyBzdGF0dXMgYmVmb3JlIGl0IHJlLXRocm93cy5cbiAgaWYgKCdqb2JJZCcgaW4gZXZlbnQgJiYgJ2l0ZW1JZCcgaW4gZXZlbnQgJiYgJ3VybCcgaW4gZXZlbnQpIHtcbiAgICBhd2FpdCBwcm9jZXNzVVJMKGV2ZW50IGFzIFVSTFByb2Nlc3NpbmdKb2IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG1lc3NhZ2U6ICdVUkwgcHJvY2Vzc2VkIHN1Y2Nlc3NmdWxseScgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEFQSSBHYXRld2F5IGludm9jYXRpb24g4oCUIHJldHVybiBIVFRQLXNoYXBlZCByZXNwb25zZXMgKGluY2x1ZGluZyA0eHgvNXh4KS5cbiAgdHJ5IHtcbiAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoZXZlbnQgYXMgQVBJR2F0ZXdheVByb3h5RXZlbnQpLmJvZHkgfHwgJ3t9Jyk7XG5cbiAgICBpZiAoIWJvZHkuam9iSWQgfHwgIWJvZHkuaXRlbUlkIHx8ICFib2R5LnVybCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWlzc2luZyByZXF1aXJlZCBmaWVsZHM6IGpvYklkLCBpdGVtSWQsIHVybCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGF3YWl0IHByb2Nlc3NVUkwoYm9keSBhcyBVUkxQcm9jZXNzaW5nSm9iKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG1lc3NhZ2U6ICdVUkwgcHJvY2Vzc2luZyBzdGFydGVkJyB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0hhbmRsZXIgZXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICdVbmtub3duIGVycm9yJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cbn0iXX0=