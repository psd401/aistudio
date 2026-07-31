/** @jest-environment node */

const getBindings = jest.fn();
const replaceBindings = jest.fn();

if (typeof Response.json !== "function") {
  Object.defineProperty(Response, "json", {
    configurable: true,
    value: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json" },
      }),
  });
}

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn().mockResolvedValue({ sub: "user-sub" }),
}));
jest.mock("@/lib/auth/resolve-user", () => ({
  resolveUserId: jest.fn().mockResolvedValue(7),
}));
jest.mock("@/lib/nexus/conversation-repository-service", () => {
  class ConversationRepositoryBindingError extends Error {
    readonly code = "REPOSITORY_BINDING_INACCESSIBLE";
    readonly repositoryIds = [41];
  }
  return {
    ConversationRepositoryBindingError,
    getConversationRepositoryBindings: (...args: unknown[]) =>
      getBindings(...args),
    replaceConversationRepositoryBindings: (...args: unknown[]) =>
      replaceBindings(...args),
    repositoryBindingErrorResponse: (
      error: InstanceType<typeof ConversationRepositoryBindingError>
    ) =>
      Response.json(
        {
          code: error.code,
          repositoryIds: error.repositoryIds,
        },
        { status: 403 }
      ),
  };
});
jest.mock("@/lib/repositories/readiness-service", () => ({
  RepositoryReadinessError: class MockReadinessError extends Error {},
}));

import {
  GET,
  PUT,
} from "@/app/api/nexus/conversations/[id]/repositories/route";

const mockedBindingService = jest.requireMock(
  "@/lib/nexus/conversation-repository-service"
) as {
  ConversationRepositoryBindingError: new () => Error;
};

const context = {
  params: Promise.resolve({
    id: "11111111-2222-4333-8444-555555555555",
  }),
};

describe("Nexus durable repository binding route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns direct selections separately from inherited bindings", async () => {
    getBindings.mockResolvedValue([
      { repositoryId: 39, source: "direct", sourceId: "" },
      { repositoryId: 40, source: "project", sourceId: "project-1" },
    ]);

    const response = await GET(new Request("https://example.test"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bindings: [
        { repositoryId: 39, source: "direct", sourceId: "" },
        { repositoryId: 40, source: "project", sourceId: "project-1" },
      ],
      directRepositoryIds: [39],
    });
  });

  it("persists at most twenty explicit repository selections", async () => {
    replaceBindings.mockResolvedValue([
      { repositoryId: 39, source: "direct", sourceId: "" },
    ]);
    const response = await PUT(
      new Request("https://example.test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryIds: [39] }),
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(replaceBindings).toHaveBeenCalledWith({
      conversationId: "11111111-2222-4333-8444-555555555555",
      userId: 7,
      repositoryIds: [39],
      source: "direct",
    });
  });

  it("returns a structured access error instead of a stream-like response", async () => {
    replaceBindings.mockRejectedValue(
      new mockedBindingService.ConversationRepositoryBindingError()
    );
    const response = await PUT(
      new Request("https://example.test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryIds: [41] }),
      }),
      context
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "REPOSITORY_BINDING_INACCESSIBLE",
      repositoryIds: [41],
    });
  });
});
