/**
 * Drizzle Ideas Operations
 *
 * CRUD operations for ideas, idea votes, and idea notes.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, sql, desc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { ideas, ideaVotes, ideaNotes, users } from "@/lib/db/schema";

// ============================================
// Types
// ============================================

export interface IdeaListItem {
  id: number;
  title: string;
  description: string;
  priorityLevel: string;
  status: string;
  votes: number;
  createdAt: Date | null;
  completedAt: Date | null;
  completedBy: string | null;
  updatedAt: Date | null;
  userId: number | null;
  creatorName: string | null;
  completedByName: string | null;
  notesCount: number;
  hasVoted?: boolean;
}

export interface CreateIdeaData {
  title: string;
  description: string;
  priorityLevel: string;
  userId: number;
}

// ============================================
// Query Operations
// ============================================

/**
 * Get all ideas with creator names, vote counts, and note counts
 * Complex query with multiple LEFT JOINs and aggregations
 */
export async function getIdeas() {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: ideas.id,
          title: ideas.title,
          description: ideas.description,
          priorityLevel: ideas.priorityLevel,
          status: ideas.status,
          votes: ideas.votes,
          createdAt: ideas.createdAt,
          completedAt: ideas.completedAt,
          completedBy: ideas.completedBy,
          updatedAt: ideas.updatedAt,
          userId: ideas.userId,
          // Creator name with fallback logic
          creatorFirstName: users.firstName,
          creatorLastName: users.lastName,
          creatorEmail: users.email,
          // Counts from aggregations - we'll compute these separately
          votesCount: sql<number>`COUNT(DISTINCT ${ideaVotes.id})::int`,
          notesCount: sql<number>`COUNT(DISTINCT ${ideaNotes.id})::int`,
        })
        .from(ideas)
        .leftJoin(users, eq(ideas.userId, users.id))
        .leftJoin(ideaVotes, eq(ideas.id, ideaVotes.ideaId))
        .leftJoin(ideaNotes, eq(ideas.id, ideaNotes.ideaId))
        .groupBy(
          ideas.id,
          users.firstName,
          users.lastName,
          users.email
        )
        .orderBy(desc(ideas.createdAt)),
    "getIdeas"
  );

  // Transform to IdeaListItem format with creator name logic
  return result.map((row) => {
    const creatorName =
      row.creatorFirstName || row.creatorLastName
        ? `${row.creatorFirstName || ""} ${row.creatorLastName || ""}`.trim()
        : row.creatorEmail || (row.userId ? String(row.userId) : null);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      priorityLevel: row.priorityLevel,
      status: row.status,
      votes: row.votesCount,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      completedBy: row.completedBy,
      updatedAt: row.updatedAt,
      userId: row.userId,
      creatorName,
      completedByName: null, // Will be populated separately if needed
      notesCount: row.notesCount,
    } as IdeaListItem;
  });
}

/**
 * Get user's voted idea IDs
 */
export async function getUserVotedIdeaIds(userId: number): Promise<Set<number>> {
  const votes = await executeQuery(
    (db) =>
      db
        .select({ ideaId: ideaVotes.ideaId })
        .from(ideaVotes)
        .where(eq(ideaVotes.userId, userId)),
    "getUserVotedIdeaIds"
  );

  return new Set(votes.map((v) => v.ideaId));
}

/**
 * Get idea by ID
 */
export async function getIdeaById(ideaId: number) {
  const result = await executeQuery(
    (db) => db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1),
    "getIdeaById"
  );

  return result[0];
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create new idea
 */
export async function createIdea(data: CreateIdeaData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(ideas)
        .values({
          title: data.title,
          description: data.description,
          priorityLevel: data.priorityLevel,
          status: "active",
          userId: data.userId,
        })
        .returning(),
    "createIdea"
  );

  return result[0];
}

/**
 * Update idea fields
 * Allows partial updates of title, description, priorityLevel, status
 */
export async function updateIdea(
  ideaId: number,
  updates: {
    title?: string;
    description?: string;
    priorityLevel?: string;
    status?: string;
    completedBy?: string;
  }
) {
  const updateData: Record<string, unknown> = {};

  if (updates.title) updateData.title = updates.title;
  if (updates.description) updateData.description = updates.description;
  if (updates.priorityLevel) updateData.priorityLevel = updates.priorityLevel;
  if (updates.status) {
    updateData.status = updates.status;
    if (updates.status === "completed" && updates.completedBy) {
      updateData.completedAt = new Date();
      updateData.completedBy = updates.completedBy;
    }
  }

  const result = await executeQuery(
    (db) =>
      db.update(ideas).set(updateData).where(eq(ideas.id, ideaId)).returning(),
    "updateIdea"
  );

  return result[0];
}

/**
 * Update idea status
 */
export async function updateIdeaStatus(
  ideaId: number,
  status: string,
  completedBy?: string
) {
  return updateIdea(ideaId, { status, completedBy });
}

// ============================================
// Vote Operations
// ============================================

/**
 * Add vote to idea
 */
export async function addVote(ideaId: number, userId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(ideaVotes)
        .values({
          ideaId,
          userId,
        })
        .returning(),
    "addVote"
  );

  // Increment vote count on idea
  await executeQuery(
    (db) =>
      db
        .update(ideas)
        .set({ votes: sql`${ideas.votes} + 1` })
        .where(eq(ideas.id, ideaId)),
    "addVote:incrementCount"
  );

  return result[0];
}

/**
 * Remove vote from idea
 */
export async function removeVote(ideaId: number, userId: number) {
  await executeQuery(
    (db) =>
      db
        .delete(ideaVotes)
        .where(and(eq(ideaVotes.ideaId, ideaId), eq(ideaVotes.userId, userId))),
    "removeVote"
  );

  // Decrement vote count on idea
  await executeQuery(
    (db) =>
      db
        .update(ideas)
        .set({ votes: sql`${ideas.votes} - 1` })
        .where(eq(ideas.id, ideaId)),
    "removeVote:decrementCount"
  );
}

/**
 * Check if user has voted for idea
 */
export async function hasUserVoted(
  ideaId: number,
  userId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ id: ideaVotes.id })
        .from(ideaVotes)
        .where(and(eq(ideaVotes.ideaId, ideaId), eq(ideaVotes.userId, userId)))
        .limit(1),
    "hasUserVoted"
  );

  return result.length > 0;
}

// ============================================
// Note Operations
// ============================================

/**
 * Get notes for idea
 */
export async function getIdeaNotes(ideaId: number) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: ideaNotes.id,
          ideaId: ideaNotes.ideaId,
          content: ideaNotes.content,
          createdAt: ideaNotes.createdAt,
          updatedAt: ideaNotes.updatedAt,
          userId: ideaNotes.userId,
          creatorFirstName: users.firstName,
          creatorLastName: users.lastName,
          creatorEmail: users.email,
        })
        .from(ideaNotes)
        .leftJoin(users, eq(ideaNotes.userId, users.id))
        .where(eq(ideaNotes.ideaId, ideaId))
        .orderBy(desc(ideaNotes.createdAt)),
    "getIdeaNotes"
  );
}

/**
 * Add note to idea
 */
export async function addNote(ideaId: number, userId: number, content: string) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(ideaNotes)
        .values({
          ideaId,
          userId,
          content,
        })
        .returning(),
    "addNote"
  );

  return result[0];
}

/**
 * Delete note
 */
export async function deleteNote(noteId: number, userId: number) {
  await executeQuery(
    (db) =>
      db
        .delete(ideaNotes)
        .where(and(eq(ideaNotes.id, noteId), eq(ideaNotes.userId, userId))),
    "deleteNote"
  );
}
