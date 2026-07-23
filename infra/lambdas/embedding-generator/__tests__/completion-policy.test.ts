import { shouldMarkItemEmbedded } from "../completion-policy";

describe("embedding generation completion policy", () => {
  test("preserves whole-item completion for legacy queue messages", () => {
    expect(shouldMarkItemEmbedded({}, 10)).toBe(true);
  });

  test("waits for every canonical generation chunk", () => {
    expect(
      shouldMarkItemEmbedded(
        { generationId: "11111111-2222-4333-8444-555555555555" },
        1
      )
    ).toBe(false);
  });

  test("completes a canonical generation only when no chunks remain", () => {
    expect(
      shouldMarkItemEmbedded(
        { generationId: "11111111-2222-4333-8444-555555555555" },
        0
      )
    ).toBe(true);
  });
});
