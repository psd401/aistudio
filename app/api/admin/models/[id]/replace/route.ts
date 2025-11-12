import { NextRequest, NextResponse } from 'next/server';
import { 
  replaceModelReferences, 
  validateModelReplacement,
  getUserByCognitoSub 
} from '@/lib/db/data-api-adapter';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getServerSession } from '@/lib/auth/server-session';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.replace");
  const log = createLogger({ requestId, route: "api.admin.models.replace" });
  
  const { id } = await params;
  const targetModelId = Number.parseInt(id);
  log.info("POST /api/admin/models/[id]/replace - Starting model replacement", { targetModelId });
  
  // Read request body as text first for error logging
  const bodyText = await request.text();
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    // Get current user session for audit
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn("No valid session found");
      timer({ status: "error", reason: "no_session" });
      return NextResponse.json(
        { isSuccess: false, message: 'Authentication required' },
        { status: 401, headers: { "X-Request-Id": requestId } }
      );
    }
    
    // Get user ID for audit logging
    const user = await getUserByCognitoSub(session.sub);
    if (!user?.id) {
      log.warn("User not found", { cognitoSub: session.sub });
      timer({ status: "error", reason: "user_not_found" });
      return NextResponse.json(
        { isSuccess: false, message: 'User not found' },
        { status: 404, headers: { "X-Request-Id": requestId } }
      );
    }
    
    // Parse request body from the text we already read
    const body = JSON.parse(bodyText);
    const { replacementModelId } = body;
    
    log.debug("Replacement request details", { 
      targetModelId, 
      replacementModelId,
      userId: user.id 
    });
    
    // Validate IDs
    if (!targetModelId || Number.isNaN(targetModelId)) {
      log.warn("Invalid target model ID", { targetModelId: id });
      timer({ status: "error", reason: "invalid_target_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid target model ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    
    if (!replacementModelId || Number.isNaN(replacementModelId)) {
      log.warn("Invalid replacement model ID", { replacementModelId });
      timer({ status: "error", reason: "invalid_replacement_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid replacement model ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    
    // Validate the replacement
    const validation = await validateModelReplacement(targetModelId, replacementModelId);
    
    if (!validation.valid) {
      log.warn("Model replacement validation failed", { 
        reason: validation.reason,
        targetModelId,
        replacementModelId 
      });
      timer({ status: "error", reason: "validation_failed" });
      return NextResponse.json(
        { 
          isSuccess: false, 
          message: validation.reason || 'Invalid replacement model',
          validation 
        },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    
    // Log any warnings
    if (validation.warnings && validation.warnings.length > 0) {
      log.warn("Model replacement has warnings", { 
        warnings: validation.warnings,
        targetModelId,
        replacementModelId 
      });
    }
    
    // Perform the replacement
    const result = await replaceModelReferences(
      targetModelId, 
      replacementModelId,
      Number(user.id)
    );
    
    log.info("Model replacement completed successfully", { 
      result,
      targetModelId,
      replacementModelId,
      totalUpdated: result.totalUpdated 
    });
    timer({ status: "success", recordsUpdated: result.totalUpdated });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: `Successfully replaced model "${result.targetModel.name}" with "${result.replacementModel.name}". Updated ${result.totalUpdated} records.`,
        data: {
          ...result,
          warnings: validation.warnings || []
        }
      },
      { headers: { "X-Request-Id": requestId } }
    );
    
  } catch (error) {
    timer({ status: "error" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    log.error("Model replacement failed", { 
      error: errorMessage,
      targetModelId,
      body: sanitizeForLogging(bodyText)
    });
    
    // Check for specific database errors
    if (errorMessage.includes('foreign key constraint')) {
      return NextResponse.json(
        { 
          isSuccess: false, 
          message: 'Cannot replace model due to database constraints. Please contact support.' 
        },
        { status: 409, headers: { "X-Request-Id": requestId } }
      );
    }
    
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: 'Failed to replace model. Please try again or contact support if the issue persists.' 
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}