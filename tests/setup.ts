// Mock Request and Response before imports
const mockRequest = class Request {
  url: string;
  method: string;
  headers: Headers;
  body: any;

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
} as any;

const mockResponse = class Response {
  status: number;
  body: any;
  headers: Headers;

  constructor(body: any, init?: ResponseInit) {
    this.status = init?.status || 200;
    this.body = body;
    this.headers = new Headers(init?.headers);
  }

  json() {
    return this.body;
  }
} as any;

const mockHeaders = class Headers extends Map {
  constructor(_init?: HeadersInit) {
    super();
  }
} as any;

global.Request = mockRequest;
global.Response = mockResponse;
global.Headers = mockHeaders;

// Mock NextResponse and NextRequest
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn().mockImplementation((data, init) => {
      const response = new mockResponse(JSON.stringify(data), init);
      response.json = async () => data;
      return response;
    })
  },
  NextRequest: mockRequest
})); 