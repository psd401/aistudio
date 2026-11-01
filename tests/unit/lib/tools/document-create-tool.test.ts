/**
 * @jest-environment node
 *
 * Nexus `generate_document` chat tool (Issue #1898).
 *
 * `generateDocument` is mocked: this suite owns the TOOL's contract — that the
 * user and conversation come from the authenticated request rather than from
 * model input, that failures come back as data instead of throwing, and that the
 * result carries the authenticated download path the card renders. Document
 * rendering itself is covered by the service's own suite.
 *
 * Uses the global `jest` (NOT `import { jest } from '@jest/globals'`) so
 * jest.mock hoisting works (documented learning: that import disables hoisting).
 */

const generateDocumentMock = jest.fn();
jest.mock("@/lib/ai/document-generation-service", () => ({
  generateDocument: (...args: unknown[]) => generateDocumentMock(...args),
  isDocumentFormat: (value: unknown) =>
    typeof value === "string" &&
    ["pdf", "docx", "xlsx", "pptx", "md", "html", "txt", "csv"].includes(value),
}));

import {
  createDocumentCreateTool,
  skillPinAllowsDocumentCreate,
  DOCUMENT_CREATE_TOOL_NAME,
  type DocumentCreateToolResult,
} from "@/lib/tools/document-create-tool";
import { getManifestEntry } from "@/lib/tools/catalog/manifest";

const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

function buildTool() {
  return createDocumentCreateTool({ userId: 42, conversationId: CONVERSATION_ID });
}

/** Invoke the tool's `execute`, which the AI SDK types as optional. */
async function run(
  args: Record<string, unknown>
): Promise<DocumentCreateToolResult> {
  const tool = buildTool();
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  // The AI SDK passes a second options argument the tool does not read.
  return (await execute(
    args as never,
    {} as never
  )) as DocumentCreateToolResult;
}

describe("createDocumentCreateTool", () => {
  beforeEach(() => {
    generateDocumentMock.mockReset();
    generateDocumentMock.mockResolvedValue({
      s3Key: `v2/nexus-documents/${CONVERSATION_ID}/abc/report.docx`,
      downloadPath: `/api/nexus/documents/v2/nexus-documents/${CONVERSATION_ID}/abc/report.docx`,
      format: "docx",
      filename: "report.docx",
      bytes: 2048,
    });
  });

  it("is registered under the shared wire name", () => {
    expect(DOCUMENT_CREATE_TOOL_NAME).toBe("generate_document");
  });

  it("returns the filename, format, size and authenticated download path", async () => {
    const result = await run({
      format: "docx",
      content: "# Report\n\n- one",
      title: "Report",
    });
    expect(result).toEqual({
      ok: true,
      filename: "report.docx",
      format: "docx",
      bytes: 2048,
      downloadUrl: `/api/nexus/documents/v2/nexus-documents/${CONVERSATION_ID}/abc/report.docx`,
    });
  });

  it("takes userId and conversationId from the request, never from the model", async () => {
    await run({
      format: "docx",
      content: "x",
      // A model trying to redirect the document at another user/conversation.
      userId: "999",
      conversationId: "99999999-9999-9999-9999-999999999999",
    });
    expect(generateDocumentMock).toHaveBeenCalledTimes(1);
    expect(generateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        conversationId: CONVERSATION_ID,
      })
    );
  });

  it("never returns a presigned S3 URL to the model", async () => {
    generateDocumentMock.mockResolvedValue({
      s3Key: "k",
      format: "txt",
      filename: "a.txt",
      bytes: 1,
      // A service that regressed to presigning must not leak the URL through.
      url: "https://bucket.s3.us-west-2.amazonaws.com/k?X-Amz-Signature=secret",
    });
    const result = await run({ format: "txt", content: "x" });
    expect(JSON.stringify(result)).not.toContain("X-Amz-Signature");
    // With no download path there is nothing the card can link to, so the tool
    // reports no url rather than inventing one.
    expect(result.downloadUrl).toBeUndefined();
  });

  it("rejects an unsupported format without calling the generator", async () => {
    const result = await run({ format: "exe", content: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
    expect(generateDocumentMock).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only body", async () => {
    for (const content of ["", "   \n ", undefined]) {
      const result = await run({ format: "docx", content });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/empty/i);
    }
    expect(generateDocumentMock).not.toHaveBeenCalled();
  });

  it("returns a generator failure as data so the turn can continue", async () => {
    generateDocumentMock.mockRejectedValue(new Error("S3 unavailable"));
    const result = await run({ format: "docx", content: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("S3 unavailable");
  });

  it("passes an optional title and filename through, and omits absent ones", async () => {
    await run({ format: "pptx", content: "## A", title: "Deck", filename: "deck" });
    expect(generateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Deck", filename: "deck" })
    );

    generateDocumentMock.mockClear();
    await run({ format: "pptx", content: "## A", title: 7, filename: [] });
    expect(generateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: undefined, filename: undefined })
    );
  });

  it("declares the format enum on its wire schema", () => {
    const schema = buildTool().inputSchema as unknown as {
      jsonSchema?: { properties?: { format?: { enum?: string[] } } };
    };
    expect(schema.jsonSchema?.properties?.format?.enum).toContain("docx");
    expect(schema.jsonSchema?.properties?.format?.enum).toContain("pptx");
  });
});

describe("skillPinAllowsDocumentCreate", () => {
  it("allows the tool when no skill pins anything", () => {
    expect(skillPinAllowsDocumentCreate([])).toBe(true);
  });

  it("allows it when the pin names it by wire, friendly or catalog name", () => {
    expect(skillPinAllowsDocumentCreate(["generate_document"])).toBe(true);
    expect(skillPinAllowsDocumentCreate(["generateDocument"])).toBe(true);
    expect(skillPinAllowsDocumentCreate(["documents.create"])).toBe(true);
  });

  it("excludes it when a pin lists other tools only", () => {
    expect(skillPinAllowsDocumentCreate(["web_fetch", "show_chart"])).toBe(false);
  });
});

describe("catalog registration (#1898)", () => {
  it("exposes documents.create on the chat surface as well as internal", () => {
    const entry = getManifestEntry("documents.create");
    expect(entry).toBeDefined();
    expect(entry?.surfaces).toContain("ai_sdk");
    expect(entry?.surfaces).toContain("internal");
    expect(entry?.name).toBe(DOCUMENT_CREATE_TOOL_NAME);
  });

  it("is an always-on chat tool, not a selectable toggle", () => {
    // `getSelectableToolConfigsFromCatalog` keys selectability off displayName;
    // a displayName here would put a confusing switch in the tool selector for
    // a tool the model should always be able to reach.
    expect(getManifestEntry("documents.create")?.displayName).toBeUndefined();
  });

  it("keeps the other agent tools off the chat surface", () => {
    for (const identifier of ["images.generate", "web.fetch"]) {
      expect(getManifestEntry(identifier)?.surfaces).toEqual(["internal"]);
    }
  });

  /**
   * One catalog identifier now spans two surfaces with two independent
   * bindings: the agent loop dispatches `documents.create` through the catalog
   * to `handleGenerateDocument`, while Nexus attaches `createDocumentCreateTool`
   * directly. Nothing in the codebase compares their schemas, so editing one
   * without the other would silently desync the two surfaces' contracts. This
   * pins them together.
   */
  it("keeps the catalog schema and the chat wire schema in sync", () => {
    const catalogProps = Object.keys(
      (getManifestEntry("documents.create")?.inputSchema as {
        properties?: Record<string, unknown>;
      }).properties ?? {}
    ).sort();
    const wireSchema = buildTool().inputSchema as unknown as {
      jsonSchema: {
        properties: Record<string, unknown>;
        required?: string[];
      };
    };
    expect(Object.keys(wireSchema.jsonSchema.properties).sort()).toEqual(
      catalogProps
    );
    expect(wireSchema.jsonSchema.required?.slice().sort()).toEqual(
      (
        (getManifestEntry("documents.create")?.inputSchema as {
          required?: string[];
        }).required ?? []
      )
        .slice()
        .sort()
    );
  });
});
