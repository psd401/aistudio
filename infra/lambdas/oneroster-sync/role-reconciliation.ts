/**
 * Post-sync role-reconciliation policy for the isolated OneRoster Lambda.
 *
 * Keeping the gate and best-effort boundary separate from the AWS handler makes
 * the authorization behavior deterministic and unit-testable: only a fully
 * successful scheduled pull may reconcile, the setting is opt-in, and a role
 * failure never changes a successful roster-sync result into a failed run.
 */

import type { RoleReconcileResult } from "./db";

export interface RoleReconcileLog {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PostSyncRoleReconcileInput {
  trigger: "manual" | "schedule";
  enabled: boolean;
  fullySuccessful: boolean;
}

export interface PostSyncRoleReconcilePorts {
  reconcile(): Promise<RoleReconcileResult>;
  log: RoleReconcileLog;
}

export async function runPostSyncRoleReconciliation(
  input: PostSyncRoleReconcileInput,
  ports: PostSyncRoleReconcilePorts
): Promise<RoleReconcileResult | null> {
  if (
    input.trigger !== "schedule" ||
    !input.enabled ||
    !input.fullySuccessful
  ) {
    return null;
  }

  try {
    const result = await ports.reconcile();
    ports.log.info("OneRoster role reconciliation completed", { ...result });
    return result;
  } catch (error) {
    ports.log.error(
      "OneRoster role reconciliation failed (roster sync still succeeded)",
      {
        error: safeErrorMessage(error),
      }
    );
    return null;
  }
}

export interface RoleReconcileMetric {
  name: "RolesGranted" | "RolesRevoked" | "RoleUsersChanged";
  value: number;
}

export function roleReconcileMetrics(
  result: RoleReconcileResult
): RoleReconcileMetric[] {
  return [
    { name: "RolesGranted", value: result.granted },
    { name: "RolesRevoked", value: result.revoked },
    { name: "RoleUsersChanged", value: result.usersChanged },
  ];
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}
