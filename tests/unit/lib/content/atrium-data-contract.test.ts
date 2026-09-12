/**
 * The AtriumData bridge contract has ONE source (#1749).
 *
 * Three surfaces let a model author artifact code — the MCP content tools, the
 * PSD Agent's `psd-atrium` skill, and the Nexus workspace chat. Before #1749 the
 * workspace chat carried none of it, which is why the same "build a live
 * dashboard" request worked through the MCP tools and failed in chat. These tests
 * guard against the strings being copied back into a surface and drifting.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ATRIUM_DATA_AUTHORING_GUIDANCE,
  DATA_ACCESS_DESC,
} from "@/lib/content/atrium-data-contract";

const root = process.cwd();
const mcpSource = fs.readFileSync(path.join(root, "lib/mcp/content-tools.ts"), "utf8");
const workspaceSource = fs.readFileSync(
  path.join(root, "lib/nexus/workspace-chat-tools.ts"),
  "utf8",
);

describe("Atrium data-bridge contract", () => {
  it("names all three modes and the mutual-exclusivity rule", () => {
    for (const mode of ["records", "query", "none"]) {
      expect(DATA_ACCESS_DESC).toContain(`'${mode}'`);
    }
    expect(DATA_ACCESS_DESC).toMatch(/mutually exclusive/i);
  });

  it("documents the three operations and the query() return shape", () => {
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain("AtriumData.query(sql");
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain("AtriumData.submit(");
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain("AtriumData.list(");
    // Rows are tuples in `columns` order — the single detail a model most often
    // gets wrong when it has only seen the operation name.
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain("columns");
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain("TUPLE");
    expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toMatch(/never embed query results/i);
  });

  it("is IMPORTED by both authoring surfaces, not redefined in either", () => {
    for (const source of [mcpSource, workspaceSource]) {
      expect(source).toContain("@/lib/content/atrium-data-contract");
      // A local re-declaration is exactly the drift this module exists to stop.
      expect(source).not.toMatch(/const\s+DATA_ACCESS_DESC\s*=/);
      expect(source).not.toMatch(/const\s+ATRIUM_DATA_AUTHORING_GUIDANCE\s*=/);
    }
  });
});
