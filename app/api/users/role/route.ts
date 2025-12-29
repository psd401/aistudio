import { getServerSession } from '@/lib/auth/server-session';
import { updateUserRole, getUserById } from '@/lib/db/drizzle';
import { NextResponse } from 'next/server';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.users.role.update");
  const log = createLogger({ requestId, route: "api.users.role" });
  
  log.info("POST /api/users/role - Updating user role");
  
  const session = await getServerSession();
  
  if (!session) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { status: 401, headers: { "X-Request-Id": requestId } });
  }

  // Check if current user is administrator
  const isAdmin = await hasRole('administrator');
  if (!isAdmin) {
    log.warn("Forbidden - User is not administrator");
    timer({ status: "error", reason: "forbidden" });
    return new NextResponse('Forbidden', { status: 403, headers: { "X-Request-Id": requestId } });
  }

  try {
    const { targetUserId, role } = await request.json();

    if (!targetUserId || !role || !['student', 'staff', 'administrator'].includes(role)) {
      log.warn("Invalid request", { targetUserId, role });
      timer({ status: "error", reason: "validation_error" });
      return new NextResponse('Invalid request', { status: 400, headers: { "X-Request-Id": requestId } });
    }
    
    log.debug("Updating user role", { targetUserId, role });

    // Update user role using Drizzle
    await updateUserRole(Number(targetUserId), role);

    // Get updated user info
    const user = await getUserById(Number(targetUserId));

    if (!user) {
      log.warn("User not found", { targetUserId });
      timer({ status: "error", reason: "user_not_found" });
      return new NextResponse('User not found', { status: 404, headers: { "X-Request-Id": requestId } });
    }

    log.info("User role updated successfully", { targetUserId, role });
    timer({ status: "success" });
    return NextResponse.json(user, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error updating user role', error);
    return new NextResponse('Internal Server Error', { status: 500, headers: { "X-Request-Id": requestId } });
  }
} 