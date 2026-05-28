/**
 * Shared types for the triage classifier Lambda.
 *
 * Mirrors the DynamoDB row shape defined in
 * infra/lib/agent-platform-stack.ts (AgentEmailTriageTable). Keep both
 * in sync when adding new attributes.
 */

import type { Label, TriageRules, EscalationConfig } from "./rules";

export type { Label, TriageRules, EscalationConfig };

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
  labelIdsByKey: Partial<Record<LabelKey, string>>;
  rules: TriageRules;
  escalation: EscalationConfig;
  digestEnabled: boolean;
  digestTime?: string;
  digestTz?: string;
  digestScheduleArn?: string;
  recentDecisions: DecisionRecord[];
  recentCorrections: CorrectionRecord[];
  learnedPatterns?: LearnedPattern[];
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

export interface DecisionRecord {
  messageId: string;
  threadId: string;
  label: Label;
  source: "rule" | "llm";
  reason: string;
  confidence: number;
  ts: string;
  /** Snapshot of sender + subject so we can show training context later. */
  fromEmail: string;
  subject: string;
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
}

export interface LearnedPattern {
  pattern: string;
  weight: number;
  source: string;
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
  source: "rule" | "llm";
}
