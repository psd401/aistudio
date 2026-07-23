/** @jest-environment node */

const mockGetServerSession = jest.fn();

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

import { apiRateLimit } from "@/lib/rate-limit";

describe("temporary attachment upload rate limit", () => {
  it("returns 429 after five upload mutations for one authenticated principal", async () => {
    mockGetServerSession.mockResolvedValue({
      sub: `temporary-upload-rate-${Date.now()}`,
    });
    const handler = jest.fn(
      async (_request: Request) => new Response("ok", { status: 200 })
    );
    const limited = apiRateLimit.upload(handler);
    const responses: Response[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(
        await limited(
          new Request("http://localhost/api/repositories/temporary-attachments", {
            method: "POST",
          })
        )
      );
    }

    expect(responses.slice(0, 5).map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(responses[5]?.status).toBe(429);
    expect(await responses[5]?.json()).toMatchObject({
      error: { code: "RATE_LIMIT_EXCEEDED" },
    });
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it("keeps initiation and completion endpoint budgets independent", async () => {
    mockGetServerSession.mockResolvedValue({
      sub: `temporary-upload-route-budgets-${Date.now()}`,
    });
    const initiateHandler = jest.fn(
      async (_request: Request) => new Response("initiated")
    );
    const completeHandler = jest.fn(
      async (_request: Request) => new Response("completed")
    );
    const initiate = apiRateLimit.upload(initiateHandler);
    const complete = apiRateLimit.upload(completeHandler);
    const request = () =>
      new Request(
        "http://localhost/api/repositories/temporary-attachments",
        { method: "POST" }
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await initiate(request())).status).toBe(200);
      expect((await complete(request())).status).toBe(200);
    }

    expect(initiateHandler).toHaveBeenCalledTimes(5);
    expect(completeHandler).toHaveBeenCalledTimes(5);
  });
});
