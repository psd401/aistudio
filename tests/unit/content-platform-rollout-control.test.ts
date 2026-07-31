import {
  applyProspectiveRolloutSetting,
  evaluateRepositoryCutoverEvidence,
  evaluateRolloutDependencies,
  parseContentRolloutBoolean,
} from "@/lib/repositories/content-platform/rollout-control";
import {
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  type ContentPlatformConfig,
} from "@/lib/repositories/content-platform/config";
import type { RepositoryMigrationDashboard } from "@/lib/repositories/content-platform/migration-control-service";

function config(
  overrides: Partial<ContentPlatformConfig> = {}
): ContentPlatformConfig {
  return { ...DEFAULT_CONTENT_PLATFORM_CONFIG, ...overrides };
}

function dashboard(
  overrides: Partial<RepositoryMigrationDashboard> = {}
): RepositoryMigrationDashboard {
  return {
    inventory: [
      {
        sourceKind: "repository_item",
        maximumId: 10,
        discovered: 10,
        tracked: 10,
        verified: 10,
        uncovered: 0,
      },
    ],
    runs: [],
    migrationMetrics: {
      discovered: 10,
      migrated: 10,
      verified: 10,
      mismatched: 0,
      failed: 0,
      excluded: 0,
      unrecoverable: 0,
      rolledBack: 0,
    },
    activeRunCount: 0,
    staleRepositoryCount: 0,
    processing: {},
    retrievalShadow: {
      observations: 5,
      legacyResults: 5,
      canonicalResults: 5,
      overlappingItems: 5,
    },
    recoveryWindowEndsAt: new Date("2026-01-01T00:00:00Z"),
    rollbackDrillCompleted: true,
    dryRunCompleted: true,
    retirementFinalized: false,
    retirement: { ready: true, blockers: [] },
    ...overrides,
  };
}

describe("content platform rollout control", () => {
  it("rejects ambiguous boolean values", () => {
    expect(() => parseContentRolloutBoolean("yes")).toThrow(
      "must be true or false"
    );
  });

  it("requires the documented rollout order", () => {
    const blockers = evaluateRolloutDependencies(
      config({ nexusCutoverEnabled: true })
    );
    expect(blockers).toEqual(
      expect.arrayContaining([
        "enable the content platform before any rollout stage",
        "enable canonical reads before product cutovers",
        "enable Repository Manager cutover before Nexus cutover",
      ])
    );
  });

  it("accepts the full guarded product cutover state", () => {
    expect(
      evaluateRolloutDependencies(
        config({
          enabled: true,
          dualWriteEnabled: true,
          readV2Enabled: true,
          retrievalShadowEnabled: true,
          repositoryCutoverEnabled: true,
          nexusCutoverEnabled: true,
          assistantArchitectCutoverEnabled: true,
        })
      )
    ).toEqual([]);
  });

  it("reports migration and retrieval blockers before Repository Manager cutover", () => {
    const blockers = evaluateRepositoryCutoverEvidence(
      dashboard({
        dryRunCompleted: false,
        staleRepositoryCount: 2,
        retrievalShadow: {
          observations: 0,
          legacyResults: 0,
          canonicalResults: 0,
          overlappingItems: 0,
        },
      })
    );
    expect(blockers).toEqual([
      "complete a migration dry run",
      "repair stale repository index generations",
      "record successful retrieval shadow observations",
    ]);
  });

  it("applies one prospective setting without mutating the current config", () => {
    const current = config({ enabled: true });
    const next = applyProspectiveRolloutSetting(
      current,
      "CONTENT_DUAL_WRITE_ENABLED",
      true
    );
    expect(current.dualWriteEnabled).toBe(false);
    expect(next.dualWriteEnabled).toBe(true);
  });
});
