import { NextRequest, NextResponse } from 'next/server';
import { updateUserRole } from '@/lib/db/drizzle';
import { requireAdmin } from '@/lib/auth/admin-check';
import { validateRequest, updateUserRoleSchema } from '@/lib/validations/api-schemas';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.role.update");
  const log = createLogger({ requestId, route: "api.admin.users.role" });
  
  log.info("PUT /api/admin/users/[userId]/role - Updating user role");
  
  try {
    // Await the params object before using it
    const params = await context.params;
    const userIdString = params.userId;
    
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Validate request body
    const { data: validatedData, error } = await validateRequest(request, updateUserRoleSchema);
    if (error) {
      log.warn("Validation error", { error });
      timer({ status: "error", reason: "validation_error" });
      return NextResponse.json(
        { isSuccess: false, message: error },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    const { role: newRole } = validatedData!;
    
    // Update the user's role via Data API
    const userId = Number.parseInt(userIdString, 10);
    if (Number.isNaN(userId)) {
      log.warn("Invalid user ID", { userIdString });
      timer({ status: "error", reason: "invalid_user_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid user ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }
    log.debug("Updating user role", { userId, newRole });
    await updateUserRole(userId, newRole);

    log.info("User role updated successfully", { userId, newRole });
    timer({ status: "success" });
    
    return NextResponse.json({
      isSuccess: true,
      message: 'User role updated successfully'
    }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error updating user role', error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error 
          ? `Failed to update user role: ${error.message}` 
          : 'Failed to update user role'
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}