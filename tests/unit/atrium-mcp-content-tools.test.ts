/**
 * Registry-parity tests for the Atrium content MCP tools (Issue #1055, §24).
 *
 * Guards the wiring invariants that a typo would otherwise leak to runtime: every
 * content tool is listed, scoped, and has a handler; the set is exactly the twelve
 * atomic primitives (no generate_and_publish); publish AND unpublish map to
 * publish_internal (the §26.4 gate, not the scope, blocks public in both
 * directions). The set includes the Phase 8 OKF interoperability tools
 * (export_okf / import_okf, #1103), unpublish_content (REST-DELETE parity,
 * Epic #1059 completion) and get_visibility (the grant-list read, #1763).
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
import { buildArtifactCspGuidance } from "@/lib/content/artifact-sandbox-config";
import { ATRIUM_DATA_AUTHORING_GUIDANCE } from "@/lib/content/atrium-data-contract";

const EXPECTED = [
  "create_document",
  "create_artifact",
  "get_content",
  "get_visibility",
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
  it("exposes exactly the twelve atomic primitives (no generate_and_publish)", () => {
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
    // #1763 — a READ, so content:read, not the paired write's content:update.
    // The grant list is withheld from a non-editor by the service's edit gate
    // (readVisibilityForEdit), not by requiring a write scope to read.
    expect(CONTENT_TOOL_SCOPE_MAP.get_visibility).toBe("content:read");
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

  it("list_content exposes an optional ISO date-time `since` property", () => {
    const tool = CONTENT_MCP_TOOLS.find((t) => t.name === "list_content");
    const manifestEntries = TOOL_MANIFEST.filter(
      (entry) => entry.identifier === "content.list"
    );
    const v1 = manifestEntries.find((entry) => entry.version === "v1");
    const v2 = manifestEntries.find((entry) => entry.version === "v2");

    expect(tool?.inputSchema.properties.since).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(tool?.inputSchema.required ?? []).not.toContain("since");
    expect(v2?.inputSchema.properties.since).toEqual(
      tool?.inputSchema.properties.since
    );
    expect(v1).toMatchObject({
      name: "list_content",
      description:
        "List content the caller may view. Filterable by kind, collection, tag, status, and title text.",
      surfaces: ["mcp", "internal"],
      requiredScopes: ["content:read"],
      surfaceScopes: { internal: ["content:read"] },
    });
    expect(Object.keys(v1?.inputSchema.properties ?? {})).toEqual([
      "kind",
      "collection",
      "tag",
      "status",
      "query",
    ]);
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

  it("publishes sourceRef additions as create-tool contracts at v3 or later", () => {
    const expectedVersion: Record<string, string> = {
      create_document: "v3",
      // v4: #1710 added `dataAccess` to create_artifact.
      create_artifact: "v4",
    };
    for (const name of ["create_document", "create_artifact"]) {
      const tool = CONTENT_MCP_TOOLS.find((candidate) => candidate.name === name);
      const manifestEntry = TOOL_MANIFEST.find(
        (candidate) => candidate.name === name
      );

      expect(tool?.inputSchema.properties.sourceRef?.type).toBe("object");
      expect(tool?.inputSchema.required ?? []).not.toContain("sourceRef");
      expect(manifestEntry?.version).toBe(expectedVersion[name]);
    }
  });

  it("publishes the #1710 dataAccess field under bumped catalog versions", () => {
    // A published version's schema is frozen by the catalog sync; adding
    // dataAccess without a bump left prod serving the old contract.
    const expectedVersion: Record<string, string> = {
      create_artifact: "v4",
      update_content: "v2",
    };
    for (const name of ["create_artifact", "update_content"]) {
      const tool = CONTENT_MCP_TOOLS.find((candidate) => candidate.name === name);
      const manifestEntry = TOOL_MANIFEST.find(
        (candidate) => candidate.name === name
      );

      expect(tool?.inputSchema.properties.dataAccess?.type).toBe("string");
      expect(manifestEntry?.version).toBe(expectedVersion[name]);
    }
  });

  it("keeps the superseded create_artifact@v3 and update@v1 contracts addressable", () => {
    // Callers pinned to the old versions must keep resolving after the bump: the
    // boot sync retires any (identifier, version) no longer in the manifest, so
    // the old contracts stay as frozen snapshots without `dataAccess`.
    for (const [identifier, oldVersion, newVersion] of [
      ["content.create_artifact", "v3", "v4"],
      ["content.update", "v1", "v2"],
    ] as const) {
      const versions = TOOL_MANIFEST.filter((entry) => entry.identifier === identifier);
      expect(versions.map((entry) => entry.version).sort()).toEqual([oldVersion, newVersion].sort());

      const legacy = versions.find((entry) => entry.version === oldVersion);
      expect(legacy?.inputSchema.properties.dataAccess).toBeUndefined();
      expect(legacy?.destructive).toBe(true);
      expect(legacy?.surfaces).toEqual(["mcp", "internal"]);

      const current = versions.find((entry) => entry.version === newVersion);
      expect(current?.name).toBe(legacy?.name);
      expect(current?.inputSchema.properties.dataAccess?.type).toBe("string");
    }
  });

});

// #1750 — the sandbox CSP blocks external scripts/styles SILENTLY: the page
// renders, the charts are empty, and no error reaches the author. The only thing
// standing between a model and that failure is this sentence in the tool
// description, so guard that it is actually there.
describe("Atrium MCP content tools — sandbox CSP authoring rule (#1750)", () => {
  const CSP_MARKER = "SANDBOX CSP:";

  it("carries the CSP rule on every artifact-authoring surface", () => {
    const createArtifact = CONTENT_MCP_TOOLS.find((t) => t.name === "create_artifact");
    expect(createArtifact?.description).toContain(CSP_MARKER);

    const createVersion = CONTENT_MCP_TOOLS.find((t) => t.name === "create_version");
    expect(createVersion?.description).toContain(CSP_MARKER);
  });

  // The rule is ~500 characters and rides in every turn these tools are bound.
  // It belongs on the tool description (which every MCP client surfaces) once —
  // repeating it on the `code` argument doubled the cost for no added reach,
  // since the input schema and the description reach the model together.
  it("states the rule once per tool, not once per argument", () => {
    const createArtifact = CONTENT_MCP_TOOLS.find((t) => t.name === "create_artifact");
    expect(createArtifact?.inputSchema.properties.code?.description).not.toContain(CSP_MARKER);
  });

  it("states the no-network rule, not just the script rule", () => {
    const createArtifact = CONTENT_MCP_TOOLS.find((t) => t.name === "create_artifact");
    expect(createArtifact?.description).toContain("connect-src 'none'");
  });
});

/**
 * #1792 — the MCP tools carried the MODE description but not the API.
 *
 * A model on this surface knew `dataAccess: 'query'` existed and did not know
 * that `rows` come back as TUPLES in `columns` order, so it wrote
 * `rows.map(r => r.school_name)` and shipped a dashboard of blanks. These two
 * tools are the ones that WRITE artifact code, so they are the ones that must
 * carry the contract.
 */
describe("Atrium MCP content tools — AtriumData authoring guidance (#1792)", () => {
  it.each(["create_artifact", "create_version"])(
    "%s carries the full authoring guidance verbatim",
    (name) => {
      const tool = CONTENT_MCP_TOOLS.find((t) => t.name === name);
      expect(tool?.description).toContain(ATRIUM_DATA_AUTHORING_GUIDANCE);
    }
  );

  // The bridge is not relevant to a markdown document, and the guidance is long
  // prompt text — it rides only where artifact code is written.
  it.each(["create_document", "list_content", "get_content"])(
    "%s does not carry it",
    (name) => {
      const tool = CONTENT_MCP_TOOLS.find((t) => t.name === name);
      expect(tool?.description).not.toContain(ATRIUM_DATA_AUTHORING_GUIDANCE);
    }
  );

  // Same rule as the CSP guidance above: once per tool, not once per argument.
  it("states it on the description, not on the code argument", () => {
    const tool = CONTENT_MCP_TOOLS.find((t) => t.name === "create_artifact");
    expect(tool?.inputSchema.properties.code?.description).not.toContain(
      ATRIUM_DATA_AUTHORING_GUIDANCE
    );
  });
});

// #1750 — the sentence itself. Tested with explicit arguments (not the ambient
// env) so both deployment shapes are covered regardless of what CI exports.
describe("buildArtifactCspGuidance (#1750)", () => {
  it("tells the author to inline everything when no CDN is allowlisted", () => {
    const s = buildArtifactCspGuidance([]);
    expect(s).toContain("SANDBOX CSP:");
    expect(s).toContain("connect-src 'none'");
    expect(s).toContain("no external scripts or styles at all");
    expect(s).toContain("inline SVG");
    // Must not name an origin it does not actually permit.
    expect(s).not.toContain("https://");
  });

  it("names the allowlisted origins and demands a pinned version", () => {
    const s = buildArtifactCspGuidance(["https://cdnjs.cloudflare.com"]);
    expect(s).toContain("https://cdnjs.cloudflare.com");
    expect(s).toContain("pin an exact version");
    // The silent-failure warning is the whole point of the issue.
    expect(s).toContain("blocked silently");
  });

  // A model that reads only "external scripts are blocked EXCEPT from <cdn>"
  // can conclude its OWN script must come from that CDN too. Both branches have
  // to say outright that inline script/style is allowed — that is the normal way
  // to build an artifact, and the CDN is the exception.
  it("says inline script and style are allowed in both branches", () => {
    for (const s of [
      buildArtifactCspGuidance([]),
      buildArtifactCspGuidance(["https://cdnjs.cloudflare.com"]),
    ]) {
      expect(s).toContain("INLINE");
      expect(s).toContain("<script> and <style> are allowed");
    }
  });

  it("lists every configured origin", () => {
    const s = buildArtifactCspGuidance([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
    ]);
    expect(s).toContain("https://cdnjs.cloudflare.com");
    expect(s).toContain("https://cdn.jsdelivr.net");
  });
});
