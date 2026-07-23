/** @jest-environment node */

const mockCreateRepositoryTools = jest.fn();

jest.mock("@/lib/tools/repository-tools", () => ({
  createRepositoryTools: (...args: unknown[]) =>
    mockCreateRepositoryTools(...args),
}));

import {
  collectAgenticRepositoryIds,
  createAgenticRepositoryContext,
} from "@/lib/assistant-architect/agentic-repository-context";

describe("agentic Assistant Architect repository context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateRepositoryTools.mockReturnValue({
      hybridSearch: { execute: jest.fn() },
    });
  });

  it("unions every static binding with owner-resolved runtime repositories", () => {
    expect(
      collectAgenticRepositoryIds(
        [
          { repositoryIds: [3, 5] },
          { repositoryIds: [5, 7] },
          { repositoryIds: null },
        ],
        [7, 11]
      )
    ).toEqual([3, 5, 7, 11]);
  });

  it("adds mandatory executor-scoped search tools and source guidance", () => {
    const context = createAgenticRepositoryContext({
      prompts: [{ repositoryIds: [3] }, { repositoryIds: [5] }],
      runtimeRepositoryIds: [11],
      userCognitoSub: "executor-sub",
    });

    expect(mockCreateRepositoryTools).toHaveBeenCalledWith({
      repositoryIds: [3, 5, 11],
      userCognitoSub: "executor-sub",
    });
    expect(context.tools).toHaveProperty("hybridSearch");
    expect(context.systemGuidance).toContain(
      "Search the repositories before making source-based claims"
    );
  });

  it("adds no tools or guidance when the run has no repositories", () => {
    expect(
      createAgenticRepositoryContext({
        prompts: [{ repositoryIds: null }],
        runtimeRepositoryIds: [],
        userCognitoSub: "executor-sub",
      })
    ).toEqual({ repositoryIds: [], tools: {}, systemGuidance: "" });
    expect(mockCreateRepositoryTools).not.toHaveBeenCalled();
  });
});
