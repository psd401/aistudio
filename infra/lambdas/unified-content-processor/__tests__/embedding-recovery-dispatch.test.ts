import {
  dispatchClaimedEmbeddingGeneration,
  EmbeddingRecoveryDispatchError,
} from "../embedding-recovery-dispatch";

describe("embedding recovery dispatch boundary", () => {
  test("releases a zero-message failure while preserving its bounded attempt", async () => {
    const release = jest.fn(async () => true);

    await expect(
      dispatchClaimedEmbeddingGeneration(async () => {
        throw new Error("SQS permission denied");
      }, release)
    ).rejects.toMatchObject({
      name: "EmbeddingRecoveryDispatchError",
      message: "SQS permission denied",
      dispatchedMessages: 0,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("never releases after a partial durable dispatch", async () => {
    const release = jest.fn(async () => true);

    try {
      await dispatchClaimedEmbeddingGeneration(async (onMessageSent) => {
        onMessageSent();
        throw new Error("second SQS send failed");
      }, release);
      throw new Error("Expected the partial dispatch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingRecoveryDispatchError);
      expect(error).toMatchObject({ dispatchedMessages: 1 });
    }
    expect(release).not.toHaveBeenCalled();
  });

  test("reports every successful durable message", async () => {
    await expect(
      dispatchClaimedEmbeddingGeneration(async (onMessageSent) => {
        onMessageSent();
        onMessageSent();
      }, async () => undefined)
    ).resolves.toBe(2);
  });
});
