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
      "systemPrompt: effectiveSystemPrompt"
    );
  });
});
