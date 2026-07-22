export class EmbeddingRecoveryDispatchError extends Error {
  readonly dispatchedMessages: number;

  constructor(cause: unknown, dispatchedMessages: number) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail, { cause });
    this.name = "EmbeddingRecoveryDispatchError";
    this.dispatchedMessages = dispatchedMessages;
  }
}

/**
 * Track the durable SQS boundary around one claimed generation.
 *
 * A zero-message failure releases the claim so its previous status/error can
 * be restored. Once any message is accepted by SQS, the claim must remain: a
 * late failure is a partial dispatch, and releasing it would both hide that
 * durable work and let a stale invocation corrupt a newer scheduler claim.
 */
export async function dispatchClaimedEmbeddingGeneration(
  dispatch: (onMessageSent: () => void) => Promise<void>,
  releaseZeroDispatchClaim: () => Promise<unknown>
): Promise<number> {
  let dispatchedMessages = 0;
  try {
    await dispatch(() => {
      dispatchedMessages += 1;
    });
    return dispatchedMessages;
  } catch (error) {
    if (dispatchedMessages === 0) {
      await releaseZeroDispatchClaim();
    }
    throw new EmbeddingRecoveryDispatchError(error, dispatchedMessages);
  }
}
