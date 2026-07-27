/**
 * Pure authorization/assignment decisions shared by room server actions and
 * focused unit tests. The action layer supplies fresh server-side data.
 */

export function canManageRoom(
  actorUserId: number,
  createdBy: number | null,
  isAdministrator: boolean
): boolean {
  return isAdministrator || createdBy === actorUserId;
}

/**
 * Existing links may be preserved by an administrator maintaining somebody
 * else's room. Every newly added link must belong to the acting teacher.
 */
export function findUnauthorizedClassIds(
  desiredClassIds: string[],
  existingClassIds: string[],
  teacherClassIds: ReadonlySet<string>,
  isAdministrator: boolean
): string[] {
  const existing = new Set(existingClassIds);
  return desiredClassIds.filter(
    (classId) =>
      !teacherClassIds.has(classId) &&
      !(isAdministrator && existing.has(classId))
  );
}

export function findUnauthorizedAssistantIds(
  desiredAssistantIds: number[],
  accessibleAssistantIds: ReadonlySet<number>
): number[] {
  return desiredAssistantIds.filter(
    (assistantId) => !accessibleAssistantIds.has(assistantId)
  );
}
