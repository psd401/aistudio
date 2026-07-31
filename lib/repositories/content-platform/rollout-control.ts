import type { ContentPlatformConfig } from "./config";
import type { RepositoryMigrationDashboard } from "./migration-control-service";

export const CONTENT_ROLLOUT_BOOLEAN_KEYS = [
  "CONTENT_PLATFORM_ENABLED",
  "CONTENT_DUAL_WRITE_ENABLED",
  "CONTENT_READ_V2_ENABLED",
  "CONTENT_REPOSITORY_CUTOVER_ENABLED",
  "CONTENT_NEXUS_CUTOVER_ENABLED",
  "CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED",
  "CONTENT_RETRIEVAL_SHADOW_ENABLED",
  "CONTENT_LEGACY_RETIREMENT_ENABLED",
] as const;

export type ContentRolloutBooleanKey =
  (typeof CONTENT_ROLLOUT_BOOLEAN_KEYS)[number];

export function isContentRolloutBooleanKey(
  key: string
): key is ContentRolloutBooleanKey {
  return (CONTENT_ROLLOUT_BOOLEAN_KEYS as readonly string[]).includes(key);
}

export function parseContentRolloutBoolean(value: string | null): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Content platform rollout settings must be true or false");
}

export function applyProspectiveRolloutSetting(
  config: ContentPlatformConfig,
  key: ContentRolloutBooleanKey,
  value: boolean
): ContentPlatformConfig {
  const next = { ...config };
  const propertyByKey: Record<
    ContentRolloutBooleanKey,
    keyof Pick<
      ContentPlatformConfig,
      | "enabled"
      | "dualWriteEnabled"
      | "readV2Enabled"
      | "repositoryCutoverEnabled"
      | "nexusCutoverEnabled"
      | "assistantArchitectCutoverEnabled"
      | "retrievalShadowEnabled"
      | "legacyRetirementEnabled"
    >
  > = {
    CONTENT_PLATFORM_ENABLED: "enabled",
    CONTENT_DUAL_WRITE_ENABLED: "dualWriteEnabled",
    CONTENT_READ_V2_ENABLED: "readV2Enabled",
    CONTENT_REPOSITORY_CUTOVER_ENABLED: "repositoryCutoverEnabled",
    CONTENT_NEXUS_CUTOVER_ENABLED: "nexusCutoverEnabled",
    CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED:
      "assistantArchitectCutoverEnabled",
    CONTENT_RETRIEVAL_SHADOW_ENABLED: "retrievalShadowEnabled",
    CONTENT_LEGACY_RETIREMENT_ENABLED: "legacyRetirementEnabled",
  };
  next[propertyByKey[key]] = value;
  return next;
}

// eslint-disable-next-line complexity -- Explicit ordered gates are easier to audit than a generalized dependency interpreter.
export function evaluateRolloutDependencies(
  config: ContentPlatformConfig
): string[] {
  const blockers: string[] = [];
  const advancedEnabled =
    config.dualWriteEnabled ||
    config.readV2Enabled ||
    config.repositoryCutoverEnabled ||
    config.nexusCutoverEnabled ||
    config.assistantArchitectCutoverEnabled ||
    config.retrievalShadowEnabled ||
    config.legacyRetirementEnabled;
  if (advancedEnabled && !config.enabled) {
    blockers.push("enable the content platform before any rollout stage");
  }
  if (
    (config.repositoryCutoverEnabled ||
      config.nexusCutoverEnabled ||
      config.assistantArchitectCutoverEnabled) &&
    !config.readV2Enabled
  ) {
    blockers.push("enable canonical reads before product cutovers");
  }
  if (
    config.repositoryCutoverEnabled &&
    (!config.dualWriteEnabled || !config.retrievalShadowEnabled)
  ) {
    blockers.push(
      "enable dual-write and retrieval shadowing before Repository Manager cutover"
    );
  }
  if (config.nexusCutoverEnabled && !config.repositoryCutoverEnabled) {
    blockers.push("enable Repository Manager cutover before Nexus cutover");
  }
  if (
    config.assistantArchitectCutoverEnabled &&
    !config.nexusCutoverEnabled
  ) {
    blockers.push("enable Nexus cutover before Assistant Architect cutover");
  }
  if (
    config.legacyRetirementEnabled &&
    !(
      config.repositoryCutoverEnabled &&
      config.nexusCutoverEnabled &&
      config.assistantArchitectCutoverEnabled
    )
  ) {
    blockers.push("enable every product cutover before legacy retirement");
  }
  return blockers;
}

export function evaluateRepositoryCutoverEvidence(
  dashboard: RepositoryMigrationDashboard
): string[] {
  const blockers: string[] = [];
  if (!dashboard.dryRunCompleted) {
    blockers.push("complete a migration dry run");
  }
  if (dashboard.activeRunCount > 0) {
    blockers.push("wait for the active migration run to finish");
  }
  const uncovered = dashboard.inventory.reduce(
    (total, entry) => total + entry.uncovered,
    0
  );
  if (uncovered > 0) blockers.push(`account for ${uncovered} uncovered sources`);
  if ((dashboard.migrationMetrics.failed ?? 0) > 0) {
    blockers.push("resolve failed migration items");
  }
  if ((dashboard.migrationMetrics.mismatched ?? 0) > 0) {
    blockers.push("resolve unapproved migration mismatches");
  }
  if ((dashboard.migrationMetrics.unrecoverable ?? 0) > 0) {
    blockers.push("classify or recreate unrecoverable sources");
  }
  if (dashboard.staleRepositoryCount > 0) {
    blockers.push("repair stale repository index generations");
  }
  if (dashboard.retrievalShadow.observations === 0) {
    blockers.push("record successful retrieval shadow observations");
  }
  return blockers;
}
