export const SCHEDULE_MUTATION_LOCK_LEASE_SECONDS = 5 * 60;

export interface ScheduleMutationIdentity {
  ownerEmail: string;
  scheduleId: string;
}

export function scheduleMutationLockKey(
  identity: ScheduleMutationIdentity,
): { userId: string; scheduleId: string } {
  return {
    userId: identity.ownerEmail.trim().toLowerCase(),
    scheduleId: `__mutation__${identity.scheduleId}`,
  };
}
