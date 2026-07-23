/**
 * rich-envelope.ts — extract a PSD_AGENT_RICH_V1 envelope from an agent reply.
 *
 * COPY of infra/lambdas/agent-router/rich-envelope.ts. The cron Lambda is
 * a separate bundling target with its own package.json, so we duplicate
 * the file rather than wire up a cross-package import. Keep the two
 * byte-identical (except this header), and keep behaviour in lockstep
 * with infra/agent-image/chat_format.py too.
 */

export const RICH_ENVELOPE_OPEN = '<<<PSD_AGENT_RICH_V1>>>';
export const RICH_ENVELOPE_CLOSE = '<<<END_PSD_AGENT_RICH_V1>>>';

export interface RichEnvelope {
  cardsV2?: unknown[];
  accessoryWidgets?: unknown[];
  actionResponse?: Record<string, unknown>;
  textFallback?: string;
}

export interface ExtractResult {
  envelope: RichEnvelope | null;
  remaining: string;
  /**
   * True when at least one envelope block was malformed (bad JSON, missing
   * close marker, non-object payload). The caller should log this so we can
   * find agent-side bugs in CloudWatch instead of silently dropping content.
   */
  malformed: boolean;
}

/**
 * Pull a rich-output envelope (or the last of several) out of an agent reply.
 *
 * Rules:
 *   - No sentinels present: returns the input unchanged.
 *   - One valid envelope: returns it, with the sentinels stripped from text.
 *   - Multiple envelopes: last wins; all sentinel blocks stripped.
 *   - Malformed JSON or dangling open sentinel: returns text unchanged, sets
 *     malformed=true. We refuse to "guess" what the agent meant — better to
 *     surface a broken envelope as plain text than to silently lose content.
 */
export function extractRichEnvelope(text: string | null | undefined): ExtractResult {
  if (!text || !text.includes(RICH_ENVELOPE_OPEN)) {
    return { envelope: null, remaining: text ?? '', malformed: false };
  }

  let remaining = text;
  let lastEnvelope: RichEnvelope | null = null;
  let sawMalformed = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = remaining.indexOf(RICH_ENVELOPE_OPEN);
    if (openIdx === -1) break;
    const closeIdx = remaining.indexOf(
      RICH_ENVELOPE_CLOSE,
      openIdx + RICH_ENVELOPE_OPEN.length
    );
    if (closeIdx === -1) {
      sawMalformed = true;
      break;
    }
    const payloadStart = openIdx + RICH_ENVELOPE_OPEN.length;
    const payload = remaining.slice(payloadStart, closeIdx).trim();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lastEnvelope = parsed as RichEnvelope;
      } else {
        sawMalformed = true;
      }
    } catch {
      sawMalformed = true;
    }
    const before = remaining.slice(0, openIdx).replace(/\n+$/, '');
    const after = remaining
      .slice(closeIdx + RICH_ENVELOPE_CLOSE.length)
      .replace(/^\n+/, '');
    remaining = before && after ? `${before}\n${after}` : before + after;
  }

  if (sawMalformed && lastEnvelope === null) {
    return { envelope: null, remaining: text, malformed: true };
  }
  return {
    envelope: lastEnvelope,
    remaining: remaining.trim(),
    malformed: sawMalformed,
  };
}
