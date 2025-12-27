import { NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getIdeas, getUserVotedIdeaIds, getUserIdByCognitoSub, createIdea } from '@/lib/db/drizzle';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.list");
  const log = createLogger({ requestId, route: "api.ideas" });
  
  log.info("GET /api/ideas - Fetching ideas");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized access attempt to ideas");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { 
      status: 401,
      headers: { "X-Request-Id": requestId }
    });
  }
  
  log.debug("User authenticated", { userId: session.sub });

  try {
    // Get all ideas with creator names and counts
    const allIdeas = await getIdeas();

    // Get the user's numeric ID for vote checking
    const currentUserIdString = await getUserIdByCognitoSub(session.sub);
    const currentUserId = currentUserIdString ? Number(currentUserIdString) : null;

    let userVotedIdeaIds = new Set<number>();
    if (currentUserId) {
      userVotedIdeaIds = await getUserVotedIdeaIds(currentUserId);
    }

    const ideasWithVotes = allIdeas.map((idea) => ({
      ...idea,
      hasVoted: userVotedIdeaIds.has(idea.id)
    }));

    log.info("Ideas retrieved successfully", { count: ideasWithVotes.length });
    timer({ status: "success", count: ideasWithVotes.length });

    return NextResponse.json(ideasWithVotes, {
      headers: { "X-Request-Id": requestId }
    });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error fetching ideas:', error);
    return new NextResponse('Internal Server Error', {
      status: 500,
      headers: { "X-Request-Id": requestId }
    });
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.create");
  const log = createLogger({ requestId, route: "api.ideas" });
  
  log.info("POST /api/ideas - Creating new idea");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized idea creation attempt");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { 
      status: 401,
      headers: { "X-Request-Id": requestId }
    });
  }
  
  log.debug("User authenticated", { userId: session.sub });

  const [isStaff, isAdmin] = await Promise.all([
    hasRole('staff'),
    hasRole('administrator')
  ]);
  if (!isStaff && !isAdmin) {
    log.warn("Insufficient permissions to create idea", { userId: session.sub });
    timer({ status: "error", reason: "forbidden" });
    return new NextResponse('Forbidden', { 
      status: 403,
      headers: { "X-Request-Id": requestId }
    });
  }

  try {
    const { title, description, priorityLevel } = await request.json();

    log.debug("Creating idea", { title, priorityLevel });

    if (!title || !description || !priorityLevel) {
      log.warn("Missing required fields for idea creation");
      timer({ status: "error", reason: "validation_error" });
      return new NextResponse('Missing required fields', {
        status: 400,
        headers: { "X-Request-Id": requestId }
      });
    }

    // Get the user's numeric ID from their cognito_sub
    const userIdString = await getUserIdByCognitoSub(session.sub);

    if (!userIdString) {
      log.error("User not found in database", { cognitoSub: session.sub });
      timer({ status: "error", reason: "user_not_found" });
      return new NextResponse('User not found', {
        status: 404,
        headers: { "X-Request-Id": requestId }
      });
    }

    const userId = Number(userIdString);

    const newIdea = await createIdea({
      title,
      description,
      priorityLevel,
      userId,
    });

    log.info("Idea created successfully", { ideaId: newIdea.id });
    timer({ status: "success" });

    return NextResponse.json(
      {
        ...newIdea,
        createdBy: String(newIdea.userId)
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error('Error creating idea:', error);
    return new NextResponse('Internal Server Error', {
      status: 500,
      headers: { "X-Request-Id": requestId }
    });
  }
} 