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

type TriageLabelKey = keyof typeof TRIAGE_LABEL_NAMES;

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

export function validateStoredTriageLabelMapping(
  row: TriageRow,
):
  | { valid: true; labelIdsByKey: Record<TriageLabelKey, string> }
  | { valid: false; reason: string } {
  if (
    row.labelMappingVersion !== TRIAGE_LABEL_MAPPING_VERSION ||
    row.labelMappingProvenance !== TRIAGE_LABEL_MAPPING_PROVENANCE ||
    row.labelMappingOwnerEmail !== row.userEmail ||
    typeof row.labelMappingResolvedAt !== "string" ||
    !Number.isFinite(Date.parse(row.labelMappingResolvedAt))
  ) {
    return { valid: false, reason: "untrusted-or-stale-provenance" };
  }

  const ids = Object.create(null) as Record<TriageLabelKey, string>;
  const seen = new Set<string>();
  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    const id = row.labelIdsByKey?.[key];
    if (
      row.labels?.[key] !== TRIAGE_LABEL_NAMES[key] ||
      !isSafeUserLabelId(id) ||
      seen.has(id)
    ) {
      return { valid: false, reason: "invalid-or-system-label" };
    }
    seen.add(id);
    ids[key] = id;
  }
  return { valid: true, labelIdsByKey: ids };
}

export async function resolveTrustedTriageLabelMapping(
  row: TriageRow,
  loadLiveLabels: () => Promise<readonly GmailLabel[]>,
): Promise<Record<TriageLabelKey, string> | null> {
  const stored = validateStoredTriageLabelMapping(row);
  if (!stored.valid) return null;
  const liveLabels = await loadLiveLabels();
  for (const key of Object.keys(TRIAGE_LABEL_NAMES) as TriageLabelKey[]) {
    const matches = liveLabels.filter(
      (label) =>
        label.id === stored.labelIdsByKey[key] &&
        label.name === TRIAGE_LABEL_NAMES[key] &&
        label.type === "user",
    );
    if (matches.length !== 1) return null;
  }
  return stored.labelIdsByKey;
}
