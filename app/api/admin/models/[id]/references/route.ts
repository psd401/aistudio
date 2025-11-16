import { NextRequest, NextResponse } from 'next/server';
import { getModelReferenceCounts } from '@/lib/db/data-api-adapter';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.models.references");
  const log = createLogger({ requestId, route: "api.admin.models.references" });
  
  const { id } = await params;
  const modelId = Number.parseInt(id);
  log.info("GET /api/admin/models/[id]/references - Checking model references", { modelId });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    if (!modelId || Number.isNaN(modelId)) {
      log.warn("Invalid model ID provided", { modelId: id });
      timer({ status: "error", reason: "invalid_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid model ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    
    const counts = await getModelReferenceCounts(modelId);
    
    // The data-api-adapter automatically converts snake_case to camelCase
    const totalReferences = 
      Number(counts.chainPromptsCount || 0) + 
      Number(counts.conversationsCount || 0) + 
      Number(counts.modelComparisonsCount || 0);
    
    log.info("Reference counts retrieved successfully", { 
      modelId, 
      totalReferences,
      counts 
    });
    timer({ status: "success", totalReferences });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "Reference counts retrieved successfully",
        data: {
          modelId,
          hasReferences: totalReferences > 0,
          totalReferences,
          counts: {
            chainPrompts: Number(counts.chainPromptsCount || 0),
            conversations: Number(counts.conversationsCount || 0),
            modelComparisons: Number(counts.modelComparisonsCount || 0)
          }
        }
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching model references", { 
      error: error instanceof Error ? error.message : String(error),
      modelId 
    });
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to fetch model references" 
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}