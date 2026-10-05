/**
 * Post-sync staff pre-provisioning policy for the isolated OneRoster Lambda (#1860).
 *
 * Kept apart from the AWS handler so the gate and best-effort boundary are
 * unit-testable: only a fully successful pull (scheduled or manual) may
 * provision — a partial pull could be missing deactivations — and a
 * provisioning failure never turns a successful roster sync into a failed run.
 */

import type { StaffProvisionResult } from "./db";

export interface StaffProvisionLog {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PostSyncStaffProvisionPorts {
  provision(): Promise<StaffProvisionResult>;
  log: StaffProvisionLog;
}

export async function runPostSyncStaffProvisioning(
  fullySuccessful: boolean,
  ports: PostSyncStaffProvisionPorts
): Promise<StaffProvisionResult | null> {
  if (!fullySuccessful) return null;

  try {
    const result = await ports.provision();
    ports.log.info("OneRoster staff provisioning completed", { ...result });
    return result;
  } catch (error) {
    ports.log.error(
      "OneRoster staff provisioning failed (roster sync still succeeded)",
      { error: safeErrorMessage(error) }
    );
    return null;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}
