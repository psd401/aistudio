import { getServerSession } from '@/lib/auth/server-session';
import { updateUserRole, getUserById } from '@/lib/db/drizzle';
import { hasRole } from '@/utils/roles';
import { withErrorHandling, unauthorized } from '@/lib/api-utils';
import { createError } from '@/lib/error-utils';
import { getErrorMessage } from '@/types/errors';
import { ErrorLevel } from '@/types/actions-types';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.users.promote");
  const log = createLogger({ requestId, route: "api.users.promote" });
  
  log.info("POST /api/users/promote - Promoting user to administrator");
  
  const session = await getServerSession();
  if (!session) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return unauthorized('User not authenticated');
  }

  return withErrorHandling(async () => {
    // SECURITY: Only existing administrators can promote users
    const isAdmin = await hasRole('administrator');
    if (!isAdmin) {
      log.warn("Forbidden - User is not administrator", { cognitoSub: session.sub });
      timer({ status: "error", reason: "forbidden" });
      throw createError('Only administrators can promote users to administrator role', {
        code: 'FORBIDDEN',
        level: ErrorLevel.WARN,
        details: { cognitoSub: session.sub, action: 'promote_user' }
      });
    }

    // Get the target user ID from request body
    const body = await request.json();
    const { targetUserId } = body;

    if (!targetUserId) {
      log.warn("Target user ID is required");
      timer({ status: "error", reason: "missing_user_id" });
      throw createError('Target user ID is required', {
        code: 'VALIDATION',
        level: ErrorLevel.WARN,
        details: { field: 'targetUserId' }
      });
    }
    
    log.debug("Promoting user", { targetUserId });

    // Update target user role to administrator
    try {
      await updateUserRole(Number(targetUserId), 'administrator');

      // Get updated user info
      const user = await getUserById(Number(targetUserId));

      if (!user) {
        log.warn("User not found", { targetUserId });
        timer({ status: "error", reason: "user_not_found" });
        throw createError('User not found', {
          code: 'NOT_FOUND',
          level: ErrorLevel.WARN,
          details: { targetUserId }
        });
      }

      log.info("User promoted successfully", { targetUserId });
      timer({ status: "success" });

      return {
        success: true,
        user
      };
    } catch (error) {
      if (getErrorMessage(error).includes('not found')) {
        throw createError('User or role not found', {
          code: 'NOT_FOUND',
          level: ErrorLevel.WARN,
          details: { targetUserId }
        });
      }
      throw error;
    }
  });
} 