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
  /** Whole subject substring match, lowercased. */
  subject_contains?: string;
  /** Body snippet substring match, lowercased. */
  snippet_contains?: string;
  /** Sender domain match. */
  from_domain?: string;
  /** Require the sender to be external (not in user's org). */
  external?: boolean;
  /** Label to apply when this rule matches. */
  label: Label;
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
      const desc =
        rule.subject_contains
          ? `subject~"${rule.subject_contains}"`
          : rule.snippet_contains
            ? `snippet~"${rule.snippet_contains}"`
            : rule.from_domain
              ? `from_domain=${rule.from_domain}`
              : "rule";
      return {
        label: rule.label,
        reason: `keyword:${desc}`,
        source: "rule",
      };
    }
  }

  return { decided: false, reason: "no-rule-match" };
}

function matchesKeywordRule(
  rule: KeywordRule,
  features: EmailFeatures,
): boolean {
  if (rule.external && features.isInternal) return false;
  if (rule.from_domain && features.fromDomain !== rule.from_domain.toLowerCase()) {
    return false;
  }
  if (
    rule.subject_contains &&
    !features.subjectLower.includes(rule.subject_contains.toLowerCase())
  ) {
    return false;
  }
  if (
    rule.snippet_contains &&
    !features.snippetLower.includes(rule.snippet_contains.toLowerCase())
  ) {
    return false;
  }
  // Require at least one positive criterion — a rule with only an
  // `external` filter would match everything external; that's almost
  // certainly a misconfiguration, so we refuse to match.
  return Boolean(
    rule.from_domain || rule.subject_contains || rule.snippet_contains,
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
  /** Where the classification came from — a deterministic rule or the LLM. */
  source: "rule" | "llm";
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
