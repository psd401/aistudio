import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getUserIdByCognitoSub, updateIdea } from '@/lib/db/drizzle';
import { executeTransaction as drizzleTransaction, ideas, ideaVotes, ideaNotes } from '@/lib/db/drizzle-client';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { eq } from 'drizzle-orm';
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.update");
  const log = createLogger({ requestId, route: "api.ideas" });
  
  log.info("PATCH /api/ideas/[id] - Updating idea");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { "X-Request-Id": requestId } });
  }

  const [isStaff, isAdmin] = await Promise.all([
    hasRole('staff'),
    hasRole('administrator')
  ]);
  if (!isStaff && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  try {
    const body = await request.json();
    const resolvedParams = await context.params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);

    const updates: {
      title?: string;
      description?: string;
      priorityLevel?: string;
      status?: string;
      completedBy?: string;
    } = {};

    if (body.title) updates.title = body.title;
    if (body.description) updates.description = body.description;
    if (body.priorityLevel) updates.priorityLevel = body.priorityLevel;
    if (body.status) {
      updates.status = body.status;
      if (body.status === 'completed') {
        // Get the user's numeric ID from their cognito_sub
        const userIdString = await getUserIdByCognitoSub(session.sub);

        if (!userIdString) {
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        updates.completedBy = userIdString;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const result = await updateIdea(ideaId, updates);
    return NextResponse.json(result);
  } catch (error) {
    log.error('Failed to update idea:', error);
    return NextResponse.json({ error: 'Failed to update idea' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.delete");
  const log = createLogger({ requestId, route: "api.ideas.delete" });
  
  const session = await getServerSession();
  if (!session?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await hasRole('administrator');
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);

    // Use Drizzle transaction to ensure atomic deletion
    await drizzleTransaction(
      async (tx) => {
        // Delete votes first (FK constraint)
        await tx.delete(ideaVotes).where(eq(ideaVotes.ideaId, ideaId));

        // Delete notes (FK constraint)
        await tx.delete(ideaNotes).where(eq(ideaNotes.ideaId, ideaId));

        // Finally delete the idea itself
        await tx.delete(ideas).where(eq(ideas.id, ideaId));

        return true;
      },
      'deleteIdea'
    );

    timer({ status: "success" });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    timer({ status: "error" });
    log.error('Failed to delete idea:', error);
    return NextResponse.json({ error: 'Failed to delete idea' }, { status: 500 });
  }
} 