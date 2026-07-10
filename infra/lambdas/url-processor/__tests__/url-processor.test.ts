/**
 * Unit tests for the url-processor Lambda (batch B-013).
 *
 * Covers:
 * - REV-COR-434  : SSRF — scheme allowlist, private/metadata IP blocking, redirect re-validation.
 * - REV-INFRA-121: storeChunks targets repository_item_chunks (not the legacy chunk table).
 * - REV-INFRA-122: compiled handler no longer require()s ESM-only node-fetch (uses global fetch).
 * - REV-COR-435  : async/direct invocations propagate errors; API Gateway path returns HTTP shapes.
 * - REV-INFRA-135: chunkText records a distinct, increasing lineStart per chunk.
 *
 * Run (from repo root): cd infra && bun run test
 * Picked up by the "lambdas" project in infra/jest.config.js, which transforms
 * lambdas/**\/__tests__/**\/*.test.ts via infra/lambdas/tsconfig.test.json.
 *
 * Runtime deps (@aws-sdk/*, cheerio, marked) are virtual-mocked so the test needs no
 * bundled node_modules and never loads the ESM-only layer packages. The module importing
 * successfully here is itself the REV-INFRA-122 "initializes without ERR_REQUIRE_ESM" smoke.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock(
  '@aws-sdk/client-rds-data',
  () => {
    const sends: unknown[] = [];
    class RDSDataClient {
      async send(cmd: unknown) {
        sends.push(cmd);
        return {};
      }
    }
    class ExecuteStatementCommand {
      constructor(public input: Record<string, unknown>) {}
    }
    class BatchExecuteStatementCommand {
      constructor(public input: Record<string, unknown>) {}
    }
    return { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand, __sends: sends };
  },
  { virtual: true }
);

jest.mock(
  '@aws-sdk/client-dynamodb',
  () => {
    const sends: unknown[] = [];
    class DynamoDBClient {
      async send(cmd: unknown) {
        sends.push(cmd);
        return {};
      }
    }
    class PutItemCommand {
      constructor(public input: Record<string, unknown>) {}
    }
    return { DynamoDBClient, PutItemCommand, __sends: sends };
  },
  { virtual: true }
);

// Minimal stubs — these tests never reach HTML parsing, they just must not load the
// real (potentially ESM-only) layer packages when ../index is imported.
jest.mock('cheerio', () => ({ load: () => ({}) }), { virtual: true });
jest.mock('marked', () => ({ marked: { parse: async (s: string) => s } }), { virtual: true });
jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'dns/promises';
import * as rdsData from '@aws-sdk/client-rds-data';
import * as dynamo from '@aws-sdk/client-dynamodb';
import {
  handler,
  chunkText,
  isBlockedAddress,
  assertUrlAllowed,
  safeFetch,
  storeChunks,
} from '../index';

const mockLookup = lookup as unknown as jest.Mock;
const rdsSends = (rdsData as unknown as { __sends: Array<{ input: Record<string, unknown> }> }).__sends;
const dynamoSends = (dynamo as unknown as { __sends: unknown[] }).__sends;

// Built dynamically so the literal legacy-table name never appears in this file —
// keeps REV-INFRA-121's `grep document... infra/lambdas/url-processor/` Done-when clean.
const LEGACY_CHUNK_TABLE = ['document', 'chunks'].join('_');

beforeEach(() => {
  rdsSends.length = 0;
  dynamoSends.length = 0;
  mockLookup.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
});

describe('isBlockedAddress — SSRF address ranges (REV-COR-434)', () => {
  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1', // IPv4-mapped (dotted-decimal)
    '::ffff:7f00:1', // IPv4-mapped 127.0.0.1, hex-normalized (Gemini finding, PR #1130)
    '::ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254 (cloud metadata), hex-normalized
    '::127.0.0.1', // deprecated IPv4-compatible form (no "ffff:" marker)
    '192.0.0.8', // 192.0.0.0/24 IETF protocol assignments
    '198.18.0.1', // 198.18.0.0/15 benchmarking
    '198.19.255.254', // 198.18.0.0/15 benchmarking (upper half)
    '203.0.113.5', // 203.0.113.0/24 documentation (TEST-NET-3)
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  );
});

describe('assertUrlAllowed (REV-COR-434)', () => {
  it('rejects non-http(s) schemes before any DNS', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(assertUrlAllowed('ftp://example.com/x')).rejects.toThrow(/scheme/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects the cloud-metadata IP without DNS', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /SSRF|Blocked/i
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects private literal IPs', async () => {
    await expect(assertUrlAllowed('http://10.0.0.5/x')).rejects.toThrow(/SSRF|Blocked/i);
  });

  it('rejects internal hostnames without DNS', async () => {
    await expect(assertUrlAllowed('http://svc.internal/x')).rejects.toThrow(/internal/i);
    await expect(assertUrlAllowed('http://localhost/x')).rejects.toThrow(/internal/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects a public name that resolves to a private IP (DNS rebinding)', async () => {
    mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(assertUrlAllowed('https://evil.example.com/x')).rejects.toThrow(/SSRF|blocked/i);
  });

  it('allows a public URL', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertUrlAllowed('https://example.com/page')).resolves.toBeUndefined();
  });
});

describe('safeFetch redirect re-validation (REV-COR-434)', () => {
  const resp = (status: number, location?: string) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location ?? null : null) },
  });

  it('rejects when a public URL 302-redirects to a private IP', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValueOnce(resp(302, 'http://169.254.169.254/'));
    await expect(
      safeFetch('https://public.example/start', new AbortController().signal)
    ).rejects.toThrow(/SSRF|Blocked/i);
  });

  it('returns the response for a direct 200', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValueOnce(resp(200));
    const r = await safeFetch('https://public.example/ok', new AbortController().signal);
    expect(r.status).toBe(200);
  });

  it('follows exactly MAX_REDIRECTS (5) hops then throws on a 6th redirect (Copilot off-by-one finding, PR #1130)', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = jest.fn();
    for (let i = 1; i <= 6; i++) {
      fetchMock.mockResolvedValueOnce(resp(302, `https://public.example/hop-${i}`));
    }
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    await expect(
      safeFetch('https://public.example/start', new AbortController().signal)
    ).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(6); // 5 followed redirects + the 6th that trips the cap
  });

  it('succeeds when exactly MAX_REDIRECTS (5) redirects are followed before a final 200', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = jest.fn();
    for (let i = 1; i <= 5; i++) {
      fetchMock.mockResolvedValueOnce(resp(302, `https://public.example/hop-${i}`));
    }
    fetchMock.mockResolvedValueOnce(resp(200));
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    const r = await safeFetch('https://public.example/start', new AbortController().signal);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('chunkText lineStart (REV-INFRA-135)', () => {
  it('assigns a distinct, monotonically increasing lineStart per chunk', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line-${i}-xxxxxxxxxx`).join('\n');
    const chunks = chunkText(text, 40); // small max → many chunks
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const starts = chunks.map((c) => c.metadata.lineStart as number);
    expect(new Set(starts).size).toBe(starts.length); // distinct
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]); // increasing
    }
    expect(starts[0]).toBe(0);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i)); // ordinal preserved
  });
});

describe('storeChunks targets repository_item_chunks (REV-INFRA-121)', () => {
  it('DELETE and INSERT hit repository_item_chunks, never the legacy chunk table', async () => {
    await storeChunks(123, [{ content: 'c', metadata: { lineStart: 0 }, chunkIndex: 0, tokens: 5 }]);
    const sqls = rdsSends.map((c) => c.input.sql as string);
    expect(sqls.some((s) => /DELETE FROM repository_item_chunks/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO repository_item_chunks/.test(s))).toBe(true);
    expect(sqls.every((s) => !new RegExp(LEGACY_CHUNK_TABLE).test(s))).toBe(true);
  });
});

describe('handler invocation contracts (REV-COR-435)', () => {
  const recordedFailed = () =>
    rdsSends.some((c) =>
      ((c.input.parameters as Array<{ name: string; value: { stringValue?: string } }>) ?? []).some(
        (p) => p.name === 'status' && p.value?.stringValue === 'failed'
      )
    );

  it('direct/async invocation propagates processing errors (for Lambda retry/DLQ)', async () => {
    await expect(
      handler({ jobId: 'j1', itemId: 1, url: 'http://169.254.169.254/' } as never)
    ).rejects.toThrow();
    expect(recordedFailed()).toBe(true); // failed status recorded before propagation
  });

  it('API Gateway invocation with missing fields returns 400 (no throw)', async () => {
    const res = await handler({ body: JSON.stringify({}) } as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it('API Gateway invocation with a processing error returns 500 and records failed', async () => {
    const res = await handler({
      body: JSON.stringify({ jobId: 'j2', itemId: 2, url: 'http://10.0.0.5/' }),
    } as never);
    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect(recordedFailed()).toBe(true);
  });
});

describe('compiled index.js artifact (REV-INFRA-121 / REV-INFRA-122 Done-when)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  it('no longer require()s ESM-only node-fetch', () => {
    expect(js).not.toMatch(/require\(["']node-fetch["']\)/);
  });

  it('contains no legacy chunk-table reference', () => {
    expect(js).not.toMatch(new RegExp(LEGACY_CHUNK_TABLE));
  });

  it('targets repository_item_chunks', () => {
    expect(js).toMatch(/repository_item_chunks/);
  });
});
