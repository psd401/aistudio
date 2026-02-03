import { getServerSession } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { getUserIdByCognitoSub, updateIdeaStatus } from '@/lib/db/drizzle';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.status.update");
  const log = createLogger({ requestId, route: "api.ideas.status" });
  
  log.info("PATCH /api/ideas/[id]/status - Updating idea status");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { status: 401, headers: { "X-Request-Id": requestId } });
  }

  const isAdmin = await hasRole('administrator');
  if (!isAdmin) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  try {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);
    if (Number.isNaN(ideaId)) {
      return new NextResponse('Invalid idea ID', { status: 400 });
    }

    const { status } = await request.json();
    if (!status) {
      return new NextResponse('Missing status', { status: 400 });
    }

    let completedBy: string | undefined;
    if (status === 'completed') {
      // Get the user's numeric ID from their cognito_sub
      const userIdString = await getUserIdByCognitoSub(session.sub);

      if (!userIdString) {
        return new NextResponse('User not found', { status: 404 });
      }

      completedBy = userIdString;
    }

    const result = await updateIdeaStatus(ideaId, status, completedBy);

    return NextResponse.json(result);
  } catch (error) {
    log.error('Error updating idea status:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
} 