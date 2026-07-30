import type { GmailLabel } from "./gmail";
import type { TriageRow } from "./types";

export const TRIAGE_LABEL_MAPPING_VERSION = 1;
export const TRIAGE_LABEL_MAPPING_PROVENANCE =
  "owner-gmail-label-resolution";
export const TRIAGE_LABEL_NAMES = {
  important: "@psd/Important",
  later: "@psd/Later",
  news: "@psd/News",
  task: "@psd/Task",
} as const;

export type TriageLabelKey = keyof typeof TRIAGE_LABEL_NAMES;

export interface TrustedTriageLabelMapping {
  labels: typeof TRIAGE_LABEL_NAMES;
  labelIdsByKey: Record<TriageLabelKey, string>;
  labelMappingVersion: typeof TRIAGE_LABEL_MAPPING_VERSION;
  labelMappingProvenance: typeof TRIAGE_LABEL_MAPPING_PROVENANCE;
  labelMappingOwnerEmail: string;
  labelMappingResolvedAt: string;
}

export type TriageLabelMappingResolution =
  | { valid: true; mapping: TrustedTriageLabelMapping }
  | { valid: false; reason: string };

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

function isSafeUserLabelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_GMAIL_ID.test(value) &&
    !GMAIL_SYSTEM_IDS.has(value)
  );
}

function createTrustedTriageLabelMapping(input: {
  ownerEmail: string;
  labelIdsByKey?: Partial<Record<TriageLabelKey, string>>;
  resolvedAt: string;
}): TriageLabelMappingResolution {
  const ids = Object.create(null) as Record<TriageLabelKey, string>;
  const seen = new Set<string>();
  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    const id = input.labelIdsByKey?.[key];
    if (!isSafeUserLabelId(id)) {
      return { valid: false, reason: "invalid-or-system-label" };
    }
    if (seen.has(id)) {
      return { valid: false, reason: "duplicate-label-id" };
    }
    seen.add(id);
    ids[key] = id;
  }
  return {
    valid: true,
    mapping: {
      labels: TRIAGE_LABEL_NAMES,
      labelIdsByKey: ids,
      labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
      labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
      labelMappingOwnerEmail: input.ownerEmail,
      labelMappingResolvedAt: input.resolvedAt,
    },
  };
}

export function validateStoredTriageLabelMapping(
  row: TriageRow,
): TriageLabelMappingResolution {
  const resolvedAt = row.labelMappingResolvedAt;
  if (
    row.labelMappingVersion !== TRIAGE_LABEL_MAPPING_VERSION ||
    row.labelMappingProvenance !== TRIAGE_LABEL_MAPPING_PROVENANCE ||
    row.labelMappingOwnerEmail !== row.userEmail ||
    typeof resolvedAt !== "string" ||
    !Number.isFinite(Date.parse(resolvedAt))
  ) {
    return { valid: false, reason: "untrusted-or-stale-provenance" };
  }

  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    if (row.labels?.[key] !== TRIAGE_LABEL_NAMES[key]) {
      return { valid: false, reason: "invalid-or-system-label" };
    }
  }
  return createTrustedTriageLabelMapping({
    ownerEmail: row.userEmail,
    labelIdsByKey: row.labelIdsByKey,
    resolvedAt,
  });
}

export async function resolveTrustedTriageLabelMapping(
  row: TriageRow,
  loadLiveLabels: () => Promise<readonly GmailLabel[]>,
): Promise<TriageLabelMappingResolution> {
  const stored = validateStoredTriageLabelMapping(row);
  if (!stored.valid) return stored;
  const liveLabels = await loadLiveLabels();
  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    const matches = liveLabels.filter(
      (label) =>
        label.id === stored.mapping.labelIdsByKey[key] &&
        label.name === TRIAGE_LABEL_NAMES[key] &&
        label.type === "user",
    );
    if (matches.length !== 1) {
      return { valid: false, reason: "missing-or-unrelated-live-label" };
    }
  }
  return stored;
}

/**
 * Rebuild a trusted mapping exclusively from code-constant names and the
 * owner's live Gmail labels. Row-provided names and ids are deliberately not
 * accepted here: this is the recovery boundary for legacy or stale rows.
 */
export async function resolveCanonicalTriageLabelMapping(
  ownerEmail: string,
  loadLiveLabels: () => Promise<readonly GmailLabel[]>,
  resolvedAt = new Date().toISOString(),
): Promise<TriageLabelMappingResolution> {
  const liveLabels = await loadLiveLabels();
  const labelIdsByKey: Partial<Record<TriageLabelKey, string>> =
    Object.create(null);

  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    const matches = liveLabels.filter(
      (label) =>
        label.name === TRIAGE_LABEL_NAMES[key] && label.type === "user",
    );
    if (matches.length !== 1) {
      return { valid: false, reason: "missing-or-ambiguous-live-label" };
    }
    labelIdsByKey[key] = matches[0].id;
  }

  return createTrustedTriageLabelMapping({
    ownerEmail,
    labelIdsByKey,
    resolvedAt,
  });
}
