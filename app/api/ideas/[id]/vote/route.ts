import { getServerSession } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { executeSQL } from '@/lib/db/data-api-adapter';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.vote");
  const log = createLogger({ requestId, route: "api.ideas.vote" });
  
  log.info("POST /api/ideas/[id]/vote - Voting on idea");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { status: 401, headers: { "X-Request-Id": requestId } });
  }

  const [isStaff, isAdmin] = await Promise.all([
    hasRole('staff'),
    hasRole('administrator')
  ]);
  
  if (!isStaff && !isAdmin) {
    log.warn("Forbidden - User lacks staff/admin role");
    timer({ status: "error", reason: "forbidden" });
    return new NextResponse('Forbidden', { status: 403, headers: { "X-Request-Id": requestId } });
  }

  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);
    
    if (Number.isNaN(ideaId)) {
      log.warn("Invalid idea ID", { id });
      timer({ status: "error", reason: "invalid_id" });
      return new NextResponse('Invalid idea ID', { status: 400, headers: { "X-Request-Id": requestId } });
    }
    
    log.debug("Processing vote for idea", { ideaId });

    // First get the user's numeric ID from their cognito_sub
    const userSql = 'SELECT id FROM users WHERE cognito_sub = :cognitoSub';
    const userResult = await executeSQL(userSql, [{ name: 'cognitoSub', value: { stringValue: session.sub } }]);
    
    if (!userResult || userResult.length === 0) {
      log.warn("User not found", { cognitoSub: session.sub });
      timer({ status: "error", reason: "user_not_found" });
      return new NextResponse('User not found', { status: 404, headers: { "X-Request-Id": requestId } });
    }
    
    const userId = userResult[0].id;

    // Check if the user has already voted
    const existingVoteSql = 'SELECT id FROM idea_votes WHERE idea_id = :ideaId AND user_id = :userId';
    const existingVoteParams = [
      { name: 'ideaId', value: { longValue: ideaId } },
      { name: 'userId', value: { longValue: Number(userId) } }
    ];
    const existingVotes = await executeSQL(existingVoteSql, existingVoteParams);

    if (existingVotes.length > 0) {
      // User has voted, so remove the vote (un-vote)
      const deleteVoteSql = 'DELETE FROM idea_votes WHERE id = :voteId';
      await executeSQL(deleteVoteSql, [{ name: 'voteId', value: { longValue: Number(existingVotes[0].id) } }]);
      log.info("Vote removed", { ideaId, userId });
      timer({ status: "success", action: "unvote" });
      return NextResponse.json({ success: true, message: 'Vote removed' }, { headers: { "X-Request-Id": requestId } });
    } else {
      // User has not voted, so add the vote
      const addVoteSql = 'INSERT INTO idea_votes (idea_id, user_id, created_at) VALUES (:ideaId, :userId, NOW())';
      await executeSQL(addVoteSql, existingVoteParams);
      log.info("Vote recorded", { ideaId, userId });
      timer({ status: "success", action: "vote" });
      return NextResponse.json({ success: true, message: 'Vote recorded' }, { headers: { "X-Request-Id": requestId } });
    }
  } catch (error) {
    timer({ status: "error" });
    log.error('Error voting on idea', error);
    return new NextResponse(
      error instanceof Error ? error.message : 'Internal Server Error',
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
} 