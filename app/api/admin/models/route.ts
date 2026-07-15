import { NextResponse } from 'next/server';
import { getAIModels, createAIModel, updateAIModel, deleteAIModel } from '@/lib/db/drizzle';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { normalizeBoolean } from '@/lib/validations/api-schemas';

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

    const body = await request.json();

    // Validate required fields
    if (!body.name?.trim()) {
      log.warn("Model creation failed - missing name");
      timer({ status: "error", reason: "validation" });
      return NextResponse.json(
        { isSuccess: false, message: "Model name is required" },
        { status: 400 }
      );
    }

    if (!body.modelId?.trim()) {
      log.warn("Model creation failed - missing modelId");
      timer({ status: "error", reason: "validation" });
      return NextResponse.json(
        { isSuccess: false, message: "Model ID is required" },
        { status: 400 }
      );
    }

    if (!body.provider) {
      log.warn("Model creation failed - missing provider");
      timer({ status: "error", reason: "validation" });
      return NextResponse.json(
        { isSuccess: false, message: "Provider is required" },
        { status: 400 }
      );
    }

    log.debug("Creating model", { modelName: body.name, provider: body.provider });

    // Validate and sanitize capabilities
    const validatedCapabilities = validateCapabilities(body.capabilities, log);

    const modelData = {
      name: body.name,
      modelId: body.modelId,
      provider: body.provider,
      description: body.description,
      capabilities: validatedCapabilities || undefined,
      maxTokens: body.maxTokens ? Number.parseInt(body.maxTokens) : undefined,
      active: body.active ?? true,
      nexusEnabled: body.nexusEnabled ?? true,
      architectEnabled: body.architectEnabled ?? true,
      // Pricing fields
      inputCostPer1kTokens: body.inputCostPer1kTokens || undefined,
      outputCostPer1kTokens: body.outputCostPer1kTokens || undefined,
      cachedInputCostPer1kTokens: body.cachedInputCostPer1kTokens || undefined,
      // Cache-WRITE rate (issue #1089) — without this the create path silently
      // drops the admin form's cache-write price (update persists it via spread).
      cacheWriteCostPer1kTokens: body.cacheWriteCostPer1kTokens || undefined,
      pricingUpdatedAt: body.pricingUpdatedAt ? new Date(body.pricingUpdatedAt) : undefined,
      // Performance fields
      averageLatencyMs: body.averageLatencyMs || undefined,
      maxConcurrency: body.maxConcurrency || undefined,
      supportsBatching: body.supportsBatching ?? undefined,
      // JSONB fields - providerMetadata only (nexusCapabilities removed in #594)
      providerMetadata: body.providerMetadata || undefined
    };

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

    const body = await request.json();
    const { id, ...updates } = body;
    
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
      updates.maxTokens = updates.maxTokens ? Number.parseInt(updates.maxTokens) : null;
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

    // JSONB fields - pass as objects, Drizzle serializes automatically via .$type<T>()
    // No manual JSON.stringify needed - consistent with POST handler

    // Handle Date fields
    if (updates.pricingUpdatedAt && updates.pricingUpdatedAt instanceof Date) {
      updates.pricingUpdatedAt = updates.pricingUpdatedAt.toISOString();
    }

    const model = await updateAIModel(id, updates);

    log.info("Model updated successfully", { modelId: id });
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