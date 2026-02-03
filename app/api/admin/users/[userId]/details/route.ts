import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin-check';
import { getUserById } from '@/lib/db/drizzle';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.details");
  const log = createLogger({ requestId, route: "api.admin.users.details" });
  
  log.info("GET /api/admin/users/[userId]/details - Fetching user details");
  
  const params = await context.params;
  // Check admin authorization
  const authError = await requireAdmin();
  if (authError) {
    log.warn("Unauthorized admin access attempt");
    timer({ status: "error", reason: "unauthorized" });
    return authError;
  }

  try {
    const userId = Number.parseInt(params.userId, 10);

    if (Number.isNaN(userId)) {
      log.warn("Invalid user ID", { userIdString: params.userId });
      timer({ status: "error", reason: "invalid_user_id" });
      return new NextResponse('Invalid user ID', { status: 400, headers: { "X-Request-Id": requestId } });
    }

    log.debug("Fetching user details", { userId });

    // Get user details from database
    const user = await getUserById(userId);

    log.info("User details fetched successfully", { userId });
    timer({ status: "success" });

    return NextResponse.json({
      firstName: user.firstName,
      lastName: user.lastName,
      emailAddresses: [{ emailAddress: user.email }]
    }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error fetching user details', error);
    return new NextResponse('Internal Server Error', { status: 500, headers: { "X-Request-Id": requestId } });
  }
} 