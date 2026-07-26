/**
 * Cross-owner consultations are disabled until a durable delegation grant
 * store exists. Prompt text, shared-space membership, and allowed email domain
 * are not authorization to mount another owner's workspace or credentials.
 */
export function canInvokeOwnerAgent(
  actorEmail: string,
  ownerEmail: string,
): boolean {
  return actorEmail.trim().toLowerCase() === ownerEmail.trim().toLowerCase();
}
