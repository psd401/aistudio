/** @jest-environment node */
/**
 * #1900 — a generated image must still render after a reload.
 *
 * Two independent causes are pinned here:
 *
 *  1. The reload path used to re-sign the image with `getDocumentSignedUrl`,
 *     which resolves its bucket from the database `S3_BUCKET` setting.
 *     Generated images are written to `DOCUMENTS_BUCKET_NAME`
 *     (`generated-image-bucket.ts` warns the two may differ), so on a
 *     mismatched deployment every reloaded image was signed against the wrong
 *     bucket. #1804 fixed this for the edit path only.
 *  2. Browsers were handed the raw presigned URL, which expires in an hour and
 *     fails intermittently with `InvalidToken`.
 *
 * Both are fixed by serving generated images through `/api/images/[...key]`,
 * which re-checks ownership and signs with the SAME resolver that stored them.
 */

const GENERATED_BUCKET = "psd-documents-bucket"
const SETTINGS_BUCKET = "some-other-settings-bucket"
const CONVERSATION_ID = "8a1b19b2-2c21-4a02-9e8d-8b2c0c2a61ff"
const OTHER_CONVERSATION_ID = "11111111-2222-3333-4444-555555555555"
const S3_KEY = `v2/generated-images/${CONVERSATION_ID}/1730000000000-gemini-3-1-flash-image.png`

const mockGetSignedUrl = jest.fn()
const mockGetServerSession = jest.fn()
const mockGetCurrentUserAction = jest.fn()
const mockGetConversationById = jest.fn()
const mockGetMessagesByConversation = jest.fn()
const mockGetMessageCount = jest.fn()
const mockGetDocumentSignedUrl = jest.fn()

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}))
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => mockGetServerSession(),
}))
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: () => mockGetCurrentUserAction(),
}))
jest.mock("@/lib/db/drizzle", () => ({
  getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
  getMessagesByConversation: (...args: unknown[]) =>
    mockGetMessagesByConversation(...args),
  getMessageCount: (...args: unknown[]) => mockGetMessageCount(...args),
  DEFAULT_MESSAGE_LIMIT: 50,
  MAX_MESSAGE_LIMIT: 100,
}))
jest.mock("@/lib/aws/s3-client", () => ({
  getDocumentSignedUrl: (...args: unknown[]) => mockGetDocumentSignedUrl(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "req-test",
  startTimer: () => () => undefined,
}))

import {
  generatedImageKeyPrefix,
  generatedImageProxyPath,
} from "@/lib/ai/generated-image-bucket"
import type { NextRequest } from "next/server"
import { GET as getImage } from "@/app/api/images/[...key]/route"
import { GET as getMessages } from "@/app/api/nexus/conversations/[id]/messages/route"

/**
 * jest's node environment supplies a `Response` without the static `json` and
 * `redirect` helpers these routes use. Installing them keeps real status,
 * header and body semantics, which is what the assertions below read.
 */
const ResponseCtor = Response as unknown as {
  json?: (data: unknown, init?: ResponseInit) => Response
  redirect?: (url: string, status?: number) => Response
}
if (typeof ResponseCtor.json !== "function") {
  ResponseCtor.json = (data, init) =>
    new Response(JSON.stringify(data), {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    })
}
if (typeof ResponseCtor.redirect !== "function") {
  ResponseCtor.redirect = (url, status = 302) =>
    new Response(null, { status, headers: { location: url } })
}

/** The routes under test read `req.url` and nothing else off the request. */
function request(url: string): NextRequest {
  return { url } as unknown as NextRequest
}

const originalDocumentsBucket = process.env.DOCUMENTS_BUCKET_NAME
const originalS3Bucket = process.env.S3_BUCKET

beforeEach(() => {
  jest.clearAllMocks()
  // The whole point: the two buckets DISAGREE.
  process.env.DOCUMENTS_BUCKET_NAME = GENERATED_BUCKET
  process.env.S3_BUCKET = SETTINGS_BUCKET
  mockGetSignedUrl.mockResolvedValue("https://s3.example.test/signed")
  mockGetServerSession.mockResolvedValue({ sub: "user-sub" })
  mockGetCurrentUserAction.mockResolvedValue({
    isSuccess: true,
    data: { user: { id: 7 } },
  })
  mockGetConversationById.mockResolvedValue({ id: CONVERSATION_ID, userId: 7 })
  mockGetMessageCount.mockResolvedValue(1)
  mockGetDocumentSignedUrl.mockResolvedValue(
    "https://s3.example.test/settings-bucket-signed",
  )
})

afterAll(() => {
  process.env.DOCUMENTS_BUCKET_NAME = originalDocumentsBucket
  process.env.S3_BUCKET = originalS3Bucket
})

/** The bucket the route asked S3 to sign against, read off the GetObjectCommand. */
function signedBucket(): string | undefined {
  const command = mockGetSignedUrl.mock.calls[0]?.[1] as
    | { input?: { Bucket?: string; Key?: string } }
    | undefined
  return command?.input?.Bucket
}

describe("generatedImageProxyPath", () => {
  it("points at the authenticated route, not a presigned S3 URL", () => {
    expect(generatedImageProxyPath(S3_KEY)).toBe(`/api/images/${S3_KEY}`)
  })

  it("encodes each segment so the catch-all route rejoins the exact key", () => {
    expect(generatedImageProxyPath("v2/generated-images/a b/c+d.png")).toBe(
      "/api/images/v2/generated-images/a%20b/c%2Bd.png",
    )
  })

  it("derives the prefix the ownership check re-validates against", () => {
    expect(generatedImageKeyPrefix(CONVERSATION_ID)).toBe(
      `v2/generated-images/${CONVERSATION_ID}/`,
    )
  })
})

describe("GET /api/images/[...key]", () => {
  it("signs against DOCUMENTS_BUCKET_NAME even when S3_BUCKET differs", async () => {
    const response = await getImage(
      request(`https://app.test/api/images/${S3_KEY}`),
      { params: Promise.resolve({ key: S3_KEY.split("/") }) },
    )

    expect(response.status).toBe(302)
    expect(signedBucket()).toBe(GENERATED_BUCKET)
    expect(signedBucket()).not.toBe(SETTINGS_BUCKET)
  })

  it("refuses a key belonging to another conversation", async () => {
    const foreignKey = `v2/generated-images/${OTHER_CONVERSATION_ID}/x.png`
    mockGetConversationById.mockResolvedValue(null)

    const response = await getImage(
      request(`https://app.test/api/images/${foreignKey}`),
      { params: Promise.resolve({ key: foreignKey.split("/") }) },
    )

    expect(response.status).toBe(404)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it("refuses an unauthenticated request before touching S3", async () => {
    mockGetServerSession.mockResolvedValue(null)

    const response = await getImage(
      request(`https://app.test/api/images/${S3_KEY}`),
      { params: Promise.resolve({ key: S3_KEY.split("/") }) },
    )

    expect(response.status).toBe(401)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })
})

describe("GET /api/nexus/conversations/[id]/messages", () => {
  function messageWithImage(part: Record<string, unknown>) {
    return [
      {
        id: "msg-1",
        role: "assistant",
        parts: [part],
        content: "",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        metadata: {},
      },
    ]
  }

  async function readFirstPartText(): Promise<string> {
    const response = await getMessages(
      request(
        `https://app.test/api/nexus/conversations/${CONVERSATION_ID}/messages`,
      ),
      { params: Promise.resolve({ id: CONVERSATION_ID }) },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      messages: Array<{ content: Array<{ text?: string }> }>
    }
    return body.messages[0].content[0].text ?? ""
  }

  it("re-points a reloaded generated image at the authenticated route", async () => {
    mockGetMessagesByConversation.mockResolvedValue(
      messageWithImage({
        type: "image",
        s3Key: S3_KEY,
        imageUrl: "https://s3.example.test/expired-presigned",
      }),
    )

    const text = await readFirstPartText()

    expect(text).toBe(`![Generated Image](${generatedImageProxyPath(S3_KEY)})`)
    // The settings-bucket resolver is the bug; it must not be consulted at all.
    expect(mockGetDocumentSignedUrl).not.toHaveBeenCalled()
  })

  it("keeps the stored URL for a legacy row that has no s3Key", async () => {
    mockGetMessagesByConversation.mockResolvedValue(
      messageWithImage({
        type: "image",
        imageUrl: "https://s3.example.test/legacy-presigned",
      }),
    )

    const text = await readFirstPartText()

    expect(text).toBe(
      "![Generated Image](https://s3.example.test/legacy-presigned)",
    )
  })

  it("never proxies a generated-image key from another conversation", async () => {
    mockGetMessagesByConversation.mockResolvedValue(
      messageWithImage({
        type: "image",
        s3Key: `v2/generated-images/${OTHER_CONVERSATION_ID}/leak.png`,
      }),
    )

    const text = await readFirstPartText()

    expect(text).toBe("")
    expect(mockGetDocumentSignedUrl).not.toHaveBeenCalled()
  })
})
