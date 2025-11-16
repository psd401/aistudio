import { NextResponse } from 'next/server';
import { deleteUser } from '@/lib/db/data-api-adapter';
import { requireAdmin } from '@/lib/auth/admin-check';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ userId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.delete");
  const log = createLogger({ requestId, route: "api.admin.users.delete" });
  
  log.info("DELETE /api/admin/users/[userId] - Deleting user");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Await and validate the params object
    const params = await context.params;
    const targetUserId = params.userId;
    
    if (!targetUserId) {
      log.warn("Invalid user ID provided");
      timer({ status: "error", reason: "invalid_user_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid user ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    // Delete the user via Data API
    log.debug("Deleting user", { targetUserId });
    const deletedUser = await deleteUser(Number.parseInt(targetUserId));

    if (!deletedUser) {
      log.warn("User not found", { targetUserId });
      timer({ status: "error", reason: "user_not_found" });
      return NextResponse.json(
        { isSuccess: false, message: 'User not found' },
        { status: 404, headers: { "X-Request-Id": requestId } }
      );
    }

    // TODO: Also delete from Cognito when we have proper integration

    log.info("User deleted successfully", { targetUserId });
    timer({ status: "success" });
    
    return NextResponse.json({
      isSuccess: true,
      message: 'User deleted successfully',
      data: deletedUser
    }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error deleting user', error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error 
          ? `Failed to delete user: ${error.message}` 
          : 'Failed to delete user'
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
} 