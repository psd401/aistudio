/**
 * Registry-parity tests for the Atrium content MCP tools (Issue #1055, §24).
 *
 * Guards the wiring invariants that a typo would otherwise leak to runtime: every
 * content tool is listed, scoped, and has a handler; the set is exactly the eleven
 * atomic primitives (no generate_and_publish); publish AND unpublish map to
 * publish_internal (the §26.4 gate, not the scope, blocks public in both
 * directions). The set includes the Phase 8 OKF interoperability tools
 * (export_okf / import_okf, #1103) and unpublish_content (REST-DELETE parity,
 * Epic #1059 completion).
 */

// The handlers module imports the content barrel, which transitively pulls the
// ESM-only remark/rehype render stack — unloadable under jest's CJS transform.
// Mock the two render modules so importing the handler map stays lightweight;
// the parity assertions never touch rendering.
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: jest.fn(),
}));
jest.mock("@/lib/content/render/html-sanitize", () => ({
  sanitizeHtml: jest.fn(),
}));

import { CONTENT_MCP_TOOLS, CONTENT_TOOL_SCOPE_MAP } from "@/lib/mcp/content-tools";
import { CONTENT_TOOL_HANDLERS } from "@/lib/mcp/content-tool-handlers";
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest";

const EXPECTED = [
  "create_document",
  "create_artifact",
  "get_content",
  "list_content",
  "update_content",
  "create_version",
  "set_visibility",
  "publish_content",
  "unpublish_content",
  "export_okf",
  "import_okf",
] as const;

describe("Atrium MCP content tools registry", () => {
  it("exposes exactly the eleven atomic primitives (no generate_and_publish)", () => {
    const names = CONTENT_MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED].sort());
    expect(names).not.toContain("generate_and_publish");
  });

  it("maps every tool to a scope and a handler", () => {
    for (const name of EXPECTED) {
      expect(CONTENT_TOOL_SCOPE_MAP[name]).toBeDefined();
      expect(typeof CONTENT_TOOL_HANDLERS[name]).toBe("function");
    }
  });

  it("keeps the unified catalog's requiredScopes in sync with CONTENT_TOOL_SCOPE_MAP (drift guard — the catalog is the live enforcement point, epic #922 audit)", () => {
    for (const name of EXPECTED) {
      const entry = TOOL_MANIFEST.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry!.requiredScopes).toEqual([CONTENT_TOOL_SCOPE_MAP[name]]);
    }
  });

  it("scopes reads to content:read, mutations to create/update, publish to publish_internal", () => {
    expect(CONTENT_TOOL_SCOPE_MAP.get_content).toBe("content:read");
    expect(CONTENT_TOOL_SCOPE_MAP.list_content).toBe("content:read");
    expect(CONTENT_TOOL_SCOPE_MAP.create_document).toBe("content:create");
    expect(CONTENT_TOOL_SCOPE_MAP.create_artifact).toBe("content:create");
    expect(CONTENT_TOOL_SCOPE_MAP.update_content).toBe("content:update");
    expect(CONTENT_TOOL_SCOPE_MAP.create_version).toBe("content:update");
    expect(CONTENT_TOOL_SCOPE_MAP.set_visibility).toBe("content:update");
    // Public publishing is gated in publishService (§26.4), NOT by a separate
    // tool scope — the tool requires only the internal-publish scope. Unpublish
    // shares the model: taking down a public destination is gated inside
    // publishService.unpublish, not by a distinct scope.
    expect(CONTENT_TOOL_SCOPE_MAP.publish_content).toBe("content:publish_internal");
    expect(CONTENT_TOOL_SCOPE_MAP.unpublish_content).toBe("content:publish_internal");
    // OKF export is a read/serialization (the §26.4 public-bundle gate is enforced
    // in okfExportService, not by a distinct tool scope); import creates content.
    expect(CONTENT_TOOL_SCOPE_MAP.export_okf).toBe("content:read");
    expect(CONTENT_TOOL_SCOPE_MAP.import_okf).toBe("content:create");
  });

  it("every tool input schema declares a type and properties", () => {
    for (const tool of CONTENT_MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("unpublish_content mirrors the REST DELETE destination set (no okf)", () => {
    const tool = CONTENT_MCP_TOOLS.find((t) => t.name === "unpublish_content");
    expect(tool).toBeDefined();
    // An okf publication is a serialized S3 bundle with no live surface to take
    // down — the REST DELETE route rejects it, so the tool enum must not offer it.
    expect(tool?.inputSchema.properties.destination?.enum).toEqual([
      "intranet",
      "public_web",
      "schoology",
      "google",
    ]);
    expect(tool?.inputSchema.required).toEqual(["id", "destination"]);
  });

  it("list_content exposes the optional title-search `query` property", () => {
    const tool = CONTENT_MCP_TOOLS.find((t) => t.name === "list_content");
    expect(tool?.inputSchema.properties.query?.type).toBe("string");
    // Optional: `query` must not be in required.
    expect(tool?.inputSchema.required ?? []).not.toContain("query");
  });

  it("the body-carrying create/version tools expose an optional codeEncoding: base64", () => {
    // WAF-opaque transit: an artifact whose code contains <script>/<style> must be
    // sendable base64-encoded so the edge WAF's CrossSiteScripting_BODY rule can't
    // match it. Every tool that carries a body offers the flag; it stays optional
    // (a bodyless / plain-text call omits it).
    for (const name of ["create_document", "create_artifact", "create_version"]) {
      const tool = CONTENT_MCP_TOOLS.find((t) => t.name === name);
      expect(tool?.inputSchema.properties.codeEncoding?.enum).toEqual(["base64"]);
      expect(tool?.inputSchema.required ?? []).not.toContain("codeEncoding");
    }
  });

  it("publishes sourceRef additions as v3 create-tool contracts", () => {
    for (const name of ["create_document", "create_artifact"]) {
      const tool = CONTENT_MCP_TOOLS.find((candidate) => candidate.name === name);
      const manifestEntry = TOOL_MANIFEST.find(
        (candidate) => candidate.name === name
      );

      expect(tool?.inputSchema.properties.sourceRef?.type).toBe("object");
      expect(tool?.inputSchema.required ?? []).not.toContain("sourceRef");
      expect(manifestEntry?.version).toBe("v3");
    }
  });
});
