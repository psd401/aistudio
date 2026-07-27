// Mock Request before imports so tests can supply plain object bodies.
const mockRequest = class Request {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;

  constructor(url: string, init?: RequestInit) {
    this.url = url;
    this.method = init?.method || 'GET';
    this.headers = new Headers(init?.headers);
    this.body = init?.body;
  }

  async json() {
    if (typeof this.body === 'string') {
      try {
        return JSON.parse(this.body);
      } catch {
        throw new Error('Invalid JSON');
      }
    }
    return this.body;
  }
} as unknown as typeof Request;

function headerEntries(init?: HeadersInit): Array<[string, string]> {
  if (!init) return [];
  if (Array.isArray(init)) {
    return init.map(([name, value]) => [name, String(value)]);
  }
  if (typeof (init as Headers).forEach === 'function') {
    const entries: Array<[string, string]> = [];
    for (const [name, value] of (init as Headers).entries()) {
      entries.push([name, value]);
    }
    return entries;
  }
  return Object.entries(init).map(([name, value]) => [name, String(value)]);
}

const mockHeaders = class Headers {
  private readonly values = new Map<string, string>();

  constructor(init?: HeadersInit) {
    for (const [name, value] of headerEntries(init)) this.set(name, value);
  }

  entries(): MapIterator<[string, string]> {
    return this.values.entries();
  }

  forEach(
    callback: (value: string, name: string, headers: Headers) => void,
  ): void {
    for (const [name, value] of this.values) {
      callback(value, name, this as unknown as Headers);
    }
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this.values.set(name.toLowerCase(), String(value));
  }
} as unknown as typeof Headers;

interface ReadableBody {
  getReader: () => ReadableStreamDefaultReader<Uint8Array>;
}

function isReadableBody(body: unknown): body is ReadableBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    'getReader' in body &&
    typeof body.getReader === 'function'
  );
}

async function responseBodyText(body: unknown): Promise<string> {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (!isReadableBody(body)) return String(body);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

const mockResponse = class Response {
  readonly body: unknown;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new mockHeaders(init?.headers);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text()) as unknown;
  }

  async text(): Promise<string> {
    return responseBodyText(this.body);
  }
} as unknown as typeof Response;

global.Request = mockRequest;
global.Response = mockResponse;
global.Headers = mockHeaders;

// Mock NextResponse and NextRequest
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn().mockImplementation((data: unknown, init?: ResponseInit) => {
      const headers = new Headers(init?.headers);
      headers.set('content-type', 'application/json');
      return new mockResponse(JSON.stringify(data), { ...init, headers });
    })
  },
  NextRequest: mockRequest
}));
