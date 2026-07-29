/**
 * Transactional room mutations. Authorization snapshots are rechecked while
 * the room row is locked so a non-owner cannot win a check/write race.
 */

import { and, eq } from "drizzle-orm";
import {
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  roomClasses,
  roomMembers,
  roomResources,
  rooms,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import { normalizeEmail } from "@/lib/groups/normalize";
import { canManageRoom } from "./validation";

export interface RoomMutationInput {
  name: string;
  classSourcedIds: string[];
  memberEmails: string[];
  assistantIds: number[];
}

export interface RoomMutationActor {
  userId: number;
  isAdministrator: boolean;
}

async function replaceRoomChildren(
  tx: DbTransaction,
  roomId: string,
  input: RoomMutationInput
): Promise<void> {
  await tx.delete(roomClasses).where(eq(roomClasses.roomId, roomId));
  if (input.classSourcedIds.length > 0) {
    await tx.insert(roomClasses).values(
      input.classSourcedIds.map((classSourcedId) => ({
        roomId,
        classSourcedId,
      }))
    );
  }

  await tx.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  if (input.memberEmails.length > 0) {
    await tx.insert(roomMembers).values(
      input.memberEmails.map((memberEmail) => ({
        roomId,
        memberEmail: normalizeEmail(memberEmail),
      }))
    );
  }

  await tx.delete(roomResources).where(eq(roomResources.roomId, roomId));
  if (input.assistantIds.length > 0) {
    await tx.insert(roomResources).values(
      input.assistantIds.map((assistantId) => ({
        roomId,
        resourceType: "assistant" as const,
        resourceId: String(assistantId),
      }))
    );
  }
}

export async function createManagedRoom(
  actor: RoomMutationActor,
  input: RoomMutationInput
): Promise<string> {
  return executeTransaction(
    async (tx) => {
      const [created] = await tx
        .insert(rooms)
        .values({
          name: input.name.trim(),
          createdBy: actor.userId,
        })
        .returning({ id: rooms.id });
      if (!created) {
        throw ErrorFactories.dbQueryFailed("create room");
      }
      await replaceRoomChildren(tx, created.id, input);
      return created.id;
    },
    "createManagedRoom"
  );
}

export async function updateManagedRoom(
  roomId: string,
  actor: RoomMutationActor,
  input: RoomMutationInput
): Promise<void> {
  await executeTransaction(
    async (tx) => {
      const [existing] = await tx
        .select({
          id: rooms.id,
          createdBy: rooms.createdBy,
        })
        .from(rooms)
        .where(and(eq(rooms.id, roomId), eq(rooms.isActive, true)))
        .for("update");
      if (!existing) {
        throw ErrorFactories.authzResourceNotFound("room", roomId);
      }
      if (
        !canManageRoom(
          actor.userId,
          existing.createdBy,
          actor.isAdministrator
        )
      ) {
        throw ErrorFactories.authzResourceNotFound("room", roomId);
      }
      await tx
        .update(rooms)
        .set({ name: input.name.trim() })
        .where(eq(rooms.id, roomId));
      await replaceRoomChildren(tx, roomId, input);
    },
    "updateManagedRoom"
  );
}

export async function deactivateManagedRoom(
  roomId: string,
  actor: RoomMutationActor
): Promise<void> {
  await executeTransaction(
    async (tx) => {
      const [existing] = await tx
        .select({
          id: rooms.id,
          createdBy: rooms.createdBy,
        })
        .from(rooms)
        .where(and(eq(rooms.id, roomId), eq(rooms.isActive, true)))
        .for("update");
      if (!existing) {
        throw ErrorFactories.authzResourceNotFound("room", roomId);
      }
      if (
        !canManageRoom(
          actor.userId,
          existing.createdBy,
          actor.isAdministrator
        )
      ) {
        throw ErrorFactories.authzResourceNotFound("room", roomId);
      }
      await tx
        .update(rooms)
        .set({ isActive: false })
        .where(eq(rooms.id, roomId));
    },
    "deactivateManagedRoom"
  );
}
