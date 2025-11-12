import { getServerSession } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { executeSQL } from '@/lib/db/data-api-adapter';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { SqlParameter } from '@aws-sdk/client-rds-data';
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

    let sql = 'UPDATE ideas SET status = :status, updated_at = NOW()';
    const params: SqlParameter[] = [
      { name: 'status', value: { stringValue: status } },
      { name: 'ideaId', value: { longValue: ideaId } },
    ];

    if (status === 'completed') {
      // Get the user's numeric ID from their cognito_sub
      const userSql = 'SELECT id FROM users WHERE cognito_sub = :cognitoSub';
      const userResult = await executeSQL(userSql, [{ name: 'cognitoSub', value: { stringValue: session.sub } }]);
      
      if (!userResult || userResult.length === 0) {
        return new NextResponse('User not found', { status: 404 });
      }
      
      const userId = userResult[0].id;
      sql += ', completed_by = :completedBy, completed_at = NOW()';
      params.push({ name: 'completedBy', value: { stringValue: String(userId || '') } });
    }

    sql += ' WHERE id = :ideaId RETURNING *';
    
    const result = await executeSQL(sql, params);

    return NextResponse.json(result[0]);
  } catch (error) {
    log.error('Error updating idea status:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
} 