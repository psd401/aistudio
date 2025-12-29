import { getServerSession } from '@/lib/auth/server-session';
import { NextResponse } from 'next/server';
import { getIdeaNotes, addNote, getUserIdByCognitoSub } from '@/lib/db/drizzle';
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

    const notes = await getIdeaNotes(ideaId);

    return NextResponse.json(notes.map((note) => {
      const creatorName =
        note.creatorFirstName || note.creatorLastName
          ? `${note.creatorFirstName || ""} ${note.creatorLastName || ""}`.trim()
          : note.creatorEmail || (note.userId ? String(note.userId) : "Unknown");

      return {
        id: note.id,
        ideaId: note.ideaId,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        userId: note.userId,
        creatorName,
        createdBy: creatorName,
      };
    }));
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

    // Get the user's numeric ID from their cognito_sub
    const userIdString = await getUserIdByCognitoSub(session.sub);

    if (!userIdString) {
      return new NextResponse('User not found', { status: 404 });
    }

    const userId = Number(userIdString);

    // Add the note
    const newNote = await addNote(ideaId, userId, content);

    timer({ status: "success" });
    return NextResponse.json({
      ...newNote,
      createdBy: String(newNote.userId)
    });
  } catch (error) {
    timer({ status: "error" });
    log.error('Error creating note:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
} 