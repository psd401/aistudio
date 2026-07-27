"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdFromSession } from "@/actions/repositories/repository-permissions";
import { hasRole } from "@/utils/roles";
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import type { ActionState } from "@/types/actions-types";
import {
  approveRepositoryMigrationMismatch,
  getRepositoryMigrationDashboard,
  listRepositoryMigrationExceptions,
  retryRepositoryMigrationItem,
  runRepositoryMigrationRollbackDrill,
  startRepositoryMigrationRun,
  startRepositoryRollbackRun,
  type RepositoryMigrationDashboard,
  type RepositoryMigrationException,
} from "@/lib/repositories/content-platform/migration-control-service";
import { reprocessRepositoryMigrationItem } from "@/lib/repositories/content-platform/migration-runner";
import type {
  RepositoryMigrationMode,
  RepositoryMigrationRunRow,
  RepositoryMigrationSourceKind,
} from "@/lib/db/schema";

const ADMIN_REPOSITORIES_PATH = "/admin/repositories";

async function requireMigrationAdministrator(): Promise<number> {
  const session = await getServerSession();
  if (!session?.sub) throw ErrorFactories.authNoSession();
  if (!(await hasRole("administrator"))) {
    throw ErrorFactories.authzAdminRequired();
  }
  return getUserIdFromSession(session.sub);
}

export async function getRepositoryMigrationDashboardAction(): Promise<
  ActionState<{
    dashboard: RepositoryMigrationDashboard;
    exceptions: RepositoryMigrationException[];
  }>
> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.dashboard");
  const log = createLogger({
    requestId,
    action: "admin.contentMigration.dashboard",
  });
  try {
    await requireMigrationAdministrator();
    const [dashboard, exceptions] = await Promise.all([
      getRepositoryMigrationDashboard(),
      listRepositoryMigrationExceptions(),
    ]);
    timer({ status: "success" });
    return createSuccess(
      { dashboard, exceptions },
      "Content migration status loaded",
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to load content migration dashboard", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return handleError(error, "Failed to load content migration status.", {
      context: "admin.contentMigration.dashboard",
      requestId,
      operation: "getRepositoryMigrationDashboardAction",
    });
  }
}

export async function startRepositoryMigrationAction(input: {
  mode: Exclude<RepositoryMigrationMode, "rollback">;
  sourceKinds?: RepositoryMigrationSourceKind[];
}): Promise<ActionState<RepositoryMigrationRunRow>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.start");
  const log = createLogger({
    requestId,
    action: "admin.contentMigration.start",
  });
  try {
    const requestedBy = await requireMigrationAdministrator();
    const run = await startRepositoryMigrationRun({
      ...input,
      requestedBy,
    });
    log.info("Administrator started content migration run", {
      runId: run.id,
      mode: run.mode,
      sourceKinds: run.sourceKinds,
    });
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(run, `Content migration ${run.mode} run started`);
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to start content migration run.", {
      context: "admin.contentMigration.start",
      requestId,
      operation: "startRepositoryMigrationAction",
    });
  }
}

export async function retryRepositoryMigrationItemAction(
  migrationItemId: string,
): Promise<ActionState<RepositoryMigrationRunRow>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.retry");
  try {
    const requestedBy = await requireMigrationAdministrator();
    const run = await retryRepositoryMigrationItem(
      migrationItemId,
      requestedBy,
    );
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(run, "Migration retry queued");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to retry migration source.", {
      context: "admin.contentMigration.retry",
      requestId,
      operation: "retryRepositoryMigrationItemAction",
    });
  }
}

export async function reprocessRepositoryMigrationItemAction(
  migrationItemId: string,
): Promise<ActionState<void>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.reprocess");
  try {
    await requireMigrationAdministrator();
    await reprocessRepositoryMigrationItem(migrationItemId);
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(undefined, "Canonical reprocessing queued");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to reprocess migration source.", {
      context: "admin.contentMigration.reprocess",
      requestId,
      operation: "reprocessRepositoryMigrationItemAction",
    });
  }
}

export async function approveRepositoryMigrationMismatchAction(input: {
  migrationItemId: string;
  reason: string;
}): Promise<ActionState<void>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.approveMismatch");
  try {
    const approvedBy = await requireMigrationAdministrator();
    await approveRepositoryMigrationMismatch({ ...input, approvedBy });
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(undefined, "Reconciliation mismatch approved");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to approve reconciliation mismatch.", {
      context: "admin.contentMigration.approveMismatch",
      requestId,
      operation: "approveRepositoryMigrationMismatchAction",
    });
  }
}

export async function runRepositoryMigrationRollbackDrillAction(): Promise<
  ActionState<RepositoryMigrationRunRow>
> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.rollbackDrill");
  try {
    const requestedBy = await requireMigrationAdministrator();
    const run = await runRepositoryMigrationRollbackDrill(requestedBy);
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(run, "Rollback drill completed and restored");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to complete rollback drill.", {
      context: "admin.contentMigration.rollbackDrill",
      requestId,
      operation: "runRepositoryMigrationRollbackDrillAction",
    });
  }
}

export async function startRepositoryMigrationRollbackAction(
  parentRunId: string,
): Promise<ActionState<RepositoryMigrationRunRow>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.rollback");
  try {
    const requestedBy = await requireMigrationAdministrator();
    const run = await startRepositoryRollbackRun({
      parentRunId,
      requestedBy,
    });
    timer({ status: "success" });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(run, "Content migration rollback queued");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to start content migration rollback.", {
      context: "admin.contentMigration.rollback",
      requestId,
      operation: "startRepositoryMigrationRollbackAction",
    });
  }
}
