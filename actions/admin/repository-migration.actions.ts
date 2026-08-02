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
  MAX_FAILED_REPOSITORY_MIGRATION_RETRIES,
  retryFailedRepositoryMigrationItems,
  retryRepositoryMigrationItem,
  runRepositoryMigrationRollbackDrill,
  startRepositoryMigrationRun,
  startRepositoryRollbackRun,
  type RepositoryMigrationDashboard,
  type RepositoryMigrationException,
} from "@/lib/repositories/content-platform/migration-control-service";
import { reprocessRepositoryMigrationItem } from "@/lib/repositories/content-platform/migration-runner";
import { dispatchContentProcessingJob } from "@/lib/repositories/content-platform/dispatch-service";
import {
  getCanonicalRepositoryItemStatuses,
  retryCanonicalRepositoryItem,
  type CanonicalRepositoryItemStatus,
} from "@/lib/repositories/content-platform/status-service";
import { getContentPlatformConfig } from "@/lib/repositories/content-platform/config";
import {
  assertNotSystemManagedRepository,
  assertRepositoryReadAccess,
} from "@/lib/repositories/repository-access-guard";
import { executeSearch } from "@/lib/repositories/search-execution";
import { getRepositoryById } from "@/lib/db/drizzle";
import { ErrorCode } from "@/types/error-types";
import type {
  RepositoryMigrationMode,
  RepositoryMigrationRunRow,
  RepositoryMigrationSourceKind,
} from "@/lib/db/schema";

const ADMIN_REPOSITORIES_PATH = "/admin/repositories";
const ADMIN_SETTINGS_PATH = "/admin/settings";
const MAX_RETRIEVAL_SHADOW_SAMPLE_QUERIES = 25;
const MAX_MIGRATION_MISMATCH_REPROCESSES = 50;
const MAX_REPOSITORY_ITEM_BULK_RETRIES = 100;

interface MigrationAdministrator {
  userId: number;
  cognitoSub: string;
}

async function requireMigrationAdministrator(): Promise<MigrationAdministrator> {
  const session = await getServerSession();
  if (!session?.sub) throw ErrorFactories.authNoSession();
  if (!(await hasRole("administrator"))) {
    throw ErrorFactories.authzAdminRequired();
  }
  return {
    userId: await getUserIdFromSession(session.sub),
    cognitoSub: session.sub,
  };
}

function validateBulkLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw ErrorFactories.valueOutOfRange("limit", limit, 1, maximum, {
      userMessage: `Limit must be between 1 and ${maximum}.`,
    });
  }
}

function isRepositoryItemBulkRetryCandidate(
  status: CanonicalRepositoryItemStatus,
): boolean {
  const activeAndUnderEmbedded =
    status.processingStatus === "embedded" &&
    !status.activeEmbeddingComplete;
  const buildingAndUnderEmbedded =
    status.processingStatus === "processing_embeddings" &&
    status.totalChunks > 0 &&
    status.embeddedChunks < status.totalChunks;
  return status.canRetry || activeAndUnderEmbedded || buildingAndUnderEmbedded;
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
    const { userId: requestedBy } = await requireMigrationAdministrator();
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
    const { userId: requestedBy } = await requireMigrationAdministrator();
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

/** Queue one bounded set of terminal migration sources behind a single run. */
export async function retryFailedRepositoryMigrationItemsAction(input: {
  limit: number;
}): Promise<ActionState<RepositoryMigrationRunRow>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.retryFailedBulk");
  try {
    const { userId: requestedBy } = await requireMigrationAdministrator();
    validateBulkLimit(input.limit, MAX_FAILED_REPOSITORY_MIGRATION_RETRIES);
    const run = await retryFailedRepositoryMigrationItems({
      requestedBy,
      limit: input.limit,
    });
    timer({ status: "success", runId: run.id, limit: input.limit });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(run, "Failed migration sources queued for retry");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to queue migration retries.", {
      context: "admin.contentMigration.retryFailedBulk",
      requestId,
      operation: "retryFailedRepositoryMigrationItemsAction",
    });
  }
}

export interface RepositoryMigrationMismatchReprocessResult {
  reprocessed: number;
  migrationItemIds: string[];
}

/** Reprocess a bounded set of reconciliation mismatches using the item service. */
export async function reprocessRepositoryMigrationMismatchesAction(input: {
  limit: number;
}): Promise<ActionState<RepositoryMigrationMismatchReprocessResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.reprocessMismatches");
  try {
    await requireMigrationAdministrator();
    validateBulkLimit(input.limit, MAX_MIGRATION_MISMATCH_REPROCESSES);
    const exceptions = await listRepositoryMigrationExceptions(200);
    const mismatches = exceptions
      .filter((exception) => exception.status === "mismatch")
      .slice(0, input.limit);
    for (const mismatch of mismatches) {
      await reprocessRepositoryMigrationItem(mismatch.id);
    }
    const result = {
      reprocessed: mismatches.length,
      migrationItemIds: mismatches.map((mismatch) => mismatch.id),
    };
    timer({ status: "success", reprocessed: result.reprocessed });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    return createSuccess(result, "Migration mismatches queued for reprocessing");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to reprocess migration mismatches.", {
      context: "admin.contentMigration.reprocessMismatches",
      requestId,
      operation: "reprocessRepositoryMigrationMismatchesAction",
    });
  }
}

export interface RepositoryItemsBulkRetryResult {
  retried: number;
  dispatchDeferred: number;
  itemIds: number[];
}

/** Retry terminal or completed-but-under-embedded canonical repository items. */
export async function retryRepositoryItemsBulkAction(input: {
  repositoryId: number;
  limit: number;
}): Promise<ActionState<RepositoryItemsBulkRetryResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.retryRepositoryItemsBulk");
  const log = createLogger({
    requestId,
    action: "admin.contentMigration.retryRepositoryItemsBulk",
  });
  try {
    await requireMigrationAdministrator();
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1) {
      throw ErrorFactories.invalidInput(
        "repositoryId",
        input.repositoryId,
        "positive integer",
      );
    }
    validateBulkLimit(input.limit, MAX_REPOSITORY_ITEM_BULK_RETRIES);
    await assertNotSystemManagedRepository(input.repositoryId);
    const statuses = await getCanonicalRepositoryItemStatuses(
      input.repositoryId,
    );
    const candidates = [...statuses.values()]
      .filter(isRepositoryItemBulkRetryCandidate)
      .sort((left, right) => left.itemId - right.itemId)
      .slice(0, input.limit);

    let dispatchDeferred = 0;
    for (const candidate of candidates) {
      const retry = await retryCanonicalRepositoryItem(
        candidate.itemId,
        requestId,
      );
      try {
        await dispatchContentProcessingJob({
          jobId: retry.processingJobId,
          itemVersionId: retry.itemVersionId,
        });
      } catch (error) {
        dispatchDeferred += 1;
        log.warn("Bulk retry is pending scheduled dispatch", {
          repositoryId: input.repositoryId,
          itemId: candidate.itemId,
          processingJobId: retry.processingJobId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const result = {
      retried: candidates.length,
      dispatchDeferred,
      itemIds: candidates.map((candidate) => candidate.itemId),
    };
    timer({ status: "success", ...result });
    revalidatePath(ADMIN_REPOSITORIES_PATH);
    revalidatePath(`/repositories/${input.repositoryId}`);
    return createSuccess(result, "Repository item retries queued");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to retry repository items.", {
      context: "admin.contentMigration.retryRepositoryItemsBulk",
      requestId,
      operation: "retryRepositoryItemsBulkAction",
      metadata: { repositoryId: input.repositoryId },
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
    const { userId: approvedBy } = await requireMigrationAdministrator();
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
    const { userId: requestedBy } = await requireMigrationAdministrator();
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
    const { userId: requestedBy } = await requireMigrationAdministrator();
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

export interface RepositoryRetrievalShadowSampleOutcome {
  query: string;
  status: "recorded" | "skipped";
  resultCount: number;
  reason?: string;
}

export interface RepositoryRetrievalShadowSampleResult {
  repositoryId: number;
  repositoryName: string;
  recorded: number;
  skipped: number;
  outcomes: RepositoryRetrievalShadowSampleOutcome[];
}

function isRecordNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === ErrorCode.DB_RECORD_NOT_FOUND
  );
}

function validateRetrievalShadowSampleInput(input: {
  repositoryId: number;
  queries: string[];
}): string[] {
  if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw ErrorFactories.invalidInput(
      "repositoryId",
      input.repositoryId,
      "positive integer",
      { userMessage: "Enter a valid repository ID." },
    );
  }
  if (
    !Array.isArray(input.queries) ||
    input.queries.length === 0 ||
    input.queries.length > MAX_RETRIEVAL_SHADOW_SAMPLE_QUERIES
  ) {
    throw ErrorFactories.invalidInput(
      "queries",
      Array.isArray(input.queries) ? input.queries.length : input.queries,
      `1-${MAX_RETRIEVAL_SHADOW_SAMPLE_QUERIES} queries`,
      {
        userMessage: `Provide between 1 and ${MAX_RETRIEVAL_SHADOW_SAMPLE_QUERIES} sample queries.`,
      },
    );
  }

  return input.queries.map((query, index) => {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw ErrorFactories.invalidInput(
        `queries[${index}]`,
        query,
        "non-empty string",
        { userMessage: `Sample query ${index + 1} must not be empty.` },
      );
    }
    return query.trim();
  });
}

/**
 * Run a bounded, deterministic set of Repository Manager searches through the
 * production search executor. The executor owns retrieval-shadow recording and
 * preserves its fail-open behavior; this action never writes observations.
 */
export async function recordRepositoryRetrievalShadowSampleAction(input: {
  repositoryId: number;
  queries: string[];
}): Promise<ActionState<RepositoryRetrievalShadowSampleResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("admin.contentMigration.retrievalShadowSample");
  const log = createLogger({
    requestId,
    action: "admin.contentMigration.retrievalShadowSample",
  });

  try {
    const administrator = await requireMigrationAdministrator();
    const queries = validateRetrievalShadowSampleInput(input);
    const repository = await getRepositoryById(input.repositoryId);
    if (!repository) {
      throw ErrorFactories.dbRecordNotFound(
        "knowledge_repositories",
        input.repositoryId,
        { userMessage: `Repository ${input.repositoryId} was not found.` },
      );
    }

    try {
      await assertRepositoryReadAccess(
        input.repositoryId,
        administrator.cognitoSub,
        { allowAdministratorOverride: false },
      );
    } catch (error) {
      if (!isRecordNotFoundError(error)) throw error;
      throw ErrorFactories.authzResourceNotFound(
        "repository",
        repository.name,
        {
          userMessage: `Access to repository "${repository.name}" is required before recording a retrieval-shadow sample.`,
        },
      );
    }

    const contentConfig = await getContentPlatformConfig();
    const outcomes: RepositoryRetrievalShadowSampleOutcome[] = [];
    for (const query of queries) {
      const search = await executeSearch({
        searchType: "hybrid",
        query,
        repositoryId: input.repositoryId,
        limit: 10,
        vectorWeight: 0.7,
        canonicalOnly: false,
        userCognitoSub: administrator.cognitoSub,
        contentConfig,
        log,
      });
      const shadowOutcome = search.shadowOutcome ?? {
        status: "skipped" as const,
        reason: "No retrieval shadow observation was recorded",
      };
      outcomes.push({
        query,
        status: shadowOutcome.status,
        resultCount: search.results.length,
        ...(shadowOutcome.status === "skipped"
          ? { reason: shadowOutcome.reason }
          : {}),
      });
    }

    const recorded = outcomes.filter(
      (outcome) => outcome.status === "recorded",
    ).length;
    const result = {
      repositoryId: input.repositoryId,
      repositoryName: repository.name,
      recorded,
      skipped: outcomes.length - recorded,
      outcomes,
    };
    log.info("Administrator completed retrieval-shadow sample", {
      repositoryId: input.repositoryId,
      queryCount: queries.length,
      recorded: result.recorded,
      skipped: result.skipped,
    });
    timer({
      status: "success",
      repositoryId: input.repositoryId,
      queryCount: queries.length,
      recorded: result.recorded,
      skipped: result.skipped,
    });
    revalidatePath(ADMIN_SETTINGS_PATH);
    return createSuccess(
      result,
      `Retrieval-shadow sample completed for ${repository.name}`,
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(
      error,
      "Failed to run the repository retrieval-shadow sample.",
      {
        context: "admin.contentMigration.retrievalShadowSample",
        requestId,
        operation: "recordRepositoryRetrievalShadowSampleAction",
        metadata: { repositoryId: input.repositoryId },
      },
    );
  }
}
