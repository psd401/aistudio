import { createHash } from "node:crypto";
import type {
  RepositoryMigrationItemStatus,
  RepositoryMigrationMetrics,
} from "@/lib/db/schema";

export interface MigrationContentEvidence {
  recordCount: number;
  sha256: string | null;
}

function normalizeSegment(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Hash a stable, ordered content snapshot. Empty inputs deliberately have no
 * hash so "no extracted content" cannot be mistaken for a verified empty file.
 */
export function buildMigrationContentEvidence(
  orderedSegments: string[],
): MigrationContentEvidence {
  const normalized = orderedSegments
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0);
  if (normalized.length === 0) {
    return { recordCount: 0, sha256: null };
  }
  return {
    recordCount: normalized.length,
    sha256: createHash("sha256").update(normalized.join("\n")).digest("hex"),
  };
}

export interface ReconciliationEvidence {
  sourceObjectSha256: string | null;
  canonicalObjectSha256: string | null;
  sourceContent: MigrationContentEvidence;
  canonicalContent: MigrationContentEvidence;
  processingStatus: string | null;
  approvedMismatch: boolean;
}

export interface ReconciliationDecision {
  status: Extract<RepositoryMigrationItemStatus, "verified" | "mismatch">;
  reasons: string[];
}

export function isMigrationOwnedCanonicalVersion(input: {
  sourceKind: string;
  objectKey: string | null;
  metadata: Record<string, unknown>;
  expectedObjectKey: string;
  expectedSourceKind: string;
  expectedSourceId: number;
}): boolean {
  return (
    input.sourceKind === "migration" &&
    input.objectKey === input.expectedObjectKey &&
    input.metadata.migrationSourceKind === input.expectedSourceKind &&
    Number(input.metadata.migrationSourceId) === input.expectedSourceId
  );
}

export function buildMigrationRollbackObjectKeys(
  artifactKeys: string[],
  canonicalObjectKey: string | null,
): string[] {
  return [
    ...new Set([
      ...artifactKeys.filter((objectKey) => objectKey.length > 0),
      ...(canonicalObjectKey ? [canonicalObjectKey] : []),
    ]),
  ];
}

export function reconcileMigrationEvidence(
  evidence: ReconciliationEvidence,
): ReconciliationDecision {
  const reasons: string[] = [];
  if (evidence.processingStatus !== "completed") {
    reasons.push(
      `canonical processing is ${evidence.processingStatus ?? "missing"}`,
    );
  }
  if (!evidence.canonicalObjectSha256) {
    reasons.push("canonical source SHA-256 is missing");
  } else if (
    evidence.sourceObjectSha256 &&
    evidence.sourceObjectSha256 !== evidence.canonicalObjectSha256
  ) {
    reasons.push("source object SHA-256 differs");
  }
  if (evidence.canonicalContent.recordCount === 0) {
    reasons.push("canonical extraction produced no content records");
  }
  // Record counts remain useful rollout telemetry, but they cannot be a parity
  // predicate: canonical processing intentionally resegments legacy extracts
  // under the current tokenizer/section contract. Full normalized text hashes
  // prove content parity independently of those chunk boundaries.
  if (
    evidence.sourceContent.sha256 &&
    evidence.sourceContent.sha256 !== evidence.canonicalContent.sha256
  ) {
    reasons.push("extracted content SHA-256 differs");
  }

  return {
    status:
      reasons.length === 0 || evidence.approvedMismatch
        ? "verified"
        : "mismatch",
    reasons,
  };
}

export interface RetirementReadinessInput {
  cutoversEnabled: boolean;
  retirementConfigured: boolean;
  dryRunCompleted: boolean;
  inventoryComplete: boolean;
  activeRunCount: number;
  migrationMetrics: RepositoryMigrationMetrics;
  rollbackDrillCompleted: boolean;
  recoveryWindowEndsAt: Date | null;
  now?: Date;
}

export interface RetirementReadiness {
  ready: boolean;
  blockers: string[];
}

export function assessContentRetirementReadiness(
  input: RetirementReadinessInput,
): RetirementReadiness {
  const blockers: string[] = [];
  const metrics = input.migrationMetrics;
  if (!input.cutoversEnabled) {
    blockers.push("all product cutovers are not enabled");
  }
  if (!input.retirementConfigured) {
    blockers.push("legacy retirement is not enabled");
  }
  if (!input.dryRunCompleted) {
    blockers.push("a completed migration dry run has not been recorded");
  }
  if (!input.inventoryComplete) {
    blockers.push("legacy source inventory is not fully verified");
  }
  if (input.activeRunCount > 0) {
    blockers.push("a migration control run is still active");
  }
  if ((metrics.failed ?? 0) > 0) blockers.push("failed migrations remain");
  if ((metrics.unrecoverable ?? 0) > 0) {
    blockers.push("unrecoverable sources remain");
  }
  if ((metrics.mismatched ?? 0) > 0) {
    blockers.push("unapproved reconciliation mismatches remain");
  }
  if ((metrics.migrated ?? 0) !== (metrics.verified ?? 0)) {
    blockers.push("not every migrated source is verified");
  }
  if ((metrics.discovered ?? 0) !== (metrics.verified ?? 0)) {
    blockers.push("not every tracked source is verified");
  }
  if (!input.rollbackDrillCompleted) {
    blockers.push("a rollback drill has not been recorded");
  }
  if (!input.recoveryWindowEndsAt) {
    blockers.push("the recovery window has not started");
  } else if (input.recoveryWindowEndsAt > (input.now ?? new Date())) {
    blockers.push("the recovery window has not elapsed");
  }
  return { ready: blockers.length === 0, blockers };
}
