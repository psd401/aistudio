/**
 * Unit tests for lib/mcp/custom-tools/canva/canva-api-client.ts — REV-COR-627.
 *
 * When all retry attempts return HTTP 429, request() must throw a 429-typed
 * CanvaApiClientError (preserving rate-limit context) rather than the generic
 * "failed after retries", and it must NOT run a backoff sleep after the final
 * attempt. Non-429 error handling is unchanged (immediate throw, no retry).
 */

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

import {
  CanvaApiClient,
  CanvaApiClientError,
} from "@/lib/mcp/custom-tools/canva/canva-api-client"

// MAX_RETRIES is 3 in the client; a run that always 429s should sleep twice
// (before attempts 1 and 2) but not before the terminal throw.
const MAX_RETRIES = 3

function resp(status: number, body?: unknown, retryAfter?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === "Retry-After" ? retryAfter ?? null : null) },
    json: async () => body,
  } as unknown as Response
}

describe("CanvaApiClient.request — 429 exhaustion (REV-COR-627)", () => {
  let fetchMock: jest.Mock
  let setTimeoutSpy: jest.SpyInstance

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    // Count sleeps and resolve them immediately (no real backoff delay). sleep() is
    // the only setTimeout caller on this path once AbortSignal.timeout is stubbed.
    setTimeoutSpy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((cb: () => void) => {
        cb()
        return 0 as unknown as NodeJS.Timeout
      }) as unknown as typeof setTimeout)

    // Avoid the native AbortSignal.timeout timer so setTimeout counts only sleeps.
    jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("throws a 429-typed CanvaApiClientError after exhausting all attempts", async () => {
    fetchMock.mockResolvedValue(resp(429))
    const client = new CanvaApiClient("token")

    const err = (await client
      .get("/v1/assets/x")
      .catch((e) => e)) as CanvaApiClientError

    expect(err).toBeInstanceOf(CanvaApiClientError)
    expect(err.status).toBe(429)
    expect(err.code).toBe("RATE_LIMITED")
    expect(err.message).not.toMatch(/failed after retries/)
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES)
  })

  it("does not sleep after the final attempt (sleeps MAX_RETRIES - 1 times)", async () => {
    fetchMock.mockResolvedValue(resp(429))
    const client = new CanvaApiClient("token")

    await client.get("/v1/assets/x").catch(() => undefined)

    expect(setTimeoutSpy).toHaveBeenCalledTimes(MAX_RETRIES - 1)
  })

  it("recovers when a 429 is followed by a 200 (one sleep, parsed body)", async () => {
    fetchMock
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200, { id: "asset-1" }))
    const client = new CanvaApiClient("token")

    const result = await client.get<{ id: string }>("/v1/assets/x")

    expect(result).toEqual({ id: "asset-1" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  it("throws immediately on a non-429 error without retrying or sleeping", async () => {
    fetchMock.mockResolvedValue(resp(500, { message: "boom", code: "SERVER_ERROR" }))
    const client = new CanvaApiClient("token")

    const err = (await client
      .get("/v1/assets/x")
      .catch((e) => e)) as CanvaApiClientError

    expect(err).toBeInstanceOf(CanvaApiClientError)
    expect(err.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it("honors Retry-After on a non-terminal 429 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(resp(429, undefined, "2"))
      .mockResolvedValueOnce(resp(200, { ok: true }))
    const client = new CanvaApiClient("token")

    const result = await client.get<{ ok: boolean }>("/v1/assets/x")

    expect(result).toEqual({ ok: true })
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    // Retry-After: 2 → 2000ms passed to setTimeout.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000)
  })

  it("parses an HTTP-date Retry-After header (RFC 7231) instead of NaN-ing to an immediate retry", async () => {
    const retryAfterDate = new Date(Date.now() + 3000).toUTCString()
    fetchMock
      .mockResolvedValueOnce(resp(429, undefined, retryAfterDate))
      .mockResolvedValueOnce(resp(200, { ok: true }))
    const client = new CanvaApiClient("token")

    const result = await client.get<{ ok: boolean }>("/v1/assets/x")

    expect(result).toEqual({ ok: true })
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    const waitMs = setTimeoutSpy.mock.calls[0][1] as number
    // Must resolve to a real, positive delay derived from the date — not NaN (which
    // would collapse to an immediate 0ms retry per the pre-fix bug).
    expect(Number.isNaN(waitMs)).toBe(false)
    expect(waitMs).toBeGreaterThan(0)
    expect(waitMs).toBeLessThanOrEqual(3000)
  })
})
