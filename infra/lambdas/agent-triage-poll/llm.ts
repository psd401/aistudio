/**
 * Bedrock Nova Micro classifier — fallback when the deterministic rules
 * engine returns `undecided`.
 *
 * Why Nova Micro: cheapest Bedrock model available, fast (<1s typical),
 * good enough at "classify this short email into one of N buckets"
 * which is essentially what we're doing. Per-call cost ~$0.0001 with
 * the small prompt we send. Annual cost projection at 1000 users ≈
 * $900/yr in the worst case — well under what SaneBox costs at scale.
 *
 * Why not the agent's main model: the agent harness runs Claude Sonnet 5
 * (Bedrock Mantle, per #1089; formerly GLM-5). That's a much heavier model
 * and we'd pay 10-20x per classification. Triage is a hot path that needs to
 * be tiny, so it keeps its own lightweight Nova classifier.
 *
 * Fail-safe: if Bedrock returns garbage or the response can't be parsed,
 * we default to `later` (the lowest-noise classification). The user can
 * always correct it via training feedback.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

import type { Label, TriageRules } from "./rules";
import type { EmailFeatures } from "./rules";

const MODEL_ID = process.env.TRIAGE_LLM_MODEL_ID ?? "us.amazon.nova-micro-v1:0";

let cachedClient: BedrockRuntimeClient | null = null;

function client(): BedrockRuntimeClient {
  if (!cachedClient) {
    cachedClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return cachedClient;
}

export interface LLMDecision {
  label: Label;
  confidence: number;
  reason: string;
}

/**
 * Classify one email. Returns the label, confidence (0-1), and a short
 * one-line reason the agent can echo back to the user during training
 * review.
 */
export async function classifyWithLLM(
  features: EmailFeatures,
  rules: TriageRules,
  userInternalDomain: string,
): Promise<LLMDecision> {
  const systemPrompt = buildSystemPrompt(rules, userInternalDomain);
  const userPrompt = buildUserPrompt(features);

  try {
    const resp = await client().send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: systemPrompt }],
        messages: [
          {
            role: "user",
            content: [{ text: userPrompt }],
          },
        ],
        inferenceConfig: {
          // Tiny output — we want a JSON line, not prose.
          maxTokens: 120,
          // Low temperature so the same email gets the same label across runs.
          temperature: 0.1,
          topP: 0.9,
        },
      }),
    );

    const blocks: ContentBlock[] =
      resp.output?.message?.content ?? [];
    const text = blocks
      .map((b) => ("text" in b && b.text ? b.text : ""))
      .join("")
      .trim();

    return parseLLMOutput(text);
  } catch (err) {
    // Hard-fail safe: any Bedrock or parse error → fall through to
    // `later`. We DO log the error so CloudWatch shows real
    // misconfigurations (model not enabled, throttle, etc.).
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "ERROR",
        evt: "llm_classify_failed",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      label: "later",
      confidence: 0,
      reason: "llm-error-default",
    };
  }
}

function buildSystemPrompt(
  rules: TriageRules,
  userInternalDomain: string,
): string {
  const vip = rules.vipSenders.length
    ? rules.vipSenders.join(", ")
    : "(none — anyone is fair game)";
  const muted = rules.muteSenders.length
    ? rules.muteSenders.join(", ")
    : "(none configured)";
  const keywords =
    rules.keywordRules.length === 0
      ? "(none configured)"
      : rules.keywordRules
          .map((r) => {
            const parts: string[] = [];
            if (r.subject_contains) parts.push(`subject contains "${r.subject_contains}"`);
            if (r.snippet_contains) parts.push(`body contains "${r.snippet_contains}"`);
            if (r.from_domain) parts.push(`from ${r.from_domain}`);
            if (r.external) parts.push("external sender");
            return `- ${parts.join(" + ")} → ${r.label}`;
          })
          .join("\n");

  return [
    `You classify incoming emails for a Peninsula School District (PSD) employee into one of three Gmail labels:`,
    `  - important: needs attention soon. Real work, real people, real decisions.`,
    `  - later:     can wait. Notifications, FYI, low-priority discussion.`,
    `  - news:      pure information. Newsletters, marketing, vendor blasts.`,
    ``,
    `Reply with EXACTLY one JSON line, no preamble or markdown, in this shape:`,
    `  {"label":"important|later|news","confidence":0.0-1.0,"reason":"<8-word phrase>"}`,
    ``,
    `Confidence calibration:`,
    `  0.9+  obvious case (signature human conversation, clear newsletter)`,
    `  0.6+  reasonable signal but not certain`,
    `  <0.6  genuine ambiguity — Lambda will default to "later" anyway`,
    ``,
    `Heuristics (in priority order):`,
    `  1. Spam pretends to be urgent. External senders shouting "URGENT" without a thread or prior contact → almost always later.`,
    `  2. Internal threads from this user's org (${userInternalDomain}) get the benefit of the doubt.`,
    `  3. Single-recipient direct mail from a real person beats broadcast/list mail.`,
    `  4. Numeric-sender domains, "noreply", "donotreply", marketing patterns → news.`,
    `  5. Calendar invites are not in scope here — Gmail's own system handles those.`,
    ``,
    `User's configured rules for context (already attempted and didn't match — you are the fallback):`,
    `  VIP senders: ${vip}`,
    `  Muted senders: ${muted}`,
    `  Keyword rules:`,
    `${keywords}`,
  ].join("\n");
}

function buildUserPrompt(features: EmailFeatures): string {
  // Keep this small — Nova Micro is cheap per token but we still want
  // throughput at scale. Truncate to ~1500 chars max.
  const snippet =
    features.snippetLower.length > 400
      ? features.snippetLower.slice(0, 400) + "…"
      : features.snippetLower;
  return [
    `From: ${features.fromEmail} (${features.isInternal ? "internal" : "external"})`,
    `Subject: ${features.subject}`,
    `Snippet: ${snippet}`,
    `Has-prior-reply-from-user: ${features.hasUserReply}`,
  ].join("\n");
}

/**
 * Parse the model's one-line JSON output. Tolerant of: surrounding
 * markdown fences (some Nova outputs wrap JSON in ```), extra whitespace,
 * the model adding a trailing period.
 *
 * Always returns a valid decision — falls back to `later` confidence=0
 * on any parse failure rather than throwing.
 */
export function parseLLMOutput(text: string): LLMDecision {
  if (!text) return { label: "later", confidence: 0, reason: "empty-llm-output" };
  let cleaned = text.trim();
  // Strip markdown code fences if present.
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  // Strip a possible trailing period after the closing brace.
  cleaned = cleaned.replace(/}\s*\.\s*$/, "}");
  // Find the JSON object within (model might prepend a stray "answer:").
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return { label: "later", confidence: 0, reason: `unparseable: ${text.slice(0, 80)}` };
  }
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  let parsed: { label?: string; confidence?: number; reason?: string };
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return { label: "later", confidence: 0, reason: `unparseable: ${text.slice(0, 80)}` };
  }
  const label: Label =
    parsed.label === "important" || parsed.label === "later" || parsed.label === "news"
      ? parsed.label
      : "later";
  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : "no-reason";
  return { label, confidence, reason };
}
