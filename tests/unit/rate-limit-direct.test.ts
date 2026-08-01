import { consumeRateLimit } from "@/lib/rate-limit";

describe("consumeRateLimit", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-01T20:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("allows the configured budget, refuses overflow, and resets by window", () => {
    const config = {
      namespace: "direct-test-fixed-window",
      identifier: "user:7",
      interval: 60_000,
      uniqueTokenPerInterval: 2,
    };

    expect(consumeRateLimit(config)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(consumeRateLimit(config)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(consumeRateLimit(config)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
      remaining: 0,
    });

    jest.advanceTimersByTime(60_001);

    expect(consumeRateLimit(config)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });
});
