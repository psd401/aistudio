import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSource = readFileSync(
  join(process.cwd(), "app/api/assistant-architect/execute/route.ts"),
  "utf8"
);

describe("Assistant Architect runtime repository execution integration", () => {
  it("resolves opaque runtime inputs before creating an execution record", () => {
    const resolveIndex = routeSource.indexOf(
      "resolveAssistantRuntimeRepositoryInputs(inputs, userId)"
    );
    const createIndex = routeSource.indexOf(
      "const created = await createToolExecutionRecord({"
    );

    expect(resolveIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(resolveIndex);
    expect(routeSource).toContain("inputs: modelInputs");
    expect(routeSource).toContain(
      "message: 'A temporary repository input is unavailable'"
    );
  });

  it("reloads the executable graph only after coordinated execution creation", () => {
    const authorizationPreflightIndex = routeSource.indexOf(
      "await preflightExecutionGraphBeforeRateCap({"
    );
    const createIndex = routeSource.indexOf(
      "const created = await createToolExecutionRecord({"
    );
    const protectedReloadIndex = routeSource.indexOf(
      "const protectedGraph = await loadProtectedExecutionGraph({"
    );

    expect(routeSource).toContain(
      "createCoordinatedAssistantExecution({"
    );
    expect(authorizationPreflightIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(authorizationPreflightIndex);
    expect(protectedReloadIndex).toBeGreaterThan(createIndex);
    expect(routeSource).toContain(
      "executionDeadlineAt: deadlineAt"
    );
  });

  it("rejects a stable non-executable graph before rate accounting", () => {
    const preflightStart = routeSource.indexOf(
      "async function preflightExecutionGraphBeforeRateCap("
    );
    const cardinalityIndex = routeSource.indexOf(
      "validatePromptChainCardinality({",
      preflightStart
    );
    const repositoryIndex = routeSource.indexOf(
      "preflightAssistantRepositoryAccess(",
      cardinalityIndex
    );
    const coordinatorIndex = routeSource.indexOf(
      "createCoordinatedAssistantExecution({"
    );

    expect(preflightStart).toBeGreaterThan(-1);
    expect(cardinalityIndex).toBeGreaterThan(preflightStart);
    expect(repositoryIndex).toBeGreaterThan(cardinalityIndex);
    expect(coordinatorIndex).toBeGreaterThan(repositoryIndex);
    expect(routeSource).toContain("promptCount: repositoryBindings.length");
  });

  it("existence-masks private assistants before feature authorization", () => {
    const missingResponseCalls = routeSource.match(
      /assistantArchitectNotFoundResponse\(/g
    );

    expect(missingResponseCalls).toHaveLength(3);
    expect(routeSource).not.toContain(
      "You do not have permission to execute this assistant architect"
    );
  });

  it("cleans up agentic resources when setup consumes the deadline", () => {
    const cleanupCreationIndex = routeSource.indexOf(
      "const cleanup = createAgenticCleanup({"
    );
    const timeoutGuardIndex = routeSource.indexOf(
      "let timeout: number;",
      cleanupCreationIndex
    );
    const timeoutCleanupIndex = routeSource.indexOf(
      "await cleanup();",
      timeoutGuardIndex
    );
    const streamPromiseIndex = routeSource.indexOf(
      "return new Promise<",
      timeoutCleanupIndex
    );

    expect(cleanupCreationIndex).toBeGreaterThan(-1);
    expect(timeoutGuardIndex).toBeGreaterThan(cleanupCreationIndex);
    expect(timeoutCleanupIndex).toBeGreaterThan(timeoutGuardIndex);
    expect(streamPromiseIndex).toBeGreaterThan(timeoutCleanupIndex);
  });

  it("merges runtime repositories into retrieval and repository tools", () => {
    expect(routeSource).toContain("...context.runtimeRepositoryIds");
    expect(routeSource).toContain(
      "const repositoryIds = getPromptRepositoryIds(prompt, context)"
    );
    expect(routeSource).toContain(
      "[prompt.content, context.runtimeRepositoryQuery].filter(Boolean).join('\\n')"
    );
    expect(routeSource).toContain("createRepositoryTools({");
    expect(routeSource).toContain("repositoryIds,");
    expect(routeSource).toContain("createAgenticRepositoryContext({");
    expect(routeSource).toContain("...repositoryContext.tools");
    expect(routeSource).toContain(
      "systemPrompt: args.run.effectiveSystemPrompt"
    );
  });

  it("persists runtime repository context on the resumable conversation", () => {
    expect(routeSource).toContain(
      "createAssistantExecutionConversation({"
    );
    expect(routeSource).toContain(
      "repositoryIds: conversationRepositoryIds"
    );
    expect(routeSource).toContain(
      "references: runtimeRepositoryInputs.references"
    );
  });

  it("finalizes a parallel last position only after every sibling settles", () => {
    const parallelStart = routeSource.indexOf(
      "async function executeParallelPositionGroup("
    );
    const allSettledIndex = routeSource.indexOf(
      "await Promise.allSettled(parallelPromises)",
      parallelStart
    );
    const finalizeIndex = routeSource.indexOf(
      "await finalizeExecutionOnLastPrompt(",
      allSettledIndex
    );

    expect(parallelStart).toBeGreaterThan(-1);
    expect(routeSource).toContain("completeExecution: false");
    expect(allSettledIndex).toBeGreaterThan(parallelStart);
    expect(finalizeIndex).toBeGreaterThan(allSettledIndex);
    expect(routeSource).toContain(
      "aggregatePromptUsage(completedUsages)"
    );
  });
});
