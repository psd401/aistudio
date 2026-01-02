import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-check";
import { bulkImportAIModels } from "@/lib/db/drizzle";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

// Valid provider values
const VALID_PROVIDERS = new Set([
  "openai",
  "azure",
  "amazon-bedrock",
  "google",
  "google-vertex",
]);

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
  allowedRoles?: string[];
  inputCostPer1kTokens?: string;
  outputCostPer1kTokens?: string;
  cachedInputCostPer1kTokens?: string;
}

/**
 * Validate a single model object
 */
function validateModel(
  model: unknown,
  index: number
): { valid: boolean; errors: string[] } {
  const modelErrors: string[] = [];
  const prefix = `Model ${index + 1}`;

  if (!model || typeof model !== "object") {
    return { valid: false, errors: [`${prefix}: Must be an object`] };
  }

  const m = model as Record<string, unknown>;

  // Required fields
  if (!m.name || typeof m.name !== "string" || !(m.name as string).trim()) {
    modelErrors.push(
      `${prefix}: 'name' is required and must be a non-empty string`
    );
  }

  if (
    !m.modelId ||
    typeof m.modelId !== "string" ||
    !(m.modelId as string).trim()
  ) {
    modelErrors.push(
      `${prefix}: 'modelId' is required and must be a non-empty string`
    );
  }

  if (!m.provider || typeof m.provider !== "string") {
    modelErrors.push(`${prefix}: 'provider' is required`);
  } else if (!VALID_PROVIDERS.has(m.provider as string)) {
    modelErrors.push(
      `${prefix}: Invalid provider '${m.provider}'. Valid values: ${Array.from(VALID_PROVIDERS).join(", ")}`
    );
  }

  // Optional field type validation
  if (m.description !== undefined && typeof m.description !== "string") {
    modelErrors.push(`${prefix}: 'description' must be a string`);
  }

  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      modelErrors.push(`${prefix}: 'capabilities' must be an array`);
    } else if (
      !(m.capabilities as unknown[]).every((c) => typeof c === "string")
    ) {
      modelErrors.push(`${prefix}: 'capabilities' must be an array of strings`);
    }
  }

  if (m.maxTokens !== undefined) {
    if (typeof m.maxTokens !== "number" || !Number.isInteger(m.maxTokens)) {
      modelErrors.push(`${prefix}: 'maxTokens' must be an integer`);
    } else if ((m.maxTokens as number) < 0) {
      modelErrors.push(`${prefix}: 'maxTokens' must be non-negative`);
    }
  }

  // Boolean fields
  const booleanFields = ["active", "nexusEnabled", "architectEnabled"] as const;
  for (const field of booleanFields) {
    if (m[field] !== undefined && typeof m[field] !== "boolean") {
      modelErrors.push(`${prefix}: '${field}' must be a boolean`);
    }
  }

  // Array fields
  if (m.allowedRoles !== undefined) {
    if (!Array.isArray(m.allowedRoles)) {
      modelErrors.push(`${prefix}: 'allowedRoles' must be an array`);
    } else if (
      !(m.allowedRoles as unknown[]).every((r) => typeof r === "string")
    ) {
      modelErrors.push(`${prefix}: 'allowedRoles' must be an array of strings`);
    }
  }

  // Pricing fields (string numbers)
  const pricingFields = [
    "inputCostPer1kTokens",
    "outputCostPer1kTokens",
    "cachedInputCostPer1kTokens",
  ] as const;
  for (const field of pricingFields) {
    if (m[field] !== undefined) {
      const value = m[field];
      if (typeof value !== "string" && typeof value !== "number") {
        modelErrors.push(`${prefix}: '${field}' must be a number or string`);
      } else {
        const num = Number(value);
        if (Number.isNaN(num) || num < 0) {
          modelErrors.push(
            `${prefix}: '${field}' must be a valid non-negative number`
          );
        }
      }
    }
  }

  return {
    valid: modelErrors.length === 0,
    errors: modelErrors,
  };
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

    // Check content length header
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength) > MAX_BODY_SIZE) {
      log.warn("Request body too large", { contentLength });
      timer({ status: "error", reason: "body_too_large" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: `Request body exceeds maximum size of ${MAX_BODY_SIZE / 1024}KB`,
        },
        { status: 413, headers: { "X-Request-Id": requestId } }
      );
    }

    // Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      log.warn("Invalid JSON in request body");
      timer({ status: "error", reason: "invalid_json" });
      return NextResponse.json(
        { isSuccess: false, message: "Invalid JSON in request body" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Extract models array from body
    if (!body || typeof body !== "object") {
      log.warn("Request body must be an object");
      timer({ status: "error", reason: "invalid_body" });
      return NextResponse.json(
        { isSuccess: false, message: "Request body must be an object" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const requestBody = body as { models?: unknown };
    const models = requestBody.models;

    if (!Array.isArray(models)) {
      log.warn("'models' field must be an array");
      timer({ status: "error", reason: "invalid_models" });
      return NextResponse.json(
        { isSuccess: false, message: "'models' field must be an array" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    if (models.length === 0) {
      log.warn("No models to import");
      timer({ status: "error", reason: "empty_models" });
      return NextResponse.json(
        { isSuccess: false, message: "No models to import" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    if (models.length > MAX_MODELS_PER_IMPORT) {
      log.warn("Too many models in import", { count: models.length });
      timer({ status: "error", reason: "too_many_models" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: `Maximum ${MAX_MODELS_PER_IMPORT} models per import`,
        },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Validate all models
    const validationErrors: string[] = [];
    for (let i = 0; i < models.length; i++) {
      const result = validateModel(models[i], i);
      if (!result.valid) {
        validationErrors.push(...result.errors);
      }
    }

    if (validationErrors.length > 0) {
      log.warn("Model validation failed", { errorCount: validationErrors.length });
      timer({ status: "error", reason: "validation" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Validation failed",
          errors: validationErrors,
        },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Check for duplicate modelIds in input
    const modelIds = new Set<string>();
    const duplicates: string[] = [];
    for (const model of models as ModelJsonInput[]) {
      if (modelIds.has(model.modelId)) {
        duplicates.push(model.modelId);
      }
      modelIds.add(model.modelId);
    }

    if (duplicates.length > 0) {
      log.warn("Duplicate modelIds in import", { duplicates });
      timer({ status: "error", reason: "duplicate_model_ids" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Duplicate modelIds in import",
          errors: duplicates.map((id) => `Duplicate modelId: ${id}`),
        },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Transform models for import
    const modelsToImport = (models as ModelJsonInput[]).map((model) => ({
      name: model.name,
      modelId: model.modelId,
      provider: model.provider,
      description: model.description,
      capabilities: model.capabilities,
      maxTokens: model.maxTokens,
      active: model.active,
      nexusEnabled: model.nexusEnabled,
      architectEnabled: model.architectEnabled,
      allowedRoles: model.allowedRoles,
      inputCostPer1kTokens: model.inputCostPer1kTokens
        ? String(model.inputCostPer1kTokens)
        : undefined,
      outputCostPer1kTokens: model.outputCostPer1kTokens
        ? String(model.outputCostPer1kTokens)
        : undefined,
      cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens
        ? String(model.cachedInputCostPer1kTokens)
        : undefined,
    }));

    log.info("Importing models", { count: modelsToImport.length });

    // Execute bulk import
    const result = await bulkImportAIModels(modelsToImport);

    log.info("Bulk import completed", {
      created: result.created,
      updated: result.updated,
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
