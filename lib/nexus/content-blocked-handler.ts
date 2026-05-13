import { toast } from 'sonner'

/**
 * Client-side error for content safety blocks.
 * Thrown from customFetch to prevent the AI SDK runtime from parsing
 * the non-streaming 400 response as a stream (which causes TypeError).
 *
 * Issue #860: Replaces the inline `isContentBlocked` sentinel pattern
 * with a proper typed class for `instanceof` checks.
 */
export class ContentBlockedFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentBlockedFetchError'
  }
}

/**
 * Client-side error for generic server-side validation failures (400).
 * Thrown from customFetch to prevent the AI SDK runtime from trying to
 * parse the non-streaming JSON error as a stream.
 */
export class ValidationFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationFetchError'
  }
}

interface ContentBlockedResponse {
  code: string
  error?: string
  categories?: string[]
  source?: string
}

/**
 * Handles CONTENT_BLOCKED responses in customFetch callbacks.
 *
 * Shows a user-friendly toast with the blocked categories, logs the event,
 * and throws ContentBlockedFetchError to stop the AI SDK runtime from
 * attempting to parse the non-streaming 400 JSON as a stream.
 *
 * Also handles generic 400 validation errors (e.g. Zod schema rejections)
 * by showing a toast and throwing ValidationFetchError so the runtime
 * does not attempt to parse the error JSON as a streaming response.
 *
 * @param response - The fetch Response to check
 * @param log - Logger instance for structured logging
 * @throws ContentBlockedFetchError if the response is a CONTENT_BLOCKED 400
 * @throws ValidationFetchError if the response is any other 400
 */
export async function handleContentBlockedResponse(
  response: Response,
  log: { warn: (msg: string, data?: Record<string, unknown>) => void; debug: (msg: string) => void }
): Promise<void> {
  if (response.status !== 400) return

  try {
    const clonedResponse = response.clone()
    const errorData: ContentBlockedResponse = await clonedResponse.json()
    if (errorData.code === 'CONTENT_BLOCKED') {
      const categories = Array.isArray(errorData.categories) && errorData.categories.length
        ? ` (${errorData.categories.join(', ')})`
        : ''
      toast.error('Content Blocked', {
        description: `Your message was flagged by the content safety filter${categories}. Try rephrasing your request.`,
        duration: 6000
      })
      log.warn('Content blocked by safety guardrails', {
        error: errorData.error,
        categories: errorData.categories,
        source: errorData.source,
      })
      throw new ContentBlockedFetchError(
        errorData.error || 'Content blocked by safety guardrails'
      )
    }

    // Generic validation error from the server (e.g. Zod schema rejection).
    // Throw so the AI SDK runtime does not try to parse JSON as a stream.
    log.warn('Server returned 400 validation error', { error: errorData.error })
    toast.error('Request error', {
      description: 'Your message could not be sent due to a validation error. Please try again.',
      duration: 5000,
    })
    throw new ValidationFetchError(errorData.error || 'Invalid request')
  } catch (e) {
    // Re-throw typed errors — only swallow JSON parse failures
    if (e instanceof ContentBlockedFetchError || e instanceof ValidationFetchError) {
      throw e
    }
    log.debug('Could not parse error response as JSON')
  }
}
