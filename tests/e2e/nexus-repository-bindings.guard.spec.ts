import { expect, test } from "./fixtures";

test.describe("Nexus repository binding guard", () => {
  test("rejects unauthenticated binding reads and writes", async ({
    request,
  }) => {
    const conversationId = "11111111-2222-4333-8444-555555555555";
    const endpoint = `/api/nexus/conversations/${conversationId}/repositories`;

    const read = await request.get(endpoint);
    expect(read.status()).toBe(401);

    const write = await request.put(endpoint, {
      data: { repositoryIds: [39] },
    });
    expect(write.status()).toBe(401);
  });
});
