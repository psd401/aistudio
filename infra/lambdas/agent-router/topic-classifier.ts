/**
 * Topic classifier for the Organizational Nervous System.
 *
 * Maps user messages to a FIXED taxonomy using keyword matching.
 * Deterministic, zero external calls, no user identity stored.
 *
 * Privacy contract (see issue #890 and #887):
 *   - Input:  raw message text (transient — never written anywhere by this module)
 *   - Output: topic label ∈ TAXONOMY ∪ {null}
 *
 * The calling code must skip classification entirely when the user has
 * prefixed the message with `[private]` — see isPrivateMessage().
 */

// Fixed taxonomy. Must remain stable over time so longitudinal patterns are
// comparable. Additions are acceptable; renames/deletions break historical
// signal data. Keep labels broad enough to avoid proxying individual users.
//
// First-match-wins in TAXONOMY order, so list the most specific buckets
// first (K-12 admin) and the catch-all categories last (general code/help).
// Otherwise "the principal asked about the curriculum budget" gets caught
// by `budget-inquiry` instead of the more specific `curriculum-request`.
export const TAXONOMY = [
  // ──────────── K-12 admin (original taxonomy, most specific) ────────────
  'attendance-policy',
  'curriculum-request',
  'behavior-support',
  'technology-issue',
  'facilities-request',
  'staffing-question',
  'budget-inquiry',
  'professional-development',
  'parent-communication',
  'scheduling-conflict',
  // ──────────── Communication + workflow ────────────
  'email-triage',
  'meeting-prep',
  'document-drafting',
  'task-planning',
  // ──────────── Tech ops + agent platform ────────────
  'agent-platform-ops',
  'skill-development',
  'data-engineering',
  'ai-model-discussion',
  'general-development',
  'incident-response',
] as const;

export type Topic = (typeof TAXONOMY)[number];

// Keyword → topic mapping. First match wins (in taxonomy order). Matching is
// case-insensitive and on whole-word boundaries where meaningful.
//
// Ambiguous messages (multi-topic or below confidence) return null. The
// organizational signal is intentionally lossy — it's better to under-classify
// than to hallucinate categories. Patterns only surface above a 3-signal /
// 2-building threshold (see pattern-scanner), so occasional misses don't harm
// signal quality.
const KEYWORDS: Record<Topic, RegExp[]> = {
  'attendance-policy': [
    /\battendanc/i,
    /\babsen/i,
    /\btardy\b/i,
    /\btruanc/i,
    /\bcheck[- ]?in\b/i,
  ],
  'curriculum-request': [
    /\bcurriculum\b/i,
    /\blesson plan/i,
    /\bsyllab/i,
    /\brubric/i,
    /\bpacing guide/i,
    /\bstandards?\b/i,
  ],
  'behavior-support': [
    /\bbehavior/i,
    /\bdiscipline\b/i,
    /\bPBIS\b/i,
    /\breferral\b/i,
    /\bsuspens/i,
    /\bconflict resolution/i,
  ],
  'technology-issue': [
    /\btech(nology)? (issue|problem|support|ticket)/i,
    /\bchromebook/i,
    /\bpassword\b/i,
    /\blogin\b/i,
    /\bwi[- ]?fi\b/i,
    /\bprinter\b/i,
    /\bnot working\b/i,
  ],
  'facilities-request': [
    /\bfacilit/i,
    /\bmaintenance\b/i,
    /\bcustodial\b/i,
    /\bhvac\b/i,
    /\bplumbing\b/i,
    /\bleak/i,
    /\blight(s|ing) (out|broken)/i,
  ],
  'staffing-question': [
    /\bstaffing\b/i,
    /\bsub(stitute)?\b/i,
    /\bhiring\b/i,
    /\bvacanc/i,
    /\bposition\b/i,
    /\bFTE\b/i,
  ],
  'budget-inquiry': [
    /\bbudget\b/i,
    /\bpurchase order\b/i,
    /\bPO\b/,
    /\bspend/i,
    /\bfunds?\b/i,
    /\breimburs/i,
    /\binvoice/i,
  ],
  'professional-development': [
    /\bprofessional development\b/i,
    /\bPD\b/,
    /\btraining\b/i,
    /\bworkshop\b/i,
    /\bcourse\b/i,
    /\bconference\b/i,
  ],
  'parent-communication': [
    /\bparent/i,
    /\bguardian/i,
    /\bfamily (email|letter|message|newsletter)/i,
    /\bback[- ]to[- ]school/i,
  ],
  'scheduling-conflict': [
    /\bschedul/i,
    /\bconflict/i,
    /\breschedule/i,
    /\bovertime\b/i,
  ],
  // ──────────── Communication + workflow ────────────
  'email-triage': [
    /\btriag/i,
    /\binbox\b/i,
    /\bgmail\b/i,
    /\bemail (rule|filter|label|sort|cleanup)/i,
    /\b@psd\/(important|later|news|task)\b/i,
  ],
  'meeting-prep': [
    /\bmeeting\b/i,
    /\bagenda\b/i,
    /\bone[- ]on[- ]one\b/i,
    /\b1:1\b/,
    /\bstandup\b/i,
    /\bretrospective\b/i,
    /\bkick[- ]?off\b/i,
  ],
  'document-drafting': [
    /\bdraft (a|an|the|me|some)\b/i,
    /\bwrite (a|an|the|me|some)\b/i,
    /\bmemo\b/i,
    /\bproposal\b/i,
    /\bnewsletter\b/i,
    /\bsummariz/i,
    /\boutline\b/i,
    /\bsop\b/i,
  ],
  'task-planning': [
    /\btask\b/i,
    /\bto[- ]?do\b/i,
    /\bbacklog\b/i,
    /\bsprint\b/i,
    /\bmilestone\b/i,
    /\bplan(ning)?\b/i,
    /\broadmap\b/i,
    /\bdeadline\b/i,
  ],
  // ──────────── Tech ops + agent platform ────────────
  'agent-platform-ops': [
    /\bagentcore\b/i,
    /\bopenclaw\b/i,
    /\bbedrock\b/i,
    /\bcdk\b/i,
    /\bcloudformation\b/i,
    /\bdeploy/i,
    /\blambda\b/i,
    /\becr\b/i,
    /\bdocker\b/i,
    /\bIAM\b/i,
    /\bsecrets manager\b/i,
  ],
  'skill-development': [
    /\bskill (build|develop|register|deploy)/i,
    /\bbundled skill/i,
    /\bSKILL\.md\b/i,
    /\bharness\b/i,
    /\btool (catalog|registr|definition)/i,
    /\bMCP server\b/i,
  ],
  'data-engineering': [
    /\bmigration\b/i,
    /\bschema\b/i,
    /\bpostgres/i,
    /\baurora\b/i,
    /\bdynamodb\b/i,
    /\bdrizzle\b/i,
    /\bquery (performance|plan|optimization)/i,
    /\bindex (creation|tuning|missing)/i,
  ],
  'ai-model-discussion': [
    /\bclaude\b/i,
    /\bgpt[- ]?[0-9]?\b/i,
    /\bllm\b/i,
    /\bopen ?ai\b/i,
    /\banthropic\b/i,
    /\bnova micro\b/i,
    /\bsonnet\b/i,
    /\bhaiku\b/i,
    /\bopus\b/i,
    /\bmodel (selection|swap|choice|comparison)/i,
    /\btoken usage\b/i,
    /\bprompt (engineering|tuning|template)/i,
  ],
  'general-development': [
    /\brefactor\b/i,
    /\btypecheck\b/i,
    /\bunit test\b/i,
    /\bpull request\b/i,
    /\bcommit\b/i,
    /\bbranch\b/i,
    /\bgit\b/i,
    /\bnpm\b/i,
    /\bbun\b/i,
    /\beslint\b/i,
    /\bfix (the|a|that|this|my)\b/i,
    /\bbug\b/i,
    /\bdebug/i,
    /\berror\b/i,
    /\bstack trace\b/i,
  ],
  'incident-response': [
    /\bincident\b/i,
    /\boutage\b/i,
    /\bpostmortem\b/i,
    /\bpost[- ]mortem\b/i,
    /\b(p0|p1|sev[- ]?\d)\b/i,
    /\brollback\b/i,
    /\bhotfix\b/i,
    /\b5xx\b/i,
    /\bcloudwatch alarm/i,
  ],
};

/**
 * Returns true if the message is prefixed with `[private]` (case-insensitive).
 * Callers MUST skip classification entirely when this returns true — no
 * topic label, no signal write, no classifier side effects.
 */
export function isPrivateMessage(text: string): boolean {
  return /^\s*\[private\]/i.test(text);
}

/**
 * Classify a message into the fixed taxonomy, or return null when no
 * keyword matches or when the message is too short to be meaningful.
 */
export function classifyTopic(text: string): Topic | null {
  if (!text) return null;

  // Skip very short messages — too little signal for reliable classification.
  // The threshold (20 chars) is deliberately conservative; the goal is to
  // avoid "ok", "thanks", emoji-only replies polluting pattern analysis.
  if (text.trim().length < 20) return null;

  for (const topic of TAXONOMY) {
    const patterns = KEYWORDS[topic];
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return topic;
      }
    }
  }
  return null;
}

/**
 * ISO 8601 week identifier (e.g., "2026-W17"). Used as the grain for
 * signal-store rollups. Monday-based weeks.
 *
 * NOTE: This implementation is duplicated in agent-pattern-scanner/index.ts
 * and shared/iso-week.ts. Each Lambda has an isolated Docker build context
 * that prevents cross-directory imports. The canonical source of truth is
 * infra/lambdas/shared/iso-week.ts — keep all copies in sync.
 */
export function isoWeek(date: Date = new Date()): string {
  // Shift to Thursday of the current week — ISO weeks are defined by the
  // week containing the first Thursday of the year.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNr =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    );
  return `${target.getUTCFullYear()}-W${String(weekNr).padStart(2, '0')}`;
}
