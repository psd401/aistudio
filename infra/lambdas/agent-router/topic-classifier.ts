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
export const TAXONOMY = [
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
    /\bmeeting/i,
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
