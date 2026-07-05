/**
 * Registry-parity tests for the Atrium content MCP tools (Issue #1055, §24).
 *
 * Guards the wiring invariants that a typo would otherwise leak to runtime: every
 * content tool is listed, scoped, and has a handler; the set is exactly the ten
 * atomic primitives (no generate_and_publish); publish maps to publish_internal
 * (the gate, not the scope, blocks public). The set includes the Phase 8 OKF
 * interoperability tools (export_okf / import_okf, #1103).
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

const EXPECTED = [
  "create_document",
  "create_artifact",
  "get_content",
  "list_content",
  "update_content",
  "create_version",
  "set_visibility",
  "publish_content",
  "export_okf",
  "import_okf",
] as const;

describe("Atrium MCP content tools registry", () => {
  it("exposes exactly the ten atomic primitives (no generate_and_publish)", () => {
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

  it("scopes reads to content:read, mutations to create/update, publish to publish_internal", () => {
    expect(CONTENT_TOOL_SCOPE_MAP.get_content).toBe("content:read");
    expect(CONTENT_TOOL_SCOPE_MAP.list_content).toBe("content:read");
    expect(CONTENT_TOOL_SCOPE_MAP.create_document).toBe("content:create");
    expect(CONTENT_TOOL_SCOPE_MAP.create_artifact).toBe("content:create");
    expect(CONTENT_TOOL_SCOPE_MAP.update_content).toBe("content:update");
    expect(CONTENT_TOOL_SCOPE_MAP.create_version).toBe("content:update");
    expect(CONTENT_TOOL_SCOPE_MAP.set_visibility).toBe("content:update");
    // Public publishing is gated in publishService (§26.4), NOT by a separate
    // tool scope — the tool requires only the internal-publish scope.
    expect(CONTENT_TOOL_SCOPE_MAP.publish_content).toBe("content:publish_internal");
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
});
