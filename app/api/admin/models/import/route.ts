import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-check";
import { bulkImportAIModels, getAIModelByModelId } from "@/lib/db/drizzle";
import { setModelRoleGrantsFromNames } from "@/lib/db/drizzle/resource-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { validateModel } from "@/lib/validators/model-import-validator";

// NOTE (#1207): the ai_models.allowed_roles COLUMN is gone, but the import format
// still accepts the legacy `allowedRoles` field so older import files keep working.
// It is now TRANSLATED into `role`-kind resource_access_grants after import (see the
// bridge below) rather than written to a column. This is deliberate: dropping it
// silently would leave a previously-restricted model with zero grant rows — i.e.
// UNRESTRICTED (visible to everyone), since zero grants means "no restriction".

// Maximum models per import
const MAX_MODELS_PER_IMPORT = 100;

// Maximum JSON body size (1MB)
const MAX_BODY_SIZE = 1 * 1024 * 1024;

interface ModelJsonInput {
  name: string;
  modelId: string;
  provider: string;
  description?: string;
  capabilities?: string[];
  maxTokens?: number;
  active?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  // Legacy access field — translated into role grants post-import (see header).
  allowedRoles?: string[];
  inputCostPer1kTokens?: string;
  outputCostPer1kTokens?: string;
  cachedInputCostPer1kTokens?: string;
}

interface ImportFailure {
  logContext?: Record<string, unknown>;
  logMessage: string;
  reason: string;
  response: NextResponse;
}

type ImportRequestResult =
  | { ok: true; models: ModelJsonInput[] }
  | { ok: false; failure: ImportFailure };

interface ImportFailureOptions {
  body: Record<string, unknown>;
  logContext?: Record<string, unknown>;
  logMessage: string;
  reason: string;
  requestId: string;
  status: number;
}

function importFailure(options: ImportFailureOptions): ImportRequestResult {
  return {
    ok: false,
    failure: {
      logContext: options.logContext,
      logMessage: options.logMessage,
      reason: options.reason,
      response: NextResponse.json(options.body, {
        status: options.status,
        headers: { "X-Request-Id": options.requestId },
      }),
    },
  };
}

function collectValidationErrors(models: unknown[]): string[] {
  return models.flatMap((model, index) => {
    const result = validateModel(model, index);
    return result.valid ? [] : result.errors;
  });
}

function findDuplicateModelIds(models: ModelJsonInput[]): string[] {
  const modelIds = new Set<string>();
  const duplicates: string[] = [];
  for (const model of models) {
    if (modelIds.has(model.modelId)) duplicates.push(model.modelId);
    modelIds.add(model.modelId);
  }
  return duplicates;
}

async function parseImportRequest(
  request: Request,
  requestId: string
): Promise<ImportRequestResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength) > MAX_BODY_SIZE) {
    return importFailure({
      body: {
        isSuccess: false,
        message: `Request body exceeds maximum size of ${MAX_BODY_SIZE / (1024 * 1024)}MB`,
      },
      logContext: { contentLength },
      logMessage: "Request body too large",
      reason: "body_too_large",
      requestId,
      status: 413,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return importFailure({
      body: { isSuccess: false, message: "Invalid JSON in request body" },
      logMessage: "Invalid JSON in request body",
      reason: "invalid_json",
      requestId,
      status: 400,
    });
  }

  if (!body || typeof body !== "object") {
    return importFailure({
      body: { isSuccess: false, message: "Request body must be an object" },
      logMessage: "Request body must be an object",
      reason: "invalid_body",
      requestId,
      status: 400,
    });
  }

  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return importFailure({
      body: { isSuccess: false, message: "'models' field must be an array" },
      logMessage: "'models' field must be an array",
      reason: "invalid_models",
      requestId,
      status: 400,
    });
  }
  if (models.length === 0) {
    return importFailure({
      body: { isSuccess: false, message: "No models to import" },
      logMessage: "No models to import",
      reason: "empty_models",
      requestId,
      status: 400,
    });
  }
  if (models.length > MAX_MODELS_PER_IMPORT) {
    return importFailure({
      body: {
        isSuccess: false,
        message: `Maximum ${MAX_MODELS_PER_IMPORT} models per import`,
      },
      logContext: { count: models.length },
      logMessage: "Too many models in import",
      reason: "too_many_models",
      requestId,
      status: 400,
    });
  }

  const validationErrors = collectValidationErrors(models);
  if (validationErrors.length > 0) {
    return importFailure({
      body: {
        isSuccess: false,
        message: "Validation failed",
        errors: validationErrors,
      },
      logContext: { errorCount: validationErrors.length },
      logMessage: "Model validation failed",
      reason: "validation",
      requestId,
      status: 400,
    });
  }

  const validatedModels = models as ModelJsonInput[];
  const duplicates = findDuplicateModelIds(validatedModels);
  if (duplicates.length > 0) {
    return importFailure({
      body: {
        isSuccess: false,
        message: "Duplicate modelIds in import",
        errors: duplicates.map((id) => `Duplicate modelId: ${id}`),
      },
      logContext: { duplicates },
      logMessage: "Duplicate modelIds in import",
      reason: "duplicate_model_ids",
      requestId,
      status: 400,
    });
  }

  return { ok: true, models: validatedModels };
}

function toImportModel(model: ModelJsonInput) {
  return {
    name: model.name,
    modelId: model.modelId,
    provider: model.provider,
    description: model.description,
    capabilities: model.capabilities,
    maxTokens: model.maxTokens,
    active: model.active,
    nexusEnabled: model.nexusEnabled,
    architectEnabled: model.architectEnabled,
    inputCostPer1kTokens: model.inputCostPer1kTokens
      ? String(model.inputCostPer1kTokens)
      : undefined,
    outputCostPer1kTokens: model.outputCostPer1kTokens
      ? String(model.outputCostPer1kTokens)
      : undefined,
    cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens
      ? String(model.cachedInputCostPer1kTokens)
      : undefined,
  };
}

async function translateLegacyRoleGrants(
  models: ModelJsonInput[]
): Promise<number> {
  const byModelId = new Map<string, string[]>();
  for (const model of models) {
    if (Array.isArray(model.allowedRoles)) {
      byModelId.set(model.modelId, model.allowedRoles);
    }
  }
  for (const [modelId, roleNames] of byModelId) {
    const persisted = await getAIModelByModelId(modelId);
    if (persisted) {
      await setModelRoleGrantsFromNames(persisted.id, roleNames, null);
    }
  }
  return byModelId.size;
}

/**
 * POST /api/admin/models/import
 * Bulk import AI models from JSON
 */
export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.import");
  const log = createLogger({ requestId, route: "api.admin.models.import" });

  log.info("POST /api/admin/models/import - Starting bulk import");

  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const parsed = await parseImportRequest(request, requestId);
    if (!parsed.ok) {
      log.warn(parsed.failure.logMessage, parsed.failure.logContext ?? {});
      timer({ status: "error", reason: parsed.failure.reason });
      return parsed.failure.response;
    }

    // Transform models for import
    const modelsToImport = parsed.models.map(toImportModel);

    log.info("Importing models", { count: modelsToImport.length });

    // Execute bulk import
    const result = await bulkImportAIModels(modelsToImport);

    // Preserve legacy restrictions: zero grant rows means unrestricted access.
    const roleGrantsTranslated = await translateLegacyRoleGrants(parsed.models);

    log.info("Bulk import completed", {
      created: result.created,
      updated: result.updated,
      roleGrantsTranslated,
    });
    timer({ status: "success", created: result.created, updated: result.updated });

    return NextResponse.json(
      {
        isSuccess: true,
        message: `Import successful: ${result.created} created, ${result.updated} updated`,
        data: result,
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Bulk import failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        isSuccess: false,
        message: "Import failed",
        errors: [error instanceof Error ? error.message : "Unknown error"],
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
