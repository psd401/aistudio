/**
 * Canva Connect API HTTP Client
 *
 * Thin wrapper around the Canva REST API (https://api.canva.com/rest).
 * Handles Bearer token auth, 429 rate limit retries, and async job polling.
 *
 * @see https://www.canva.dev/docs/connect/
 */

import { createLogger } from "@/lib/logger"

const log = createLogger({ module: "canva-api-client" })

const BASE_URL = "https://api.canva.com/rest"
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 1000
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 60_000

export interface CanvaApiError {
  code: string
  message: string
  status: number
}

export class CanvaApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "CanvaApiClientError"
    this.status = status
    this.code = code
  }
}

export class CanvaApiClient {
  private readonly accessToken: string

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  /**
   * Makes an authenticated GET request to the Canva API.
   */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value)
        }
      }
    }
    return this.request<T>("GET", url.toString())
  }

  /**
   * Makes an authenticated POST request to the Canva API.
   */
  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", `${BASE_URL}${path}`, body)
  }

  /**
   * Starts an async job (POST) and polls until completion.
   * Used for exports, imports, uploads, and autofills.
   *
   * @param startPath - POST endpoint to start the job
   * @param pollPath - GET endpoint to check job status (receives job ID appended)
   * @param body - Request body for the POST
   * @returns The final job result when status is "success"
   * @throws CanvaApiClientError if the job fails or times out
   */
  async startAndPollJob<T>(
    startPath: string,
    pollPathPrefix: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const startResult = await this.post<{ job: { id: string; status: string } }>(
      startPath,
      body
    )

    const jobId = startResult.job.id
    const pollUrl = `${pollPathPrefix}/${jobId}`
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let interval = POLL_INTERVAL_MS

    while (Date.now() < deadline) {
      await sleep(interval)

      const pollResult = await this.get<{ job: { id: string; status: string } & T }>(
        pollUrl
      )

      if (pollResult.job.status === "success") {
        return pollResult.job as unknown as T
      }

      if (pollResult.job.status === "failed") {
        throw new CanvaApiClientError(
          `Canva async job ${jobId} failed`,
          500,
          "JOB_FAILED"
        )
      }

      // Exponential backoff capped at 8s
      interval = Math.min(interval * 1.5, 8000)
    }

    throw new CanvaApiClientError(
      `Canva async job ${jobId} timed out after ${POLL_TIMEOUT_MS / 1000}s`,
      408,
      "JOB_TIMEOUT"
    )
  }

  /**
   * Core request method with retry logic for 429 rate limits.
   */
  private async request<T>(
    method: string,
    url: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        }

        const resp = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        })

        if (resp.status === 429) {
          // Materialize the rate-limit as lastError so an all-429 run throws a
          // 429-typed error rather than the generic "failed after retries" — the
          // 429 branch continues without ever entering the catch that sets
          // lastError, so without this the caller loses all rate-limit context
          // (REV-COR-627).
          lastError = new CanvaApiClientError(
            `Canva API rate limited (HTTP 429) after ${attempt + 1} attempt(s)`,
            429,
            "RATE_LIMITED"
          )

          // Retry-After is seconds-delta per RFC 7231, but proxies/gateways may send
          // an HTTP-date instead; parseInt alone yields NaN for a date and collapses
          // waitMs to 0, causing an immediate retry with no backoff.
          const retryAfter = resp.headers.get("Retry-After")
          let waitMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
          if (retryAfter) {
            const seconds = parseInt(retryAfter, 10)
            if (!Number.isNaN(seconds)) {
              waitMs = seconds * 1000
            } else {
              const dateMs = Date.parse(retryAfter)
              if (!Number.isNaN(dateMs)) {
                waitMs = Math.max(0, dateMs - Date.now())
              }
            }
          }

          log.warn("Canva API rate limited", {
            url,
            attempt: attempt + 1,
            waitMs,
          })

          // Skip the backoff on the terminal attempt — the loop is about to exit
          // and throw the recorded 429 error, so sleeping first only adds latency
          // to a call that has already failed (REV-COR-627).
          if (attempt < MAX_RETRIES - 1) {
            await sleep(waitMs)
          }
          continue
        }

        if (!resp.ok) {
          let errorBody: CanvaApiError | undefined
          try {
            errorBody = (await resp.json()) as CanvaApiError
          } catch {
            // Response body may not be JSON
          }

          throw new CanvaApiClientError(
            errorBody?.message ?? `Canva API error: HTTP ${resp.status}`,
            resp.status,
            errorBody?.code ?? `HTTP_${resp.status}`
          )
        }

        // Handle 204 No Content
        if (resp.status === 204) {
          return undefined as T
        }

        return (await resp.json()) as T
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        // Don't retry non-retryable errors
        if (err instanceof CanvaApiClientError && err.status !== 429) {
          throw err
        }

        if (attempt === MAX_RETRIES - 1) {
          throw lastError
        }
      }
    }

    throw lastError ?? new Error("Canva API request failed after retries")
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
