import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths are fixed test fixtures declared below and resolved under the checkout.
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("repository reliability source contracts", () => {
  it("throws every non-streaming Nexus HTTP failure before SSE parsing", () => {
    const nexusPage = source("app/(protected)/nexus/page.tsx");
    expect(nexusPage).toContain("if (response.ok) return");
    expect(nexusPage).toContain(
      'log.warn("Nexus chat returned a non-streaming error"'
    );
    expect(nexusPage).toMatch(
      /await response\.body\?\.cancel\(\)\.catch\(\(\) => \{\}\)\s+throw new Error\(description\)/
    );
  });

  it("never sends an uninitialized empty repository selection", () => {
    const nexusPage = source("app/(protected)/nexus/page.tsx");
    expect(nexusPage).toContain(
      "repositoryIds: values.repositorySelectionLoaded"
    );
    expect(nexusPage).toContain("? values.selectedRepositoryIds");
    expect(nexusPage).toContain(
      "loadRepositories={getNexusAccessibleRepositoriesAction}"
    );
    const repositoryActions = source(
      "actions/repositories/repository.actions.ts"
    );
    expect(repositoryActions).toMatch(
      /getNexusAccessibleRepositoriesAction[\s\S]*requireRepositoryManagerCapability: false/
    );
  });

  it("compensates every failed first Nexus turn, including repository preflight errors", () => {
    const nexusRoute = source("app/api/nexus/chat/route.ts");
    expect(nexusRoute).toContain(
      "async function compensateFailedNewConversation"
    );
    expect(nexusRoute).toMatch(
      /if \(!repositories\.ok\) \{\s+await compensateFailedNewConversation/
    );
    expect(nexusRoute).toContain(
      "if (!params.conversation.created) return"
    );
  });

  it("fences Google pause and acknowledges paused in-flight work", () => {
    const connectorService = source(
      "lib/repositories/google-drive/connector-service.ts"
    );
    const syncWorker = source("infra/lambdas/google-content-sync/index.ts");
    expect(connectorService).toContain(
      "selectionRevision: sql`${repositoryConnectors.selectionRevision} + 1`"
    );
    expect(syncWorker).toContain("class ConnectorPausedError");
    expect(syncWorker).toContain('"CONNECTOR_PAUSED"');
    expect(syncWorker).toContain("assertConnectorWorkCurrent(context)");
  });

  it("writes embeddings only while a generation is building", () => {
    const embeddingWorker = source(
      "infra/lambdas/embedding-generator/index.ts"
    );
    expect(embeddingWorker).toContain(
      'return generation?.status === "building"'
    );
    expect(embeddingWorker).toContain(
      "Acknowledging stale text embedding work before provider call"
    );
    expect(embeddingWorker).toContain(
      "Acknowledging stale visual embedding work before provider call"
    );
  });
});
