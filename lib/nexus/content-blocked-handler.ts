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
 * @param response - The fetch Response to check
 * @param log - Logger instance for structured logging
 * @throws ContentBlockedFetchError if the response is a CONTENT_BLOCKED 400
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
  } catch (e) {
    // Re-throw ContentBlockedFetchError — only swallow JSON parse failures
    if (e instanceof ContentBlockedFetchError) {
      throw e
    }
    log.debug('Could not parse error response as JSON')
  }
}
