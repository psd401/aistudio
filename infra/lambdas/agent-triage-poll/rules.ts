/**
 * Deterministic rule engine for the email triage classifier.
 *
 * Runs FIRST on every incoming email — most messages have an unambiguous
 * answer (VIP sender, known noreply, newsletter, etc.) and we shouldn't
 * pay a Bedrock call for them. Only when this returns `undecided` does
 * the Lambda fall through to the LLM classifier.
 *
 * Kept in its own file so it's trivially unit-testable without an AWS
 * SDK or Gmail mock — pure functions in, label decision out.
 */

import type { DecisionSource } from "./types";

export type Label = "important" | "later" | "news";

export interface EmailFeatures {
  /** Sender's email address, lowercased. */
  fromEmail: string;
  /** Domain portion of the sender (after `@`), lowercased. */
  fromDomain: string;
  /** True when the sender's domain matches the user's organisation. */
  isInternal: boolean;
  /** Subject line, raw (case preserved for matching). */
  subject: string;
  /** Lowercased subject, for case-insensitive matching. */
  subjectLower: string;
  /** Body snippet (first ~200 chars), lowercased. */
  snippetLower: string;
  /** True when there's a prior thread the user has participated in. */
  hasUserReply: boolean;
}

export interface KeywordRule {
  /**
   * Stable identifier (#1855 item 1). Rules written before that change
   * have none, which is exactly why `rules remove` also accepts a list
   * index — an id-only delete could never reach them.
   */
  id?: string;
  /** Whole subject substring match, lowercased. */
  subject_contains?: string;
  /** Any one of these subject substrings matches (OR). */
  subject_any?: string[];
  /** Body snippet substring match, lowercased. */
  snippet_contains?: string;
  /** Any one of these body substrings matches (OR). */
  snippet_any?: string[];
  /** Sender domain match. */
  from_domain?: string;
  /** Full sender address match — narrower than `from_domain`. */
  from_address?: string;
  /** Require the sender to be external (not in user's org). */
  external?: boolean;
  /** Label to apply when this rule matches. */
  label: Label;
}

/**
 * Criteria that are only meaningful as a non-empty string (or non-empty
 * list of them). A rule whose `from_domain` is the boolean `true` — the
 * shape `rules add-keyword --from` used to persist — matches nothing and
 * cannot be addressed by value, so it is treated as malformed rather than
 * silently carried in the engine. See #1855 item 1.
 */
const KEYWORD_RULE_CRITERIA = [
  "subject_contains",
  "snippet_contains",
  "from_domain",
  "from_address",
] as const;

const KEYWORD_RULE_LIST_CRITERIA = ["subject_any", "snippet_any"] as const;

function criterionText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function criterionList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => Boolean(criterionText(entry)))
    : [];
}

/**
 * A rule is well-formed when at least one positive criterion carries real
 * text. Everything else — a bare `external: true`, a boolean
 * `from_domain`, an empty string — would either match everything or
 * nothing, and both are misconfigurations.
 */
export function isWellFormedKeywordRule(rule: KeywordRule): boolean {
  const hasText = KEYWORD_RULE_CRITERIA.some((key) =>
    criterionText(rule[key]),
  );
  const hasList = KEYWORD_RULE_LIST_CRITERIA.some(
    (key) => criterionList(rule[key]).length > 0,
  );
  const labelIsValid =
    rule.label === "important" || rule.label === "later" || rule.label === "news";
  return labelIsValid && (hasText || hasList);
}

export interface TriageRules {
  /** Exact sender addresses (lowercased) that always go to `important`. */
  vipSenders: string[];
  /**
   * Sender patterns to auto-archive (label as `later` then UI hides via
   * filter). Each entry is a string with optional `*` wildcards. The
   * wildcard is matched against email and domain.
   */
  muteSenders: string[];
  /** Keyword rules applied in order; first match wins. */
  keywordRules: KeywordRule[];
}

export type RuleDecision =
  | { label: Label; reason: string; source: "rule" }
  | { decided: false; reason: string };

/**
 * Apply deterministic rules in priority order:
 *   1. VIP sender → important
 *   2. Mute sender → later
 *   3. User has prior reply in thread → important (we infer engagement)
 *   4. Keyword rules → first match
 *   5. Otherwise → undecided (caller invokes LLM)
 */
export function applyRules(
  features: EmailFeatures,
  rules: TriageRules,
): RuleDecision {
  // VIPs are exact-match (no wildcards) — explicit, fast.
  if (rules.vipSenders.includes(features.fromEmail)) {
    return {
      label: "important",
      reason: `vip:${features.fromEmail}`,
      source: "rule",
    };
  }

  // Mute matches against email or domain with `*` wildcards. Patterns
  // are compiled lazily — we expect each list to be small (< 50
  // entries) so per-message regex compile is fine.
  for (const pattern of rules.muteSenders) {
    if (
      wildcardMatch(pattern, features.fromEmail) ||
      wildcardMatch(pattern, features.fromDomain)
    ) {
      return {
        label: "later",
        reason: `mute:${pattern}`,
        source: "rule",
      };
    }
  }

  // Thread participation: if the user has previously replied in this
  // thread (Gmail's `SENT` label appearing in history), the new message
  // is highly likely to matter. Strong signal — beats keyword rules.
  if (features.hasUserReply) {
    return {
      label: "important",
      reason: "thread:user-replied-here",
      source: "rule",
    };
  }

  // Keyword rules — first match wins.
  for (const rule of rules.keywordRules) {
    if (matchesKeywordRule(rule, features)) {
      return {
        label: rule.label,
        reason: `keyword:${describeKeywordRule(rule)}`,
        source: "rule",
      };
    }
  }

  return { decided: false, reason: "no-rule-match" };
}

/**
 * Human-readable summary of what a rule matches on. Also what `rules
 * list` shows beside the id, so the user can tell two rules apart.
 */
export function describeKeywordRule(rule: KeywordRule): string {
  const parts: string[] = [];
  const subjectAny = criterionList(rule.subject_any);
  const snippetAny = criterionList(rule.snippet_any);
  const fromAddress = criterionText(rule.from_address);
  const fromDomain = criterionText(rule.from_domain);
  const subject = criterionText(rule.subject_contains);
  const snippet = criterionText(rule.snippet_contains);
  if (fromAddress) parts.push(`from=${fromAddress}`);
  if (fromDomain) parts.push(`from_domain=${fromDomain}`);
  if (subject) parts.push(`subject~"${subject}"`);
  if (subjectAny.length > 0) {
    parts.push(`subject~any(${subjectAny.join("|")})`);
  }
  if (snippet) parts.push(`snippet~"${snippet}"`);
  if (snippetAny.length > 0) {
    parts.push(`snippet~any(${snippetAny.join("|")})`);
  }
  if (rule.external) parts.push("external");
  return parts.length > 0 ? parts.join(" + ") : "malformed";
}

/** An absent criterion is satisfied; a present one must match exactly. */
function senderCriteriaMatch(
  rule: KeywordRule,
  features: EmailFeatures,
): boolean {
  const fromDomain = criterionText(rule.from_domain);
  if (fromDomain && features.fromDomain !== fromDomain.toLowerCase()) {
    return false;
  }
  const fromAddress = criterionText(rule.from_address);
  return !fromAddress || features.fromEmail === fromAddress.toLowerCase();
}

/** An absent criterion is satisfied; a present one must be a substring. */
function textCriteriaMatch(
  rule: KeywordRule,
  features: EmailFeatures,
): boolean {
  const subject = criterionText(rule.subject_contains);
  if (subject && !features.subjectLower.includes(subject.toLowerCase())) {
    return false;
  }
  const snippet = criterionText(rule.snippet_contains);
  return !snippet || features.snippetLower.includes(snippet.toLowerCase());
}

/** Within a list criterion the alternatives are an OR. */
function listCriteriaMatch(
  rule: KeywordRule,
  features: EmailFeatures,
): boolean {
  const subjectAny = criterionList(rule.subject_any);
  if (
    subjectAny.length > 0 &&
    !subjectAny.some((kw) => features.subjectLower.includes(kw.toLowerCase()))
  ) {
    return false;
  }
  const snippetAny = criterionList(rule.snippet_any);
  return (
    snippetAny.length === 0 ||
    snippetAny.some((kw) => features.snippetLower.includes(kw.toLowerCase()))
  );
}

/**
 * All criteria on a rule must hold (AND), which is what lets one rule say
 * "from this person AND this subject" — the combination #1855 item 5 asks
 * for.
 */
function matchesKeywordRule(
  rule: KeywordRule,
  features: EmailFeatures,
): boolean {
  if (!isWellFormedKeywordRule(rule)) return false;
  if (rule.external && features.isInternal) return false;
  return (
    senderCriteriaMatch(rule, features) &&
    textCriteriaMatch(rule, features) &&
    listCriteriaMatch(rule, features)
  );
}

/**
 * Tiny wildcard matcher: `*` matches any run of characters, anchored at
 * both ends. Case-insensitive. Used for `noreply@*` and `*.vendor.com`
 * shapes that users will hand-write — full regex would be overkill and
 * footgun-prone.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern || !value) return false;
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (!p.includes("*")) return p === v;
  const parts = p.split("*");
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (part.length === 0) continue;
    if (index === parts.length - 1 && !p.endsWith("*")) {
      return v.endsWith(part) && v.length - part.length >= position;
    }
    const matchAt = v.indexOf(part, position);
    if (matchAt < 0 || (index === 0 && matchAt !== 0)) return false;
    position = matchAt + part.length;
  }
  return true;
}

/**
 * Decide whether a classified message should escalate to a Chat ping.
 * Independent of the labeling decision so the user can tune them
 * separately.
 */
export interface EscalationConfig {
  senders: string[];
  keywords: string[];
  labelTriggers: Label[];
}

/**
 * Per-user escalation policy (#1172). Controls WHICH `important`
 * classifications actually ping the user's Chat DM. Stored top-level on
 * the triage row (not inside EscalationConfig) so the additive schema
 * change is inert to old rows — an absent value means the default `all`.
 *
 *   all             — today's behaviour: the label alone pings (unless the
 *                     user has narrowed escalation to specific senders /
 *                     keywords). Default for existing + new users.
 *   high-confidence — ping only rule-source matches (confidence 1) and LLM
 *                     decisions at or above `escalationConfidenceThreshold`.
 *   rules-only      — ping only explicit escalation sender/keyword matches
 *                     and deterministic rule decisions (e.g. VIP). Plain
 *                     LLM `important` never pings.
 *   none            — never ping; the digest is the sole surface.
 */
export type EscalationMode = "all" | "high-confidence" | "rules-only" | "none";

export const ESCALATION_MODES: EscalationMode[] = [
  "all",
  "high-confidence",
  "rules-only",
  "none",
];

/** Default mode — preserves pre-#1172 behaviour until a user opts in. */
export const DEFAULT_ESCALATION_MODE: EscalationMode = "all";

/** Default LLM-confidence bar for the `high-confidence` mode. */
export const DEFAULT_ESCALATION_CONFIDENCE_THRESHOLD = 0.85;

export interface EscalationDecisionParams {
  label: Label;
  /**
   * Where the classification came from. Only `rule` — the user's own
   * configured rules — is treated as an explicit instruction from the
   * user; `content` and `llm` are both the system's own judgement and so
   * stay subject to the confidence bar.
   */
  source: DecisionSource;
  /** Classifier confidence (rule matches are 1). */
  confidence: number;
  features: EmailFeatures;
  escalation: EscalationConfig;
  /** Per-user mode; defaults to `all`. */
  mode?: EscalationMode;
  /** Per-user LLM confidence bar for `high-confidence`; defaults to 0.85. */
  confidenceThreshold?: number;
}

function explicitEscalationReason(
  features: EmailFeatures,
  escalation: EscalationConfig,
): string | undefined {
  if (escalation.senders.includes(features.fromEmail)) {
    return `sender:${features.fromEmail}`;
  }
  const keyword = escalation.keywords.find((candidate) => {
    const normalized = candidate.toLowerCase();
    return (
      features.subjectLower.includes(normalized) ||
      features.snippetLower.includes(normalized)
    );
  });
  return keyword ? `keyword:${keyword}` : undefined;
}

function modeEscalationReason(
  params: EscalationDecisionParams,
  mode: Exclude<EscalationMode, "none">,
  threshold: number,
): string | undefined {
  const { label, source, confidence, escalation } = params;
  if (mode === "all") {
    const hasExplicitRules =
      escalation.senders.length > 0 || escalation.keywords.length > 0;
    return hasExplicitRules ? undefined : `label:${label}`;
  }
  if (source === "rule") return `rule:${label}`;
  // Only a real LLM call can clear the confidence bar (#1861 item 3). The
  // deterministic content stage reports a FIXED confidence, so before this
  // guard a single heuristic hit — one question mark in a marketing
  // footer — cleared the 0.85 threshold and pinged Chat. A fixed number is
  // not a calibrated one, and `high-confidence` has always been documented
  // as "rule matches and LLM decisions at or above the threshold".
  if (
    mode === "high-confidence" &&
    source === "llm" &&
    confidence >= threshold
  ) {
    return `high-confidence:${confidence.toFixed(2)}`;
  }
  return undefined;
}

/**
 * Enforce the per-user escalation policy. Explicit escalation rules
 * (sender / keyword lists) always ping in every mode except `none` — the
 * user asked to always be told about those. The MODE only governs what
 * happens to classifications that don't hit an explicit escalation rule.
 */
export function shouldEscalate(
  params: EscalationDecisionParams,
): { escalate: true; reason: string } | { escalate: false } {
  const { label, features, escalation } = params;
  const mode = params.mode ?? DEFAULT_ESCALATION_MODE;
  const threshold =
    typeof params.confidenceThreshold === "number"
      ? params.confidenceThreshold
      : DEFAULT_ESCALATION_CONFIDENCE_THRESHOLD;

  if (mode === "none") return { escalate: false };
  if (!escalation.labelTriggers.includes(label)) {
    return { escalate: false };
  }

  const explicitReason = explicitEscalationReason(features, escalation);
  if (explicitReason) return { escalate: true, reason: explicitReason };

  const modeReason = modeEscalationReason(params, mode, threshold);
  return modeReason
    ? { escalate: true, reason: modeReason }
    : { escalate: false };
}
