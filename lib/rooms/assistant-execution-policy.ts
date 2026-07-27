import type { RoomAssistantAccessContext } from "@/lib/rooms/membership";

/**
 * Capability policy for the browser Assistant Architect execution surface.
 *
 * Capabilities remain the normal human feature gate. A room assignment is the
 * one narrow alternative: a room member may enter the execution flow for that
 * exact assigned assistant even without the general assistant-architect
 * capability. Membership in a room alone never bypasses the feature gate.
 */
export function hasAssistantExecutionFeatureAccess(params: {
  hasCapability: boolean;
  assistantId: number | string;
  roomAccess: RoomAssistantAccessContext;
}): boolean {
  return (
    params.hasCapability ||
    params.roomAccess.assignedAssistantIds.has(String(params.assistantId))
  );
}
