/**
 * @jest-environment node
 *
 * GET /api/nexus/documents/[...key] — authenticated download (Issue #1898).
 *
 * The load-bearing property is access control: a generated file is delivered by
 * this route rather than a presigned S3 URL precisely so ownership is re-checked
 * on every request. The central case here is a SECOND user asking for another
 * user's document and getting 404 — not 403, which would confirm the file
 * exists, and not the bytes.
 *
 * Uses the global `jest` (NOT `import { jest } from '@jest/globals'`) so
 * jest.mock hoisting works.
 */

const getServerSessionMock = jest.fn();
const getCurrentUserMock = jest.fn();
const getConversationByIdMock = jest.fn();
const s3SendMock = jest.fn();

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => getServerSessionMock(),
}));
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: () => getCurrentUserMock(),
}));
jest.mock("@/lib/db/drizzle", () => ({
  getConversationById: (...args: unknown[]) => getConversationByIdMock(...args),
}));
// `next/server`'s NextResponse is not constructible under jest's node
// environment ("NextResponse is not a constructor"), only its static `json`
// helper works — so the streaming success path cannot be exercised against the
// real class. Subclassing the platform `Response` keeps real header, status and
// body semantics, which is what these assertions are about. Same approach as
// tests/unit/atrium-content-asset-bytes-route.test.ts.
jest.mock("next/server", () => {
  class MockNextResponse extends Response {
    static json(
      data: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ): Response {
      return new MockNextResponse(JSON.stringify(data), {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});
jest.mock("@/lib/settings-manager", () => ({
  Settings: { getS3: jest.fn().mockResolvedValue({ region: "us-west-2" }) },
}));
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3SendMock;
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { GET } from "@/app/api/nexus/documents/[...key]/route";

const OWNER_ID = 42;
const OTHER_USER_ID = 7;
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
const KEY_PARTS = [
  "v2",
  "nexus-documents",
  CONVERSATION_ID,
  "req123",
  "staff-newsletter.docx",
];

function request(): Request {
  return new Request("https://studio.example/api/nexus/documents/x");
}

function call(keyParts: string[] = KEY_PARTS) {
  // The route only reads `params`; the request object is unused.
  return GET(request() as never, {
    params: Promise.resolve({ key: keyParts }),
  });
}

/**
 * Read a response body stream to a Buffer. The jest node environment's
 * `Response` stub exposes only `json`/`text`, not `arrayBuffer`, so the stream
 * the route piped through is drained directly.
 */
async function drain(
  body: ReadableStream<Uint8Array> | null
): Promise<Buffer> {
  expect(body).not.toBeNull();
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** An S3 body that exposes the web stream the route reads. */
function s3Body(bytes: Buffer) {
  return {
    ContentLength: bytes.length,
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        }),
    },
  };
}

function signedInAs(userId: number): void {
  getServerSessionMock.mockResolvedValue({ sub: `cognito-${userId}` });
  getCurrentUserMock.mockResolvedValue({
    isSuccess: true,
    data: { user: { id: userId } },
  });
}

describe("GET /api/nexus/documents/[...key]", () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getCurrentUserMock.mockReset();
    getConversationByIdMock.mockReset();
    s3SendMock.mockReset();
    process.env.DOCUMENTS_BUCKET_NAME = "test-documents-bucket";
  });

  it("serves the file to the conversation owner as an attachment", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({
      id: CONVERSATION_ID,
      userId: OWNER_ID,
    });
    const bytes = Buffer.from("PK\u0003\u0004docx-bytes");
    s3SendMock.mockResolvedValue(s3Body(bytes));

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    // The saved name is the one the card advertises. The request id is its own
    // key segment, so it never leaks into the filename the browser writes.
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="staff-newsletter.docx"'
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await drain(response.body)).toEqual(bytes);
    expect(getConversationByIdMock).toHaveBeenCalledWith(
      CONVERSATION_ID,
      OWNER_ID
    );
  });

  it("returns 404 — not the bytes — to a different signed-in user", async () => {
    signedInAs(OTHER_USER_ID);
    // The real accessor filters on user_id, so a conversation owned by someone
    // else comes back null.
    getConversationByIdMock.mockResolvedValue(null);
    s3SendMock.mockResolvedValue(s3Body(Buffer.from("secret")));

    const response = await call();

    expect(response.status).toBe(404);
    // 404 rather than 403: a 403 would confirm the document exists.
    await expect(response.json()).resolves.toEqual({ error: "Not Found" });
    // The object must never be read for a caller who failed the gate.
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(getConversationByIdMock).toHaveBeenCalledWith(
      CONVERSATION_ID,
      OTHER_USER_ID
    );
  });

  it("returns 401 with no session and never touches the database or S3", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expect(getConversationByIdMock).not.toHaveBeenCalled();
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the session resolves to no application user", async () => {
    getServerSessionMock.mockResolvedValue({ sub: "cognito-unknown" });
    getCurrentUserMock.mockResolvedValue({ isSuccess: false });

    const response = await call();

    expect(response.status).toBe(401);
    expect(getConversationByIdMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreign prefix", ["v2", "generated-documents", "42", "doc.txt"]],
    ["path traversal", ["v2", "nexus-documents", CONVERSATION_ID, "..", "..", "secret.txt"]],
    ["a non-UUID conversation segment", ["v2", "nexus-documents", "all", "req123", "doc.txt"]],
    ["the legacy request-id-prefixed basename", ["v2", "nexus-documents", CONVERSATION_ID, "req123-doc.txt"]],
    ["an extra path segment", ["v2", "nexus-documents", CONVERSATION_ID, "req123", "nested", "doc.txt"]],
    ["traversal in the request segment", ["v2", "nexus-documents", CONVERSATION_ID, "..", "doc.txt"]],
    ["a dot in the request segment", ["v2", "nexus-documents", CONVERSATION_ID, "req.123", "doc.txt"]],
    ["no extension", ["v2", "nexus-documents", CONVERSATION_ID, "req123", "doc"]],
    ["an empty key", []],
  ])("returns 404 for %s before any lookup", async (_label, keyParts) => {
    signedInAs(OWNER_ID);

    const response = await call(keyParts as string[]);

    expect(response.status).toBe(404);
    // Key validation runs before the DB and S3, so a malformed key costs nothing.
    expect(getConversationByIdMock).not.toHaveBeenCalled();
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the owner's object is gone from the bucket", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({ id: CONVERSATION_ID });
    const missing = new Error("The specified key does not exist.");
    missing.name = "NoSuchKey";
    s3SendMock.mockRejectedValue(missing);

    const response = await call();

    expect(response.status).toBe(404);
  });

  it("returns 502 for an unexpected storage failure", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({ id: CONVERSATION_ID });
    s3SendMock.mockRejectedValue(new Error("connection reset"));

    const response = await call();

    expect(response.status).toBe(502);
    // The upstream message must not be echoed to the caller.
    await expect(response.json()).resolves.toEqual({
      error: "Failed to download the file",
    });
  });

  it("refuses an object larger than the serving cap", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({ id: CONVERSATION_ID });
    s3SendMock.mockResolvedValue({
      ContentLength: 51 * 1024 * 1024,
      Body: { transformToWebStream: () => new ReadableStream() },
    });

    const response = await call();

    expect(response.status).toBe(413);
  });

  it("serves a generated .html as text/plain, never as executable HTML", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({ id: CONVERSATION_ID });
    s3SendMock.mockResolvedValue(
      s3Body(Buffer.from("<script>alert(1)</script>"))
    );

    const response = await call([
      "v2",
      "nexus-documents",
      CONVERSATION_ID,
      "req123",
      "page.html",
    ]);

    expect(response.status).toBe(200);
    // The body is model-authored; text/html from our own origin would run it.
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
  });

  it("returns 500 when the documents bucket is not configured", async () => {
    signedInAs(OWNER_ID);
    getConversationByIdMock.mockResolvedValue({ id: CONVERSATION_ID });
    delete process.env.DOCUMENTS_BUCKET_NAME;

    const response = await call();

    expect(response.status).toBe(500);
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});
