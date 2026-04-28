/**
 * Gemini Deep Research Service
 *
 * Wraps Google's Interactions API for agentic Deep Research models.
 *
 * Why a separate service: standard Gemini chat models are routed through
 * `@ai-sdk/google` → `generateContent`, but agents like
 * `deep-research-preview-04-2026` only run through Google's Interactions API
 * (a different endpoint, polled lifecycle, returns a final report instead of
 * a token stream). We can't reuse the existing GeminiAdapter — the request
 * body shape, error surface, and response shape are all different.
 *
 * Flow:
 *   1. `ai.interactions.create({ agent, input, background: true })` returns
 *      an Interaction object with status='in_progress' and an id.
 *   2. Poll `ai.interactions.get(id)` every POLL_INTERVAL_MS until status is
 *      terminal ('completed' | 'failed' | 'cancelled' | 'incomplete').
 *   3. On completed: extract text + URL citations from `outputs[]`.
 *   4. On failure: throw a domain error so the route renders a useful message.
 *
 * Cancellation: if the caller passes an AbortSignal that fires, we call
 * `ai.interactions.cancel(id)` so we don't keep paying for a job nobody wants.
 *
 * @see https://ai.google.dev/gemini-api/docs/interactions
 */

import { GoogleGenAI, Interactions } from '@google/genai';

// `Interaction` is re-exported from the `Interactions` namespace by @google/genai.
// Aliasing here keeps the rest of the file readable.
type Interaction = Interactions.Interaction;
import { createLogger, generateRequestId } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';

const log = createLogger({ module: 'gemini-deep-research-service' });

/** How often to poll for status updates while the agent runs. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Hard cap on a single Deep Research run.
 *
 * Google's product page advertises 5–15 min typical, with longer runs
 * possible. We cap at 25 minutes so a wedged interaction can't tie up
 * an ECS task indefinitely. ECS Fargate has no inherent task timeout
 * but ALB idle-connection timeout (default 60s) doesn't apply because
 * we keep writing status updates to the stream — see status emitter
 * cadence below.
 */
const MAX_RUN_DURATION_MS = 25 * 60 * 1_000;

export interface DeepResearchCitation {
  url: string;
  title?: string;
  /** Byte offsets into the report text — preserved for future inline rendering. */
  startIndex?: number;
  endIndex?: number;
}

export interface DeepResearchResult {
  /** Final report as markdown. */
  report: string;
  /** Sources cited by the agent. May be empty if the agent didn't cite anything. */
  citations: DeepResearchCitation[];
  /** Google's interaction id — useful for support / debug correlation. */
  interactionId: string;
  /** Wall-clock duration of the research run in milliseconds. */
  durationMs: number;
}

export interface DeepResearchStatusUpdate {
  /** Google's status string. */
  status: Interaction['status'];
  /** Seconds elapsed since the run started. */
  elapsedSec: number;
  /** Human-friendly progress message — what the user sees. */
  message: string;
}

export interface DeepResearchRequest {
  prompt: string;
  /** model_id from ai_models — passed to Google as `agent`. */
  modelId: string;
  /** Optional cancel signal; on abort we call interactions.cancel(). */
  abortSignal?: AbortSignal;
  /**
   * Called once per poll with the latest status. The route uses this to
   * write progressive `Researching… (Nm)` updates to the SSE stream.
   * Errors thrown here are swallowed — a slow client must not interrupt
   * the agent run.
   */
  onStatus?: (update: DeepResearchStatusUpdate) => void | Promise<void>;
}

interface DeepResearchError extends Error {
  type:
    | 'CONTENT_POLICY'
    | 'RATE_LIMIT'
    | 'AUTHENTICATION'
    | 'TIMEOUT'
    | 'AGENT_FAILURE'
    | 'UNKNOWN';
  retryAfter?: number;
}

function createError(
  type: DeepResearchError['type'],
  message: string,
  retryAfter?: number
): DeepResearchError {
  const err = new Error(message) as DeepResearchError;
  err.type = type;
  if (retryAfter !== undefined) err.retryAfter = retryAfter;
  return err;
}

/**
 * Friendly progress text for the user. We surface Google's actual status
 * string when it's informative, and fall back to a wall-clock timer for
 * the long quiet stretches in the middle of a run.
 *
 * Terminal statuses (completed, failed, cancelled) return null — the caller
 * should not emit a progress line for these since the final report or error
 * message is about to follow immediately.
 */
function buildProgressMessage(status: Interaction['status'], elapsedSec: number): string | null {
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  // Include seconds so the message changes every poll (~10s), keeping the SSE
  // connection alive through ALB/proxy idle timeouts (typically 60s).
  const timeText = minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${seconds}s`;
  switch (status) {
    case 'in_progress':
      return `Researching… (${timeText})`;
    case 'requires_action':
      return `Awaiting action from the agent (${timeText})`;
    case 'incomplete':
      return `Research run ended early — partial results below.`;
    // Terminal statuses — no progress message; the final report/error follows.
    case 'completed':
    case 'failed':
    case 'cancelled':
      return null;
    default:
      return `Status: ${status} (${timeText})`;
  }
}

/**
 * Validate that a URL uses a safe protocol (http/https only).
 * Blocks javascript:, data:, and other potentially dangerous URI schemes
 * that could be injected via Google's API response into markdown links.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // Malformed URLs are not safe
    return false;
  }
}

/**
 * Type guard for url_citation annotations on a Google text block. We don't
 * use a real schema here — the SDK already types the upstream surface, but
 * we narrow defensively because `outputs` is a union of many block kinds.
 *
 * URLs are validated to only allow http/https protocols — this prevents
 * javascript: or data: URIs from being rendered as live markdown links.
 */
function asUrlCitation(value: unknown): DeepResearchCitation | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  if ((value as { type: string }).type !== 'url_citation') return null;
  const url = (value as { url?: string }).url;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (!isSafeUrl(url)) {
    log.warn('Skipping citation with unsafe URL scheme', { url: url.slice(0, 100) });
    return null;
  }
  return {
    url,
    title: (value as { title?: string }).title,
    startIndex: (value as { start_index?: number }).start_index,
    endIndex: (value as { end_index?: number }).end_index,
  };
}

/**
 * Pull report text + URL citations out of Google's `outputs` array.
 * Outputs is a heterogeneous list of Content blocks; we keep text blocks
 * and harvest `url_citation` annotations into a flat list. Non-text blocks
 * (function calls, image content, etc.) are ignored — Deep Research returns
 * a written report, anything else is exotic.
 */
function extractReportAndCitations(outputs: Interaction['outputs']): {
  report: string;
  citations: DeepResearchCitation[];
} {
  if (!outputs || outputs.length === 0) {
    return { report: '', citations: [] };
  }

  const textChunks: string[] = [];
  const citations: DeepResearchCitation[] = [];

  for (const block of outputs) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue;
    if (block.type !== 'text') continue;

    const text = (block as { text?: string }).text;
    if (typeof text === 'string' && text.length > 0) {
      textChunks.push(text);
    }

    const annotations = (block as { annotations?: unknown[] }).annotations;
    if (!Array.isArray(annotations)) continue;
    for (const ann of annotations) {
      const cite = asUrlCitation(ann);
      if (cite) citations.push(cite);
    }
  }

  return { report: textChunks.join('\n\n'), citations };
}

/** Map upstream errors onto our taxonomy by inspecting message + status. */
function mapInteractionError(err: unknown): DeepResearchError {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('safety') || lower.includes('content_policy') || lower.includes('blocked')) {
    return createError('CONTENT_POLICY', 'Your research prompt was rejected by content policy.');
  }
  if (lower.includes('rate') && lower.includes('limit')) {
    const retryMatch = msg.match(/retry after (\d+)/i);
    return createError(
      'RATE_LIMIT',
      'Rate limit exceeded for Deep Research.',
      retryMatch ? Number.parseInt(retryMatch[1], 10) : 60
    );
  }
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return createError('AUTHENTICATION', 'Google authentication failed.');
  }
  return createError('AGENT_FAILURE', `Deep Research failed: ${msg.slice(0, 300)}`);
}

/**
 * Abortable sleep. Cleans up the abort listener on normal resolution so that
 * long polling loops (150+ iterations over 25 minutes) don't accumulate
 * leaked listeners on the shared AbortSignal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };

    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const TERMINAL_STATUSES: ReadonlyArray<Interaction['status']> = [
  'completed',
  'failed',
  'cancelled',
  'incomplete',
];

/** Max consecutive transient poll failures before we give up. */
const MAX_POLL_RETRIES = 3;

/**
 * Tight polling loop. Returns the terminal Interaction or throws a
 * DeepResearchError. Extracted from `runDeepResearch` to keep both
 * functions under the cyclomatic-complexity threshold.
 */
async function pollUntilTerminal(
  client: GoogleGenAI,
  initial: Interaction,
  startMs: number,
  request: DeepResearchRequest
): Promise<Interaction> {
  let last: Interaction = initial;
  let consecutiveErrors = 0;

  while (true) {
    const elapsedMs = Date.now() - startMs;
    if (elapsedMs > MAX_RUN_DURATION_MS) {
      void client.interactions.cancel(last.id).catch(() => {});
      throw createError(
        'TIMEOUT',
        `Deep Research exceeded the ${Math.round(MAX_RUN_DURATION_MS / 60_000)}-minute time limit.`
      );
    }

    // Only emit progress for non-terminal statuses — terminal statuses
    // are handled by the caller (final report or error message).
    if (!TERMINAL_STATUSES.includes(last.status)) {
      const progressMsg = buildProgressMessage(last.status, Math.floor(elapsedMs / 1_000));
      if (progressMsg) {
        try {
          await request.onStatus?.({
            status: last.status,
            elapsedSec: Math.floor(elapsedMs / 1_000),
            message: progressMsg,
          });
        } catch (err) {
          // Status callback errors must never interrupt the run.
          log.warn('onStatus callback threw — continuing', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (TERMINAL_STATUSES.includes(last.status)) return last;

    try {
      await sleep(POLL_INTERVAL_MS, request.abortSignal);
    } catch {
      throw createError('AGENT_FAILURE', 'Deep Research cancelled by client.');
    }

    // Retry transient poll failures — a 25-minute run is highly susceptible
    // to momentary network blips. We retry up to MAX_POLL_RETRIES consecutive
    // failures before giving up.
    try {
      last = await client.interactions.get(last.id);
      consecutiveErrors = 0; // reset on success
    } catch (pollErr) {
      consecutiveErrors++;
      log.warn('Transient poll error', {
        interactionId: last.id,
        attempt: consecutiveErrors,
        maxRetries: MAX_POLL_RETRIES,
        error: pollErr instanceof Error ? pollErr.message : String(pollErr),
      });
      if (consecutiveErrors >= MAX_POLL_RETRIES) {
        throw createError(
          'AGENT_FAILURE',
          `Deep Research polling failed after ${MAX_POLL_RETRIES} consecutive errors: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`
        );
      }
      // On retry, we don't update `last` — the loop re-sleeps and retries
      // the same interaction.get() call on the next iteration.
    }
  }
}

/**
 * Run a Deep Research interaction. Resolves to the final report on success,
 * throws a DeepResearchError on failure. Caller is responsible for surfacing
 * status updates to the user via the `onStatus` callback.
 */
export async function runDeepResearch(
  request: DeepResearchRequest
): Promise<DeepResearchResult> {
  const requestId = generateRequestId();
  log.info('Starting Deep Research run', {
    requestId,
    modelId: request.modelId,
    promptLength: request.prompt.length,
  });

  const apiKey = await Settings.getGoogleAI();
  if (!apiKey) {
    throw ErrorFactories.sysConfigurationError('Google API key not configured');
  }

  const client = new GoogleGenAI({ apiKey });
  const startMs = Date.now();
  let interactionId = '';

  try {
    const initial = await client.interactions.create({
      input: request.prompt,
      agent: request.modelId,
      background: true,
    });
    interactionId = initial.id;

    log.info('Deep Research interaction created', {
      requestId,
      interactionId,
      initialStatus: initial.status,
    });

    // Best-effort cancellation when the HTTP request is aborted.
    request.abortSignal?.addEventListener(
      'abort',
      () => {
        log.info('Deep Research aborted by client — cancelling upstream', {
          requestId,
          interactionId,
        });
        void client.interactions.cancel(interactionId).catch((err) => {
          log.warn('Failed to cancel Deep Research interaction', {
            interactionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      { once: true }
    );

    const last = await pollUntilTerminal(client, initial, startMs, request);

    if (last.status === 'failed' || last.status === 'cancelled') {
      throw createError(
        'AGENT_FAILURE',
        `Deep Research ended with status: ${last.status}.`
      );
    }

    const { report, citations } = extractReportAndCitations(last.outputs);
    const durationMs = Date.now() - startMs;

    log.info('Deep Research completed', {
      requestId,
      interactionId,
      status: last.status,
      durationMs,
      reportLength: report.length,
      citationCount: citations.length,
    });

    if (!report) {
      throw createError(
        'AGENT_FAILURE',
        'Deep Research returned no report content.'
      );
    }

    return { report, citations, interactionId, durationMs };
  } catch (err) {
    log.error('Deep Research failed', {
      requestId,
      interactionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof Error && 'type' in err) throw err;
    throw mapInteractionError(err);
  }
}

/** Shape used by the chat route's error mapper. Exported for tests. */
export type { DeepResearchError };
