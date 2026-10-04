/**
 * Shared types for the triage classifier Lambda.
 *
 * Mirrors the DynamoDB row shape defined in
 * infra/lib/agent-platform-stack.ts (AgentEmailTriageTable). Keep both
 * in sync when adding new attributes.
 */

import type {
  Label,
  TriageRules,
  EscalationConfig,
  EscalationMode,
} from "./rules";
import type { ContentShape } from "./content-features";

export type { Label, TriageRules, EscalationConfig, EscalationMode };

/**
 * Label keys present in the DDB row. The three classifier-assignable
 * labels (`Label` type from rules) plus `"task"` which is user-only —
 * applied by the human in Gmail and never by the classifier itself.
 */
export type LabelKey = Label | "task";

/** Modes for the user-gesture task-creation feature (Phase 1.5). */
export type TasksMode = "none" | "invoke-agent";

export interface TriageRow {
  userEmail: string;
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string | null;
  classifierStartHistoryId?: string;
  lastHistoryId?: string;
  lastPollAt?: string;
  labels: Partial<Record<LabelKey, string>>;
  labelIdsByKey?: Partial<Record<LabelKey, string>>;
  labelMappingVersion?: number;
  labelMappingProvenance?: string;
  labelMappingOwnerEmail?: string;
  labelMappingResolvedAt?: string;
  rules: TriageRules;
  escalation: EscalationConfig;
  digestEnabled: boolean;
  digestTime?: string;
  digestTz?: string;
  digestScheduleArn?: string;
  recentDecisions: DecisionRecord[];
  recentCorrections: CorrectionRecord[];
  learnedPatterns?: LearnedPattern[];
  /**
   * Per-user escalation policy (#1172). Absent ⇒ `all` (legacy behaviour —
   * nobody's escalations change until they opt in).
   */
  escalationMode?: EscalationMode;
  /** LLM-confidence bar for `high-confidence` mode. Absent ⇒ 0.85. */
  escalationConfidenceThreshold?: number;
  /**
   * Pending rule suggestions surfaced by the nightly learning job
   * (#1172). Applied only when the user approves via the skill's
   * `suggestions apply <id>` subcommand.
   */
  pendingSuggestions?: Suggestion[];
  /** Suggestion ids the user dismissed — never re-raised. */
  dismissedSuggestions?: string[];
  /** Suggestion ids the user has applied — audit trail, not re-raised. */
  appliedSuggestions?: string[];
  /**
   * Content-shape leanings mined from this user's corrections (#1855).
   * Unlike `learnedPatterns` these key on what a message ASKS rather than
   * on who sent it, so a correction changes behaviour for every sender
   * that writes the same kind of mail.
   */
  contentPreferences?: ContentPreference[];
  /**
   * The user's own preferences in plain language (#1855 acceptance 4).
   * Written by the user through the skill and passed verbatim to the
   * classifier. Nothing in code is specific to any one person.
   */
  preferences?: UserPreferenceProfile;
  /**
   * Opt-out for rule suggestions that target a person (#1855 item 3).
   * Absent ⇒ true. Mute suggestions against human senders are refused
   * regardless of this setting; this switch additionally silences VIP
   * suggestions about people.
   */
  suggestPeopleRules?: boolean;
  /**
   * Per-day triage counters, keyed `YYYY-MM-DD` in the user's digest
   * timezone (#1855 addendum 1). The digest reports from these; the
   * 20-entry `recentDecisions` buffer can only ever say "20".
   */
  dailyStats?: Record<string, DailyStat>;
  /** ISO timestamp of the last digest posted — bounds the next window. */
  lastDigestAt?: string;
  /** ISO timestamp of the last nightly learning run. */
  learnedAt?: string;
  /** Initial-inbox-sweep state (#1172). Absent ⇒ no sweep requested. */
  sweep?: SweepState;
  /** Internal-domain hint, set on enable from the user's email. */
  internalDomain?: string;
  /** Chat DM space resource name, set on enable when known. */
  dmSpaceName?: string;
  /**
   * Task-gesture feature: when the user labels an email with `@psd/Task`,
   * what does the system do?
   *   - `none`      — leave the message in the @psd/Task label, do nothing
   *   - `invoke-agent` — fire AgentCore with the email metadata so the
   *     user's agent (per their MEMORY.md instructions + skills) creates
   *     a task in their preferred task system. On success the email is
   *     archived (INBOX + @psd/Task removed).
   *
   * Default: `none`. Set via the agent skill (`triage tasks mode …`).
   */
  tasksMode?: TasksMode;
  /**
   * When task-creation succeeds, post a one-line confirmation card to
   * Chat. Defaults to `false`; user can flip on while building trust in
   * the workflow. Failures always surface in Chat regardless.
   */
  tasksNotifySuccess?: boolean;
  /**
   * AgentCore Runtime ID to invoke for task-creation requests. Comes
   * from the AGENTCORE_RUNTIME_ID env var if absent on the row (the
   * Lambda falls back to env). Stored on the row so future per-user
   * runtime pinning is possible without code changes.
   */
  agentcoreRuntimeId?: string;
}

/**
 * Where a label came from.
 *   rule    — one of the user's own configured rules (VIP, mute, keyword)
 *   content — the deterministic, sender-independent content stage (#1855)
 *   llm     — the Bedrock fallback
 */
export type DecisionSource = "rule" | "content" | "llm";

export interface DecisionRecord {
  messageId: string;
  threadId: string;
  label: Label;
  source: DecisionSource;
  reason: string;
  confidence: number;
  ts: string;
  /** Snapshot of sender + subject so we can show training context later. */
  fromEmail: string;
  subject: string;
  /**
   * Body snippet, so `training recent` can be reviewed by content rather
   * than by sender (#1855 item 6).
   */
  snippet?: string;
  /**
   * What the message asked of the reader. Corrections are learned against
   * this, which is how a correction generalises beyond one sender.
   */
  shape?: ContentShape;
  /** True when the sender is an automated mailbox rather than a person. */
  automatedSender?: boolean;
  /**
   * Gmail history id of the classifier's own label write (which also
   * removes INBOX). History at or before it is ours, not a user gesture.
   */
  labeledHistoryId?: string;
}

/**
 * A learned leaning for one content shape — "you keep archiving FYI
 * digests" becomes `{ shape: "fyi", lean: "later", … }` and demotes the
 * next FYI digest from any sender.
 */
export interface ContentPreference {
  shape: ContentShape;
  lean: Label;
  /** Age-decayed strength, same half-life as `learnedPatterns`. */
  weight: number;
  /** Number of corrections behind this leaning. */
  count: number;
}

/** The user's plain-language preference profile (#1855 acceptance 4). */
export interface UserPreferenceProfile {
  /** Free text the user wrote, passed to the classifier verbatim. */
  text?: string;
  updatedAt?: string;
}

/** One day's triage counters. */
export interface DailyStat {
  total: number;
  important: number;
  later: number;
  news: number;
  rule: number;
  llm: number;
  corrections: number;
}

export interface CorrectionRecord {
  messageId: string;
  fromLabel: Label;
  /**
   * Where the user moved the message:
   *   "inbox"    — un-archived (added INBOX back) something we labelled later/news
   *   "archived" — archived (removed INBOX) something we labelled important
   *   Label      — directly re-labelled to one of our three slots
   */
  toLabel: Label | "inbox" | "archived";
  ts: string;
  /**
   * Sender of the corrected message, snapshotted from the prior decision
   * so the nightly learning job (#1172) can attribute the correction to a
   * sender/domain without re-fetching from Gmail. Absent on pre-#1172
   * corrections (learning tolerates their omission).
   */
  fromEmail?: string;
  /** Sender domain, derived from `fromEmail`. */
  fromDomain?: string;
  /**
   * Content shape of the corrected message, snapshotted from the prior
   * decision. This is what makes a correction generalise past the one
   * sender it happened to arrive from (#1855).
   */
  shape?: ContentShape;
  /** Whether the corrected message came from an automated mailbox. */
  automatedSender?: boolean;
}

export interface LearnedPattern {
  /** Sender email or domain the pattern keys on. */
  pattern: string;
  /** Accumulated, age-decayed strength of the signal. */
  weight: number;
  /** How the pattern was derived (e.g. `correction`). */
  source: string;
  /** What the pattern argues for — demote/mute vs. promote/VIP. */
  kind?: "mute" | "vip";
  /** Number of corrections that fed this pattern. */
  count?: number;
}

/**
 * A pending, user-approvable rule suggestion produced by the nightly
 * learning job (#1172). Hard rules are suggest-only: a suggestion is
 * applied to `rules` only when the user runs `suggestions apply <id>`.
 */
export interface Suggestion {
  /** Stable id (e.g. `mute:noreply@x.com`) — dedupes + dismiss tracking. */
  id: string;
  kind: "mute" | "vip";
  /** Sender email (vip) or wildcard pattern (mute) the rule would add. */
  target: string;
  /** Human-readable rationale for the Chat card + admin page. */
  reason: string;
  /** Number of corrections behind this suggestion. */
  count: number;
  /** Age-decayed weight at suggestion time. */
  weight: number;
  createdAt: string;
}

/**
 * Initial-inbox-sweep progress (#1172). Time-budgeted slices persist this
 * so a sweep interrupted by a Lambda timeout resumes on the next tick.
 */
export interface SweepState {
  status: "pending" | "running" | "complete" | "error";
  /** Gmail messages.list pageToken for the next slice; null ⇒ start/done. */
  pageToken?: string | null;
  /** Messages examined so far (counts toward the cap). */
  processed: number;
  /** Messages we actually applied a label to. */
  labeled: number;
  /** Newest-30-days window in days (30) and hard message cap (1000). */
  windowDays: number;
  cap: number;
  startedAt?: string;
  updatedAt?: string;
  /** Populated when status === "error". */
  error?: string;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  internalDate: string;
  labelIds: string[];
}

export interface ClassifierResult {
  label: Label;
  confidence: number;
  reason: string;
  source: DecisionSource;
}
