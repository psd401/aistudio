import { getServerSession } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { executeSQL, FormattedRow } from '@/lib/db/data-api-adapter';
import { hasRole } from '@/utils/roles';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.notes.list");
  const log = createLogger({ requestId, route: "api.ideas.notes" });
  
  log.info("GET /api/ideas/[id]/notes - Fetching idea notes");
  
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse('Unauthorized', { status: 401, headers: { "X-Request-Id": requestId } });
  }

  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);
    if (Number.isNaN(ideaId)) {
      return new NextResponse('Invalid idea ID', { status: 400 });
    }

    const sql = `
      SELECT 
        n.*,
        COALESCE(
          TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))),
          u.email,
          n.user_id::text
        ) as creator_name
      FROM idea_notes n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE n.idea_id = :ideaId
      ORDER BY n.created_at ASC
    `;
    const notes = await executeSQL<FormattedRow>(sql, [{ name: 'ideaId', value: { longValue: ideaId } }]);

    return NextResponse.json(notes.map((note) => ({
      ...note,
      // creator_name is converted to creatorName by formatDataApiResponse
      createdBy: note.creatorName || String(note.userId)
    })));
  } catch (error) {
    log.error('Error fetching notes:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId();
  const timer = startTimer("api.ideas.notes.create");
  const log = createLogger({ requestId, route: "api.ideas.notes.create" });
  
  const session = await getServerSession();
  if (!session?.sub) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const [isStaff, isAdmin] = await Promise.all([
    hasRole('staff'),
    hasRole('administrator')
  ]);
  if (!isStaff && !isAdmin) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  try {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;
    const ideaId = Number.parseInt(id);
    if (Number.isNaN(ideaId)) {
      return new NextResponse('Invalid idea ID', { status: 400 });
    }

    const { content } = await request.json();
    if (!content) {
      return new NextResponse('Missing content', { status: 400 });
    }

    // First get the user's numeric ID from their cognito_sub
    const userSql = 'SELECT id FROM users WHERE cognito_sub = :cognitoSub';
    const userResult = await executeSQL(userSql, [{ name: 'cognitoSub', value: { stringValue: session.sub } }]);
    
    if (!userResult || userResult.length === 0) {
      return new NextResponse('User not found', { status: 404 });
    }
    
    const userId = userResult[0].id;

    // First insert the note
    const insertSql = `
      INSERT INTO idea_notes (idea_id, content, user_id, created_at)
      VALUES (:ideaId, :content, :userId, NOW())
      RETURNING id
    `;
    const insertParams = [
      { name: 'ideaId', value: { longValue: ideaId } },
      { name: 'content', value: { stringValue: content } },
      { name: 'userId', value: { longValue: Number(userId) } }
    ];
    const insertResult = await executeSQL(insertSql, insertParams);
    const newNoteId = insertResult[0].id;

    // Then fetch it with the user name
    const fetchSql = `
      SELECT 
        n.*,
        COALESCE(
          TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))),
          u.email,
          n.user_id::text
        ) as creator_name
      FROM idea_notes n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE n.id = :noteId
    `;
    const fetchResult = await executeSQL(fetchSql, [{ name: 'noteId', value: { longValue: Number(newNoteId) } }]);
    const newNote = fetchResult[0];

    // The data is already converted to camelCase by formatDataApiResponse
    timer({ status: "success" });
    return NextResponse.json({
      ...newNote,
      createdBy: newNote.creatorName || String(newNote.userId)
    });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error creating note:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
} 