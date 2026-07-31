import { NextResponse } from 'next/server';
import {
  getAIModels,
  getAIModelById,
  createAIModel,
  updateAIModel,
  deleteAIModel,
} from '@/lib/db/drizzle';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { normalizeBoolean } from '@/lib/validations/api-schemas';
import type { AIModelData } from '@/lib/db/drizzle/ai-models';
import {
  agenticModelAdmissionIssues,
  type AgenticModelAdmissionFields,
} from '@/lib/agents/model-readiness';

// NOTE (#1207): per-model role/group access is set ONLY via the ResourceGrantsEditor
// (resource_access_grants — see actions/db/resource-grants-actions.ts). The legacy
// ai_models.allowed_roles column and its write-time grant bridge were removed here;
// this route no longer reads, validates, writes, or bridges allowedRoles.

/**
 * Validate and sanitize capabilities field
 * @param capabilities - The capabilities to validate (can be string or array)
 * @param log - Logger instance for warnings
 * @returns Validated JSON string of capabilities or null
 */
function validateCapabilities(
  capabilities: unknown,
  log: ReturnType<typeof createLogger>
): string | null {
  if (!capabilities) return null;
  
  try {
    // Parse if string
    let caps: unknown;
    if (typeof capabilities === 'string') {
      const trimmed = capabilities.trim();
      if (!trimmed) return null;
      
      // Try to parse as JSON
      if (trimmed.startsWith('[')) {
        try {
          caps = JSON.parse(trimmed);
        } catch {
          // Not valid JSON, try comma-separated
          caps = trimmed.split(',').map(c => c.trim()).filter(Boolean);
        }
      } else if (trimmed.includes(',')) {
        // Comma-separated values
        caps = trimmed.split(',').map(c => c.trim()).filter(Boolean);
      } else {
        // Single value
        caps = [trimmed];
      }
    } else {
      caps = capabilities;
    }
    
    // Validate it's an array of strings
    if (!Array.isArray(caps)) {
      log.warn('Invalid capabilities format - not an array', { capabilities });
      return null;
    }
    
    const validCaps = caps.filter(c => typeof c === 'string' && c.trim().length > 0);
    
    // Return validated capabilities as JSON string
    return validCaps.length > 0 ? JSON.stringify(validCaps) : null;
  } catch (error) {
    log.warn('Failed to validate capabilities', {
      capabilities,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return null;
  }
}

interface CreateModelBody
  extends Omit<AIModelData, "maxTokens" | "pricingUpdatedAt"> {
  maxTokens?: number | string | null;
  pricingUpdatedAt?: Date | string | null;
}

function missingCreateField(body: CreateModelBody): string | null {
  if (!body.name?.trim()) return "Model name is required";
  if (!body.modelId?.trim()) return "Model ID is required";
  if (!body.provider) return "Provider is required";
  return null;
}

// eslint-disable-next-line complexity -- Centralized request normalization keeps model creation and admission validation consistent.
function buildCreateModelData(
  body: CreateModelBody,
  capabilities: string | null
): AIModelData {
  return {
    name: body.name,
    modelId: body.modelId,
    provider: body.provider,
    description: body.description,
    capabilities: capabilities || undefined,
    maxTokens: body.maxTokens ? Number.parseInt(String(body.maxTokens)) : undefined,
    contextWindowTokens:
      body.contextWindowTokens == null
        ? undefined
        : Number.parseInt(String(body.contextWindowTokens), 10),
    maxOutputTokens:
      body.maxOutputTokens == null
        ? undefined
        : Number.parseInt(String(body.maxOutputTokens), 10),
    agenticReady: body.agenticReady ?? false,
    active: body.active ?? true,
    nexusEnabled: body.nexusEnabled ?? true,
    architectEnabled: body.architectEnabled ?? true,
    inputCostPer1kTokens: body.inputCostPer1kTokens || undefined,
    outputCostPer1kTokens: body.outputCostPer1kTokens || undefined,
    cachedInputCostPer1kTokens: body.cachedInputCostPer1kTokens || undefined,
    cacheWriteCostPer1kTokens: body.cacheWriteCostPer1kTokens || undefined,
    pricingUpdatedAt: body.pricingUpdatedAt
      ? new Date(body.pricingUpdatedAt)
      : undefined,
    averageLatencyMs: body.averageLatencyMs || undefined,
    maxConcurrency: body.maxConcurrency || undefined,
    supportsBatching: body.supportsBatching ?? undefined,
    providerMetadata: body.providerMetadata || undefined,
  };
}

function agenticAdmissionMessage(
  model: AgenticModelAdmissionFields
): string | null {
  if (model.agenticReady !== true) return null;
  const issues = agenticModelAdmissionIssues(model);
  return issues.length > 0
    ? `Model cannot be marked Agentic Ready: ${issues.join(", ")}`
    : null;
}

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.list");
  const log = createLogger({ requestId, route: "api.admin.models" });
  
  log.info("GET /api/admin/models - Fetching AI models");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const models = await getAIModels();

    log.info("Models retrieved successfully", { count: models.length });
    timer({ status: "success", count: models.length });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "Models retrieved successfully",
        data: models
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching models:", error);
    return NextResponse.json(
      { isSuccess: false, message: "Failed to fetch models" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.create");
  const log = createLogger({ requestId, route: "api.admin.models" });
  
  log.info("POST /api/admin/models - Creating AI model");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = (await request.json()) as CreateModelBody;

    const validationMessage = missingCreateField(body);
    if (validationMessage) {
      log.warn("Model creation failed - missing required field", {
        validationMessage,
      });
      timer({ status: "error", reason: "validation" });
      return NextResponse.json(
        { isSuccess: false, message: validationMessage },
        { status: 400 }
      );
    }

    log.debug("Creating model", { modelName: body.name, provider: body.provider });

    // Validate and sanitize capabilities
    const validatedCapabilities = validateCapabilities(body.capabilities, log);
    const modelData = buildCreateModelData(body, validatedCapabilities);
    const admissionMessage = agenticAdmissionMessage(modelData);
    if (admissionMessage) {
      return NextResponse.json(
        { isSuccess: false, message: admissionMessage },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const model = await createAIModel(modelData);

    log.info("Model created successfully", { modelId: model.id });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Model created successfully',
        data: model
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error('Error creating model:', error);
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to create model' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}

// eslint-disable-next-line complexity -- The admin update endpoint normalizes a heterogeneous model configuration before one validated write.
export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.update");
  const log = createLogger({ requestId, route: "api.admin.models" });
  
  log.info("PUT /api/admin/models - Updating AI model");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = (await request.json()) as Record<string, unknown>;
    const { id, ...updates } = body;
    const modelId = Number(id);
    if (!Number.isSafeInteger(modelId) || modelId <= 0) {
      return NextResponse.json(
        { isSuccess: false, message: "A valid model id is required" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    
    log.debug("Updating model", { modelId: id, updates });
    
    // Validate and sanitize capabilities if present
    if ('capabilities' in updates) {
      updates.capabilities = validateCapabilities(updates.capabilities, log);
    }

    // NOTE (#1207): allowedRoles is no longer accepted here — role/group access
    // is edited via the ResourceGrantsEditor (resource_access_grants). Strip any
    // allowedRoles key an older client still echoes so it can never reach the
    // (now-dropped) column via updateAIModel's `.set({ ...updates })` spread.
    if ('allowedRoles' in updates) {
      delete updates.allowedRoles;
    }

    // Convert maxTokens to number if present
    if (updates.maxTokens !== undefined) {
      updates.maxTokens = updates.maxTokens
        ? Number.parseInt(String(updates.maxTokens), 10)
        : null;
    }
    if (updates.contextWindowTokens !== undefined) {
      updates.contextWindowTokens = updates.contextWindowTokens
        ? Number.parseInt(String(updates.contextWindowTokens), 10)
        : null;
    }
    if (updates.maxOutputTokens !== undefined) {
      updates.maxOutputTokens = updates.maxOutputTokens
        ? Number.parseInt(String(updates.maxOutputTokens), 10)
        : null;
    }

    // Handle boolean fields - ensure proper type (frontend may send as string)
    // Uses normalizeBoolean utility to handle "false", "0", 0, false correctly
    if ('active' in updates) {
      updates.active = normalizeBoolean(updates.active);
    }
    if ('nexusEnabled' in updates) {
      updates.nexusEnabled = normalizeBoolean(updates.nexusEnabled);
    }
    if ('architectEnabled' in updates) {
      updates.architectEnabled = normalizeBoolean(updates.architectEnabled);
    }
    if ('agenticReady' in updates) {
      updates.agenticReady = normalizeBoolean(updates.agenticReady);
    }

    // JSONB fields - pass as objects, Drizzle serializes automatically via .$type<T>()
    // No manual JSON.stringify needed - consistent with POST handler

    // Handle Date fields
    if (updates.pricingUpdatedAt && updates.pricingUpdatedAt instanceof Date) {
      updates.pricingUpdatedAt = updates.pricingUpdatedAt.toISOString();
    }

    const existing = await getAIModelById(modelId);
    if (!existing) {
      return NextResponse.json(
        { isSuccess: false, message: "Model not found" },
        { status: 404, headers: { "X-Request-Id": requestId } }
      );
    }
    const admissionMessage = agenticAdmissionMessage({
      ...existing,
      ...updates,
    });
    if (admissionMessage) {
      return NextResponse.json(
        { isSuccess: false, message: admissionMessage },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const model = await updateAIModel(modelId, updates);

    log.info("Model updated successfully", { modelId });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Model updated successfully',
        data: model
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error('Error updating model:', error);
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to update model' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.delete");
  const log = createLogger({ requestId, route: "api.admin.models" });
  
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  
  log.info("DELETE /api/admin/models - Deleting AI model", { modelId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    if (!id) {
      log.warn("Missing model ID in delete request");
      timer({ status: "error", reason: "missing_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Missing model ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const model = await deleteAIModel(Number.parseInt(id));

    log.info("Model deleted successfully", { modelId: id });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Model deleted successfully',
        data: model
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error('Error deleting model:', error);
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to delete model' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
