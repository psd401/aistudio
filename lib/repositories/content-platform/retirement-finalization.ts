import {
  assessContentRetirementReadiness,
  type RetirementReadiness,
} from "./migration-reconciliation";

export const LEGACY_RETIREMENT_CONFIRMATION = "RETIRE_LEGACY_CONTENT";

export interface LegacyRetirementArguments {
  execute: boolean;
  confirmed: boolean;
}

export function parseLegacyRetirementArguments(
  args: string[],
): LegacyRetirementArguments {
  return {
    execute: args.includes("--execute"),
    confirmed: args.includes(
      `--confirmation=${LEGACY_RETIREMENT_CONFIRMATION}`,
    ),
  };
}

export interface LegacyRetirementDatabaseSnapshot {
  activeRuns: number;
  dryRuns: number;
  discovered: number;
  migrated: number;
  verified: number;
  mismatched: number;
  failed: number;
  unrecoverable: number;
  rollbackDrills: number;
  recoveryWindowEndsAt: Date | null;
  cutoversEnabled: boolean;
  retirementConfigured: boolean;
  documentsTablePresent: boolean;
  documentChunksTablePresent: boolean;
  documentCount: number;
  documentChunkCount: number;
  assistantPdfJobCount: number;
  priorRetirementEvents: number;
  inventoryComplete: boolean;
}

export interface LegacyRetirementAssessment extends RetirementReadiness {
  alreadyFinalized: boolean;
}

export function assessLegacyRetirementFinalization(
  snapshot: LegacyRetirementDatabaseSnapshot,
  now = new Date(),
): LegacyRetirementAssessment {
  const alreadyFinalized =
    snapshot.priorRetirementEvents > 0 &&
    !snapshot.documentsTablePresent &&
    !snapshot.documentChunksTablePresent;
  if (alreadyFinalized) {
    return { ready: true, blockers: [], alreadyFinalized: true };
  }

  const readiness = assessContentRetirementReadiness({
    cutoversEnabled: snapshot.cutoversEnabled,
    retirementConfigured: snapshot.retirementConfigured,
    dryRunCompleted: snapshot.dryRuns > 0,
    inventoryComplete: snapshot.inventoryComplete,
    activeRunCount: snapshot.activeRuns,
    migrationMetrics: {
      discovered: snapshot.discovered,
      migrated: snapshot.migrated,
      verified: snapshot.verified,
      mismatched: snapshot.mismatched,
      failed: snapshot.failed,
      unrecoverable: snapshot.unrecoverable,
    },
    rollbackDrillCompleted: snapshot.rollbackDrills > 0,
    recoveryWindowEndsAt: snapshot.recoveryWindowEndsAt,
    now,
  });
  const blockers = [...readiness.blockers];
  if (!snapshot.documentsTablePresent) {
    blockers.push(
      "legacy documents table is absent without retirement evidence",
    );
  }
  if (!snapshot.documentChunksTablePresent) {
    blockers.push(
      "legacy document_chunks table is absent without retirement evidence",
    );
  }
  return { ready: blockers.length === 0, blockers, alreadyFinalized: false };
}
