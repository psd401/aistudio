export const EMAIL_TRIAGE_LABELS = {
  important: "@psd/Important",
  later: "@psd/Later",
  news: "@psd/News",
  task: "@psd/Task",
} as const;

export type EmailTriageLabelKey = keyof typeof EMAIL_TRIAGE_LABELS;

export const EMAIL_TRIAGE_LABEL_MAPPING_VERSION = 1;
export const EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE =
  "owner-gmail-label-resolution";

const SAFE_GMAIL_ID = /^[A-Za-z0-9_-]{1,256}$/;
const GMAIL_SYSTEM_IDS = new Set([
  "CHAT",
  "DRAFT",
  "IMPORTANT",
  "INBOX",
  "SENT",
  "SPAM",
  "STARRED",
  "TRASH",
  "UNREAD",
]);

export interface GmailLabelDescriptor {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

export interface TrustedEmailTriageLabelState {
  userEmail: string;
  labels?: unknown;
  labelIdsByKey?: unknown;
  labelMappingVersion?: unknown;
  labelMappingProvenance?: unknown;
  labelMappingOwnerEmail?: unknown;
  labelMappingResolvedAt?: unknown;
}

export interface TrustedEmailTriageLabelMapping {
  labels: typeof EMAIL_TRIAGE_LABELS;
  labelIdsByKey: Record<EmailTriageLabelKey, string>;
  labelMappingVersion: typeof EMAIL_TRIAGE_LABEL_MAPPING_VERSION;
  labelMappingProvenance: typeof EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE;
  labelMappingOwnerEmail: string;
  labelMappingResolvedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeUserLabelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_GMAIL_ID.test(value) &&
    !GMAIL_SYSTEM_IDS.has(value)
  );
}

export function createTrustedEmailTriageLabelMapping(input: {
  ownerEmail: string;
  labelIdsByKey: Record<EmailTriageLabelKey, string>;
  resolvedAt?: string;
}): TrustedEmailTriageLabelMapping {
  const ids = new Set<string>();
  for (const key of Object.keys(EMAIL_TRIAGE_LABELS) as EmailTriageLabelKey[]) {
    const id = input.labelIdsByKey[key];
    if (!isSafeUserLabelId(id) || ids.has(id)) {
      throw new Error(`Invalid Gmail user label id for ${key}`);
    }
    ids.add(id);
  }
  return {
    labels: EMAIL_TRIAGE_LABELS,
    labelIdsByKey: input.labelIdsByKey,
    labelMappingVersion: EMAIL_TRIAGE_LABEL_MAPPING_VERSION,
    labelMappingProvenance: EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE,
    labelMappingOwnerEmail: input.ownerEmail,
    labelMappingResolvedAt: input.resolvedAt ?? new Date().toISOString(),
  };
}

/**
 * Fail closed unless the mapping was written by the owner-bound resolution
 * operation and still resolves to the exact expected user labels in Gmail.
 */
export function validateTrustedEmailTriageLabelMapping(
  state: TrustedEmailTriageLabelState,
  liveLabels: readonly GmailLabelDescriptor[]
):
  | { valid: true; labelIdsByKey: Record<EmailTriageLabelKey, string> }
  | { valid: false; reason: string } {
  const stored = validateStoredEmailTriageLabelMapping(state);
  if (!stored.valid) return stored;

  for (const key of Object.keys(EMAIL_TRIAGE_LABELS) as EmailTriageLabelKey[]) {
    const expectedName = EMAIL_TRIAGE_LABELS[key];
    const id = stored.labelIdsByKey[key];
    const exactMatches = liveLabels.filter(
      (label) =>
        label.id === id &&
        label.name === expectedName &&
        label.type === "user"
    );
    if (exactMatches.length !== 1) {
      return { valid: false, reason: "missing-or-unrelated-live-label" };
    }
  }
  return stored;
}

export function validateStoredEmailTriageLabelMapping(
  state: TrustedEmailTriageLabelState
):
  | { valid: true; labelIdsByKey: Record<EmailTriageLabelKey, string> }
  | { valid: false; reason: string } {
  if (
    state.labelMappingVersion !== EMAIL_TRIAGE_LABEL_MAPPING_VERSION ||
    state.labelMappingProvenance !== EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE ||
    state.labelMappingOwnerEmail !== state.userEmail ||
    typeof state.labelMappingResolvedAt !== "string" ||
    !Number.isFinite(Date.parse(state.labelMappingResolvedAt))
  ) {
    return { valid: false, reason: "untrusted-or-stale-provenance" };
  }
  if (!isRecord(state.labels) || !isRecord(state.labelIdsByKey)) {
    return { valid: false, reason: "malformed-mapping" };
  }

  const ids = Object.create(null) as Record<EmailTriageLabelKey, string>;
  const seen = new Set<string>();
  for (const key of Object.keys(EMAIL_TRIAGE_LABELS) as EmailTriageLabelKey[]) {
    const expectedName = EMAIL_TRIAGE_LABELS[key];
    const id = state.labelIdsByKey[key];
    if (state.labels[key] !== expectedName || !isSafeUserLabelId(id)) {
      return { valid: false, reason: "invalid-or-system-label" };
    }
    if (seen.has(id)) {
      return { valid: false, reason: "duplicate-label-id" };
    }
    seen.add(id);
    ids[key] = id;
  }
  return { valid: true, labelIdsByKey: ids };
}
