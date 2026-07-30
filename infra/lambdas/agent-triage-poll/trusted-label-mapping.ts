import type { GmailLabel } from "./gmail";
import {
  resolveCanonicalTriageLabelMapping,
  resolveTrustedTriageLabelMapping,
  validateStoredTriageLabelMapping,
  type TrustedTriageLabelMapping,
} from "./label-mapping";
import type { TriageRow } from "./types";

interface TrustedLabelMappingDependencies {
  loadLiveLabels: () => Promise<readonly GmailLabel[]>;
  stampTrustedMapping: (
    mapping: TrustedTriageLabelMapping,
  ) => Promise<void>;
  log: (
    level: "INFO" | "WARN" | "ERROR",
    evt: string,
    fields: Record<string, unknown>,
  ) => void;
}

/**
 * Resolve a row's trusted label mapping, self-healing only the legacy/stale
 * provenance case. All other invalid stored state and every ambiguous or
 * unsafe live mapping remain fail-closed.
 */
export async function loadTrustedLabelMappingForRow(
  row: TriageRow,
  dependencies: TrustedLabelMappingDependencies,
): Promise<TrustedTriageLabelMapping | null> {
  const stored = validateStoredTriageLabelMapping(row);
  if (!stored.valid && stored.reason === "untrusted-or-stale-provenance") {
    return healTrustedLabelMapping(row, dependencies, stored.reason);
  }
  if (!stored.valid) {
    logUntrustedLabelMapping(row, dependencies, stored.reason);
    return null;
  }

  const verified = await resolveTrustedTriageLabelMapping(
    row,
    dependencies.loadLiveLabels,
  );
  if (!verified.valid) {
    logUntrustedLabelMapping(row, dependencies, verified.reason);
    return null;
  }
  return verified.mapping;
}

async function healTrustedLabelMapping(
  row: TriageRow,
  dependencies: TrustedLabelMappingDependencies,
  storedReason: string,
): Promise<TrustedTriageLabelMapping | null> {
  if (!row.enabled) {
    logUntrustedLabelMapping(row, dependencies, storedReason);
    return null;
  }
  const healed = await resolveCanonicalTriageLabelMapping(
    row.userEmail,
    dependencies.loadLiveLabels,
  );
  if (!healed.valid) {
    logUntrustedLabelMapping(row, dependencies, healed.reason);
    return null;
  }
  await dependencies.stampTrustedMapping(healed.mapping);
  dependencies.log("INFO", "label_mapping_healed", {
    user: row.userEmail,
    resolvedAt: healed.mapping.labelMappingResolvedAt,
  });
  return healed.mapping;
}

function logUntrustedLabelMapping(
  row: TriageRow,
  dependencies: TrustedLabelMappingDependencies,
  reason: string,
): void {
  dependencies.log("ERROR", "untrusted_label_mapping", {
    user: row.userEmail,
    reason,
  });
}
