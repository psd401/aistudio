import { NextResponse } from 'next/server';
import { getAIModels, createAIModel, updateAIModel, deleteAIModel, getRoles } from '@/lib/db/drizzle';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

/**
 * Validate and sanitize allowedRoles field
 * @param allowedRoles - The roles to validate (can be string or array)
 * @param log - Logger instance for warnings
 * @returns Validated array of role names or null (Drizzle handles serialization)
 */
async function validateAllowedRoles(
  allowedRoles: unknown,
  log: ReturnType<typeof createLogger>
): Promise<string[] | null> {
  if (!allowedRoles) return null;

  try {
    // Parse if string
    let roles: unknown;
    if (typeof allowedRoles === 'string') {
      // Try to parse as JSON
      try {
        roles = JSON.parse(allowedRoles);
      } catch {
        // Not JSON, treat as single role
        roles = [allowedRoles];
      }
    } else {
      roles = allowedRoles;
    }

    // Validate it's an array of strings
    if (!Array.isArray(roles)) {
      log.warn('Invalid allowedRoles format - not an array', { allowedRoles });
      return null;
    }

    const validRoles = roles.filter(r => typeof r === 'string' && r.trim().length > 0);

    if (validRoles.length === 0) {
      return null;
    }

    // Validate against existing roles in the system
    const existingRoles = await getRoles();
    const existingRoleNames = existingRoles.map(r => r.name);
    const filteredRoles = validRoles.filter(r => existingRoleNames.includes(r));

    if (filteredRoles.length !== validRoles.length) {
      const invalidRoles = validRoles.filter(r => !existingRoleNames.includes(r));
      log.warn('Some roles do not exist in the system', {
        invalidRoles,
        validRoles: filteredRoles
      });
    }

    // Return validated roles as array - Drizzle handles serialization
    return filteredRoles.length > 0 ? filteredRoles : null;
  } catch (error) {
    log.warn('Failed to validate allowedRoles', {
      allowedRoles,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return null;
  }
}

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
    
    log.debug("Creating model", { modelName: body.name, provider: body.provider });
    
    // Validate and sanitize capabilities and allowedRoles
    const validatedCapabilities = validateCapabilities(body.capabilities, log);
    const validatedAllowedRoles = await validateAllowedRoles(body.allowedRoles, log);
    
    const modelData = {
      name: body.name,
      modelId: body.modelId,
      provider: body.provider,
      description: body.description,
      capabilities: validatedCapabilities || undefined,
      allowedRoles: validatedAllowedRoles || undefined,
      maxTokens: body.maxTokens ? Number.parseInt(body.maxTokens) : undefined,
      active: body.active ?? true,
      chatEnabled: body.chatEnabled ?? false, // @deprecated - kept for backward compatibility
      nexusEnabled: body.nexusEnabled ?? true,
      architectEnabled: body.architectEnabled ?? true,
      // Pricing fields
      inputCostPer1kTokens: body.inputCostPer1kTokens || undefined,
      outputCostPer1kTokens: body.outputCostPer1kTokens || undefined,
      cachedInputCostPer1kTokens: body.cachedInputCostPer1kTokens || undefined,
      pricingUpdatedAt: body.pricingUpdatedAt ? new Date(body.pricingUpdatedAt) : undefined,
      // Performance fields
      averageLatencyMs: body.averageLatencyMs || undefined,
      maxConcurrency: body.maxConcurrency || undefined,
      supportsBatching: body.supportsBatching ?? undefined,
      // JSONB fields - these are already objects from the frontend
      nexusCapabilities: body.nexusCapabilities || undefined,
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
    
    // Validate and sanitize allowedRoles if present
    if ('allowedRoles' in updates) {
      updates.allowedRoles = await validateAllowedRoles(updates.allowedRoles, log);
    }
    
    // Convert maxTokens to number if present
    if (updates.maxTokens !== undefined) {
      updates.maxTokens = updates.maxTokens ? Number.parseInt(updates.maxTokens) : null;
    }

    // Handle boolean fields - ensure proper type (frontend may send as string)
    if ('active' in updates) {
      updates.active = Boolean(updates.active);
    }
    if ('chatEnabled' in updates) {
      updates.chatEnabled = Boolean(updates.chatEnabled);
    }
    if ('nexusEnabled' in updates) {
      updates.nexusEnabled = Boolean(updates.nexusEnabled);
    }
    if ('architectEnabled' in updates) {
      updates.architectEnabled = Boolean(updates.architectEnabled);
    }

    // Handle JSONB fields - stringify if they're objects
    if (updates.nexusCapabilities && typeof updates.nexusCapabilities === 'object') {
      updates.nexusCapabilities = JSON.stringify(updates.nexusCapabilities);
    }

    if (updates.providerMetadata && typeof updates.providerMetadata === 'object') {
      updates.providerMetadata = JSON.stringify(updates.providerMetadata);
    }

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