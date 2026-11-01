/**
 * Output-token cap for a Claude 4.x/5.x call whose caller set none.
 *
 * With no `maxOutputTokens`, Bedrock Converse caps Claude at 4,096 output tokens
 * (verified 2026-10-26: Sonnet 5.5 stopped with `max_tokens` at exactly 4096).
 * Claude 5.x thinks adaptively by default and that thinking counts against the
 * same cap, so a long answer — grading a class set, a long rewrite — ran out
 * mid-thought and the turn ended with no text at all (`finishReason: length`,
 * "This turn ended without a written answer"). Output is billed per token
 * generated, not per token allowed, so a high ceiling costs nothing extra on
 * short turns. Every Claude 4.x/5.x model supports at least 64K output.
 */
export const DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Claude 4.x/5.x model ids in their Bedrock and alias spellings:
 * `us.anthropic.claude-sonnet-5-5`, `claude-opus-4-6-v1`, `claude-haiku-4.5`,
 * `anthropic.claude-sonnet-5`, `claude-4-…`. An allowlist on purpose: older
 * families (Claude 2.x/3.x, max 4K-8K output) would reject the default.
 */
const CLAUDE_4_OR_5 = /claude-(?:(?:opus|sonnet|haiku|fable)-[45]\b|[45]\b)/i;

/** The cap to send when the caller set none, or undefined to send nothing. */
export function defaultClaudeMaxOutputTokens(modelId: string): number | undefined {
  return CLAUDE_4_OR_5.test(modelId) ? DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS : undefined;
}
