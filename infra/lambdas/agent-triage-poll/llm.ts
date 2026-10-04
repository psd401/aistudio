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
import type {
  ContentPreference,
  CorrectionRecord,
  LearnedPattern,
  UserPreferenceProfile,
} from "./types";
import {
  describeContentSignals,
  hasAsk,
  type ContentSignals,
} from "./content-features";

const MODEL_ID = process.env.TRIAGE_LLM_MODEL_ID ?? "us.amazon.nova-micro-v1:0";

/**
 * Global confidence floor — anything below this becomes `later` regardless
 * of the model's label. Unchanged from Phase 1.
 */
export const GLOBAL_CONFIDENCE_FLOOR = 0.6;

/**
 * Higher bar for LLM-sourced `important` (#1172): "important" isn't always
 * important, so an LLM `important` needs at least this confidence or it is
 * demoted to `later`. Rule-sourced importants (VIP, thread-reply) are
 * unaffected — they never pass through here.
 */
export const IMPORTANT_CONFIDENCE_FLOOR = 0.75;

/** Max characters of body excerpt we feed Nova Micro (#1172). */
export const BODY_EXCERPT_MAX = 1500;

export interface ClassifyOptions {
  /** Full-body excerpt (preferred over snippet when available). */
  bodyExcerpt?: string;
  /** Weighted sender hints from the nightly learning job. */
  learnedPatterns?: LearnedPattern[];
  /** Recent user corrections, summarised into the prompt. */
  recentCorrections?: CorrectionRecord[];
  /** Deterministic content signals — the primary evidence (#1855). */
  contentSignals?: ContentSignals;
  /** Content-shape leanings mined from this user's corrections. */
  contentPreferences?: ContentPreference[];
  /** The user's own plain-language preferences. */
  preferences?: UserPreferenceProfile;
}

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
  opts: ClassifyOptions = {},
): Promise<LLMDecision> {
  const systemPrompt = buildSystemPrompt(
    rules,
    userInternalDomain,
    opts.learnedPatterns ?? [],
    opts.recentCorrections ?? [],
    opts,
  );
  const userPrompt = buildUserPrompt(features, opts.bodyExcerpt, opts);

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
  learnedPatterns: LearnedPattern[],
  recentCorrections: CorrectionRecord[],
  opts: ClassifyOptions = {},
): string {
  const vip = rules.vipSenders.length > 0
    ? rules.vipSenders.join(", ")
    : "(none — anyone is fair game)";
  const muted = rules.muteSenders.length > 0
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

  const lines = [
    `You classify incoming emails for a Peninsula School District (PSD) employee into one of three Gmail labels:`,
    `  - important: the message asks something of this user, or they are in a live exchange about it.`,
    `  - later:     nothing is asked of this user right now. FYI, status, discussion they are copied on.`,
    `  - news:      pure broadcast information. Newsletters, marketing, vendor blasts.`,
    ``,
    `Reply with EXACTLY one JSON line, no preamble or markdown, in this shape:`,
    `  {"label":"important|later|news","confidence":0.0-1.0,"reason":"<8-word phrase>"}`,
    ``,
    `DECIDE FROM THE CONTENT, NOT FROM WHO SENT IT.`,
    `This is the single most important instruction. Two messages with the same body`,
    `and the same recipient role MUST get the same label even when they arrive from`,
    `different addresses, different relays or different domains. The sender is a weak`,
    `prior only; it may adjust your confidence slightly and must never flip a label`,
    `that the content has already settled.`,
    ``,
    `What makes a message "important" (any one of these, in priority order):`,
    `  1. It asks this user to approve, sign, authorise or decide something — even when`,
    `     the actual click happens in another system (service desk, travel, HR).`,
    `  2. It is a reply inside a thread this user has already written in.`,
    `  3. It puts a direct question to this user, and this user is in To.`,
    `  4. It asks this user to do something by a stated deadline.`,
    ``,
    `What makes a message "later":`,
    `  - FYI, status reports, digests, recaps, "no action required".`,
    `  - This user is only on Cc, or is one of many recipients, and nothing is asked of them.`,
    `  - An automated notice that reports a fact and asks for nothing.`,
    ``,
    `"news" is for broadcast publications only. Mail written by a person is never`,
    `"news" — at worst it is "later".`,
    ``,
    `Confidence calibration:`,
    `  0.9+  the content signals are unambiguous`,
    `  0.75+ confident it is genuinely important (needed before "important" sticks)`,
    `  0.6+  reasonable signal but not certain`,
    `  <0.6  genuine ambiguity — Lambda will default to "later" anyway`,
    ``,
    `Be conservative with "important": it should mean the user must act. Urgency words`,
    `in a subject line are not an ask; spam and marketing both shout "URGENT".`,
    ``,
    `The "reason" you return must name the CONTENT signal you used (for example`,
    `"direct question addressed to you" or "status digest, nothing asked"). Do not`,
    `give the sender as the reason.`,
    ``,
    `This user's organisation domain is ${userInternalDomain}; treat that as context,`,
    `not as evidence of importance.`,
    ``,
    `User's configured rules for context (already attempted and didn't match — you are the fallback):`,
    `  VIP senders: ${vip}`,
    `  Muted senders: ${muted}`,
    `  Keyword rules:`,
    `${keywords}`,
  ];

  const stated = (opts.preferences?.text ?? "").trim();
  if (stated) {
    lines.push(
      ``,
      `The user stated these preferences in their own words. They outrank the`,
      `general heuristics above when they conflict:`,
      stated
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }

  const shapeHints = formatContentPreferences(opts.contentPreferences ?? []);
  if (shapeHints) {
    lines.push(
      ``,
      `Learned from this user's corrections, keyed on what the message ASKS (these`,
      `apply to every sender that writes the same kind of mail):`,
      shapeHints,
    );
  }

  const learned = formatLearnedPatterns(learnedPatterns);
  if (learned) {
    lines.push(
      ``,
      `Learned sender signals. These are the WEAKEST input you have: use them only`,
      `to break a tie the content left open, never to override a content signal:`,
      learned,
    );
  }

  const corrections = formatRecentCorrections(recentCorrections);
  if (corrections) {
    lines.push(
      ``,
      `Recent corrections the user made to your past calls (learn the direction):`,
      corrections,
    );
  }

  return lines.join("\n");
}

/**
 * Render weighted learned patterns as prompt hints. Highest-weight first,
 * capped at 8 lines so a chatty history can't blow the prompt budget.
 */
function formatLearnedPatterns(patterns: LearnedPattern[]): string {
  if (!patterns || patterns.length === 0) return "";
  return patterns
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 8)
    .map((p) => {
      const lean =
        p.kind === "vip"
          ? "lean important (user keeps rescuing these)"
          : "lean later/news (user keeps archiving these)";
      return `  - ${p.pattern} → ${lean} [w=${(p.weight ?? 0).toFixed(1)}]`;
    })
    .join("\n");
}

/**
 * Render content-shape leanings. Highest weight first, capped at 6 lines.
 * These are stronger than sender hints because they describe the kind of
 * message rather than the person who sent it.
 */
function formatContentPreferences(prefs: ContentPreference[]): string {
  if (!prefs || prefs.length === 0) return "";
  return prefs
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 6)
    .map(
      (p) =>
        `  - messages shaped "${p.shape}" → lean ${p.lean} ` +
        `(${p.count} correction(s), w=${(p.weight ?? 0).toFixed(1)})`,
    )
    .join("\n");
}

/** Summarise the most recent corrections (newest first, capped at 5). */
function formatRecentCorrections(corrections: CorrectionRecord[]): string {
  if (!corrections || corrections.length === 0) return "";
  return corrections
    .slice(-5)
    .reverse()
    .map((c) => {
      const who = c.fromEmail ? ` from ${c.fromEmail}` : "";
      if (c.toLabel === "archived") {
        return `  - archived an "important"${who} (you over-escalated)`;
      }
      if (c.toLabel === "inbox") {
        return `  - rescued a "${c.fromLabel}"${who} back to inbox (you under-escalated)`;
      }
      return `  - re-labelled "${c.fromLabel}" → "${c.toLabel}"${who}`;
    })
    .join("\n");
}

function buildUserPrompt(
  features: EmailFeatures,
  bodyExcerpt?: string,
  opts: ClassifyOptions = {},
): string {
  // Prefer the fuller body excerpt (#1172) — the 200-char snippet often
  // cut off the signal ("please approve by Friday"). Fall back to the
  // snippet when no body could be fetched. Cap at BODY_EXCERPT_MAX so a
  // long thread can't blow Nova Micro's token budget.
  const raw = bodyExcerpt && bodyExcerpt.trim() ? bodyExcerpt : features.snippetLower;
  const body =
    raw.length > BODY_EXCERPT_MAX ? raw.slice(0, BODY_EXCERPT_MAX) + "…" : raw;
  // Content first, sender last and explicitly labelled as the weak prior —
  // the ordering is deliberate (#1855 item 4).
  const parts = [`Subject: ${features.subject}`, `Body: ${body}`];
  if (opts.contentSignals) {
    parts.push(
      `Content signals (computed from the message, not from the sender):`,
      describeContentSignals(opts.contentSignals),
    );
  } else {
    parts.push(`Has-prior-reply-from-user: ${features.hasUserReply}`);
  }
  parts.push(
    `Weak prior — sender: ${features.fromEmail} ` +
      `(${features.isInternal ? "internal" : "external"})`,
  );
  return parts.join("\n");
}

/**
 * Apply the confidence floors to a raw LLM decision (#1172). Pure +
 * exported so the "important needs ≥ 0.75" rule is unit-testable without
 * a Bedrock mock.
 *
 *   - confidence < GLOBAL_CONFIDENCE_FLOOR (0.6) → later (any label)
 *   - label === important && confidence < IMPORTANT_CONFIDENCE_FLOOR (0.75)
 *       → later (the "important isn't always important" bar)
 *
 * Rule-sourced decisions never pass through here; they're always trusted.
 */
export function finalizeLLMLabel(llm: LLMDecision): {
  label: Label;
  confidence: number;
  reason: string;
  downgraded: boolean;
} {
  if (llm.confidence < GLOBAL_CONFIDENCE_FLOOR) {
    return {
      label: "later",
      confidence: llm.confidence,
      reason: `low-confidence (${llm.reason})`,
      downgraded: true,
    };
  }
  if (llm.label === "important" && llm.confidence < IMPORTANT_CONFIDENCE_FLOOR) {
    return {
      label: "later",
      confidence: llm.confidence,
      reason: `important-below-${IMPORTANT_CONFIDENCE_FLOOR} (${llm.reason})`,
      downgraded: true,
    };
  }
  return {
    label: llm.label,
    confidence: llm.confidence,
    reason: llm.reason,
    downgraded: false,
  };
}

/** Minimum learned weight before a content-shape leaning changes a label. */
export const CONTENT_BIAS_MIN_WEIGHT = 1.5;

/** Minimum number of corrections behind a content-shape leaning. */
export const CONTENT_BIAS_MIN_COUNT = 2;

export interface GuardedDecision {
  label: Label;
  confidence: number;
  reason: string;
  /** True when a guard changed the label the model returned. */
  adjusted: boolean;
}

/**
 * Deterministic guards applied to an LLM label (#1855). Two of them:
 *
 *  1. **Corrections must bite.** Before this, twenty corrections of
 *     "you called this important, I archived it" changed nothing but a
 *     soft prompt hint, and the classifier kept over-promoting. When the
 *     user has repeatedly archived messages of this SHAPE and the current
 *     message asks nothing of them, `important` is demoted to `later`.
 *     Keyed on shape, not sender, so one correction generalises.
 *
 *  2. **People are never "news".** `news` is the auto-archive bucket for
 *     broadcast publications. A colleague's mail may be `later`, never
 *     filed away as a newsletter.
 *
 * Demote-only by design: the reported failure mode is over-promotion, and
 * a learned rule that silently promotes mail is the harder one to notice.
 */
export function applyContentGuards(
  decision: { label: Label; confidence: number; reason: string },
  signals: ContentSignals | undefined,
  contentPreferences: ContentPreference[] = [],
): GuardedDecision {
  let { label, reason } = decision;
  let adjusted = false;

  if (signals && label === "important" && !hasAsk(signals)) {
    const leansLater = contentPreferences.some(
      (pref) =>
        pref.shape === signals.shape &&
        pref.lean === "later" &&
        (pref.weight ?? 0) >= CONTENT_BIAS_MIN_WEIGHT &&
        (pref.count ?? 0) >= CONTENT_BIAS_MIN_COUNT,
    );
    if (leansLater) {
      label = "later";
      reason = `learned:you-archive-${signals.shape}-mail (${reason})`;
      adjusted = true;
    }
  }

  if (signals && label === "news" && !signals.automatedSender) {
    label = "later";
    reason = `human-sender-never-news (${reason})`;
    adjusted = true;
  }

  return { label, confidence: decision.confidence, reason, adjusted };
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
