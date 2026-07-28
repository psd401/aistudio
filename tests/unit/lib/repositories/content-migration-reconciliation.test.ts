/** @jest-environment node */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assessContentRetirementReadiness,
  buildMigrationContentEvidence,
  buildMigrationRollbackObjectKeys,
  isMigrationOwnedCanonicalVersion,
  reconcileMigrationEvidence,
} from "@/lib/repositories/content-platform/migration-reconciliation";
import {
  buildLegacyMigrationFallbackBody,
  deterministicMigrationSourceId,
  isMissingMigrationSourceObject,
  resolveVerifiedDuplicateNexusRecovery,
} from "@/lib/repositories/content-platform/migration-runner";

describe("unified content migration reconciliation", () => {
  it("recognizes only definitive S3 missing-object responses", () => {
    expect(
      isMissingMigrationSourceObject({
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    ).toBe(true);
    expect(
      isMissingMigrationSourceObject({
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    ).toBe(false);
    expect(
      isMissingMigrationSourceObject(new Error("network timeout")),
    ).toBe(false);
  });

  it("reconstructs a deterministic text source only from non-empty legacy segments", () => {
    expect(
      new TextDecoder().decode(
        buildLegacyMigrationFallbackBody([
          " first\n\n\n\n\ncontinued ",
          "",
          "second\n",
        ]) ?? undefined,
      ),
    ).toBe("first\n\n\ncontinued\nsecond");
    expect(buildLegacyMigrationFallbackBody([" ", "\n"])).toBeNull();
  });

  it("accepts only hash-consistent verified duplicate recovery evidence", () => {
    const segments = ["first section", "second section"];
    const hash = buildMigrationContentEvidence(segments).sha256;
    const differentHash =
      buildMigrationContentEvidence(["different"]).sha256;
    if (!hash || !differentHash) {
      throw new Error("Non-empty migration evidence must include a SHA-256");
    }
    expect(
      resolveVerifiedDuplicateNexusRecovery([
        {
          sourceId: 3,
          sourceRecordCount: 2,
          sourceContentSha256: hash,
          legacySegments: segments,
        },
        {
          sourceId: 4,
          sourceRecordCount: 2,
          sourceContentSha256: hash,
          legacySegments: segments,
        },
      ])
    ).toEqual({ sourceId: 3, legacySegments: segments });
    expect(
      resolveVerifiedDuplicateNexusRecovery([
        {
          sourceId: 3,
          sourceRecordCount: 2,
          sourceContentSha256: "0".repeat(64),
          legacySegments: segments,
        },
      ])
    ).toBeNull();
    expect(
      resolveVerifiedDuplicateNexusRecovery([
        {
          sourceId: 3,
          sourceRecordCount: 2,
          sourceContentSha256: hash,
          legacySegments: segments,
        },
        {
          sourceId: 4,
          sourceRecordCount: 2,
          sourceContentSha256: "0".repeat(64),
          legacySegments: segments,
        },
      ])
    ).toBeNull();
    expect(
      resolveVerifiedDuplicateNexusRecovery([
        {
          sourceId: 3,
          sourceRecordCount: 2,
          sourceContentSha256: hash,
          legacySegments: segments,
        },
        {
          sourceId: 4,
          sourceRecordCount: 1,
          sourceContentSha256: differentHash,
          legacySegments: ["different"],
        },
      ])
    ).toBeNull();
    expect(
      resolveVerifiedDuplicateNexusRecovery([
        {
          sourceId: 3,
          sourceRecordCount: 1,
          sourceContentSha256: hash,
          legacySegments: segments,
        },
      ])
    ).toBeNull();
    expect(resolveVerifiedDuplicateNexusRecovery([])).toBeNull();
  });

  it("builds stable normalized evidence and deterministic source ids", () => {
    expect(
      buildMigrationContentEvidence(["alpha  \r\nbeta", "", "gamma"]),
    ).toEqual({
      recordCount: 2,
      sha256:
        "f3220283d05d1ff2ae350cfe9e0e367cb5aef46e10efb203c8a53c678e2218c8",
    });
    expect(deterministicMigrationSourceId("nexus_document", 42)).toBe(
      deterministicMigrationSourceId("nexus_document", 42),
    );
    expect(deterministicMigrationSourceId("nexus_document", 42)).not.toBe(
      deterministicMigrationSourceId("assistant_pdf_job", 42),
    );
  });
});

describe("unified content migration evidence reconciliation", () => {
  it("requires completed processing plus matching object and extraction evidence", () => {
    const decision = reconcileMigrationEvidence({
      sourceObjectSha256: "a".repeat(64),
      canonicalObjectSha256: "a".repeat(64),
      sourceContent: { recordCount: 1, sha256: "b".repeat(64) },
      canonicalContent: { recordCount: 1, sha256: "b".repeat(64) },
      processingStatus: "completed",
      approvedMismatch: false,
    });
    expect(decision).toEqual({ status: "verified", reasons: [] });

    const mismatch = reconcileMigrationEvidence({
      sourceObjectSha256: "a".repeat(64),
      canonicalObjectSha256: "c".repeat(64),
      sourceContent: { recordCount: 2, sha256: "b".repeat(64) },
      canonicalContent: { recordCount: 1, sha256: "d".repeat(64) },
      processingStatus: "failed",
      approvedMismatch: false,
    });
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.reasons).toEqual(
      expect.arrayContaining([
        "canonical processing is failed",
        "source object SHA-256 differs",
        "extracted content SHA-256 differs",
      ]),
    );
  });

  it("allows canonical resegmentation when full normalized text is unchanged", () => {
    expect(
      reconcileMigrationEvidence({
        sourceObjectSha256: null,
        canonicalObjectSha256: "a".repeat(64),
        sourceContent: { recordCount: 3, sha256: "b".repeat(64) },
        canonicalContent: { recordCount: 17, sha256: "b".repeat(64) },
        processingStatus: "completed",
        approvedMismatch: false,
      }),
    ).toEqual({ status: "verified", reasons: [] });
  });
});

describe("unified content migration lifecycle safeguards", () => {
  it("revisits each mismatch once per reconciliation run before finishing", () => {
    const runnerSource = readFileSync(
      join(
        process.cwd(),
        "lib/repositories/content-platform/migration-runner.ts",
      ),
      "utf8",
    );
    expect(runnerSource).toContain(
      "${repositoryMigrationItems.metadata} ->> 'lastReconciledRunId'",
    );
    expect(runnerSource).toContain(
      "lastReconciledRunId: runId",
    );
    expect(runnerSource).toContain(
      "reconcileMigrationCandidate(tx, candidate, run.id)",
    );
    expect(runnerSource).toContain(
      "WHERE status IN ('migrated', 'mismatch')",
    );
  });

  it("recognizes resumable migration versions and keeps rollback cleanup exact", () => {
    expect(
      isMigrationOwnedCanonicalVersion({
        sourceKind: "migration",
        objectKey: "repositories/4/sources/migration-id/file.pdf",
        metadata: {
          migrationSourceKind: "repository_item",
          migrationSourceId: 42,
        },
        expectedObjectKey: "repositories/4/sources/migration-id/file.pdf",
        expectedSourceKind: "repository_item",
        expectedSourceId: 42,
      }),
    ).toBe(true);
    expect(
      isMigrationOwnedCanonicalVersion({
        sourceKind: "upload",
        objectKey: "repositories/4/sources/migration-id/file.pdf",
        metadata: {},
        expectedObjectKey: "repositories/4/sources/migration-id/file.pdf",
        expectedSourceKind: "repository_item",
        expectedSourceId: 42,
      }),
    ).toBe(false);
    expect(
      buildMigrationRollbackObjectKeys(
        ["repositories/4/a", "repositories/4/a", "repositories/4/b"],
        "repositories/4/b",
      ),
    ).toEqual(["repositories/4/a", "repositories/4/b"]);
  });

  it("keeps retirement blocked until verification, rollback, and recovery gates pass", () => {
    const readyInput = {
      cutoversEnabled: true,
      retirementConfigured: true,
      dryRunCompleted: true,
      inventoryComplete: true,
      activeRunCount: 0,
      migrationMetrics: {
        discovered: 3,
        migrated: 3,
        verified: 3,
        mismatched: 0,
        failed: 0,
        unrecoverable: 0,
      },
      rollbackDrillCompleted: true,
      recoveryWindowEndsAt: new Date("2026-07-20T00:00:00Z"),
      now: new Date("2026-07-21T00:00:00Z"),
    };
    expect(assessContentRetirementReadiness(readyInput)).toEqual({
      ready: true,
      blockers: [],
    });
    expect(
      assessContentRetirementReadiness({
        ...readyInput,
        migrationMetrics: {
          ...readyInput.migrationMetrics,
          excluded: 3,
        },
      }),
    ).toEqual({ ready: true, blockers: [] });
    expect(
      assessContentRetirementReadiness({
        ...readyInput,
        migrationMetrics: {
          ...readyInput.migrationMetrics,
          mismatched: 1,
          verified: 2,
        },
        rollbackDrillCompleted: false,
        dryRunCompleted: false,
        inventoryComplete: false,
      }),
    ).toEqual({
      ready: false,
      blockers: expect.arrayContaining([
        "unapproved reconciliation mismatches remain",
        "not every migrated source is verified",
        "a rollback drill has not been recorded",
        "a completed migration dry run has not been recorded",
        "legacy source inventory is not fully verified",
      ]),
    });
  });
});
