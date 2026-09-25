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
import { ARTIFACT_BRIDGE_ERROR_CODES } from "@/lib/content/artifact-bridge-errors";
import {
  ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS,
  ARTIFACT_MAX_PENDING_DATA_REQUESTS,
  ARTIFACT_QUERY_CLIENT_TIMEOUT_MS,
  ARTIFACT_QUERY_DEFAULT_LIMIT,
  ARTIFACT_QUERY_MAX_LIMIT,
  ARTIFACT_QUERY_MAX_SQL_LENGTH,
  ARTIFACT_QUERY_RATE_LIMIT,
} from "@/lib/content/artifact-query-limits";

const root = process.cwd();
const mcpSource = fs.readFileSync(path.join(root, "lib/mcp/content-tools.ts"), "utf8");
const workspaceSource = fs.readFileSync(
  path.join(root, "lib/nexus/workspace-chat-tools.ts"),
  "utf8",
);
const skillSource = fs.readFileSync(
  path.join(root, "infra/agent-image/skills/psd-atrium/SKILL.md"),
  "utf8",
);
const renderHtmlSource = fs.readFileSync(
  path.join(root, "infra/sandbox-host/render.html"),
  "utf8",
);
const queryActionSource = fs.readFileSync(
  path.join(root, "actions/db/atrium/artifact-query.ts"),
  "utf8",
);
const sandboxSource = fs.readFileSync(
  path.join(root, "components/atrium/ArtifactSandbox.tsx"),
  "utf8",
);

/**
 * Read a `var NAME = <number>;` literal out of the bundler-less sandbox host.
 *
 * The patterns are literals rather than a name interpolated into `new RegExp`:
 * the constructor form trips `security/detect-non-literal-regexp`, and there is
 * no reason to build a pattern dynamically for a fixed pair of names.
 */
function renderHtmlNumber(pattern: RegExp): number {
  const match = renderHtmlSource.match(pattern);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

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

  /**
   * #1792: every limit the bridge ENFORCES must be stated where the model can
   * read it, with the value interpolated from the module that enforces it.
   *
   * The default limit is the one that motivated this: omitting `limit` does not
   * mean "all rows", it means 200 — and the query does not fail, it answers with
   * a first page that a model then totals in JavaScript and reports as fact.
   */
  it("states every enforced limit, with values taken from the enforcing module", () => {
    const g = ATRIUM_DATA_AUTHORING_GUIDANCE;
    expect(g).toContain(`DEFAULTS TO ${ARTIFACT_QUERY_DEFAULT_LIMIT}`);
    expect(g).toContain(`capped at ${ARTIFACT_QUERY_MAX_LIMIT}`);
    expect(g).toContain(`${ARTIFACT_QUERY_MAX_SQL_LENGTH} characters`);
    expect(g).toContain(`${ARTIFACT_QUERY_RATE_LIMIT} queries per minute`);
    expect(g).toContain(`up to ${ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS} at a time`);
    expect(g).toContain(`${ARTIFACT_MAX_PENDING_DATA_REQUESTS} outstanding`);
    expect(g).toContain(
      `${Math.round(ARTIFACT_QUERY_CLIENT_TIMEOUT_MS / 1000)}s from the moment it is dispatched`,
    );
    // `truncated` alone cannot tell a row-limited result from a byte-trimmed
    // one, so the guidance must point at the counts instead.
    expect(g).toContain("`returnedCount`");
    expect(g).toContain("`totalCount`");
  });

  /**
   * The limits module is only a single source if the enforcers actually read
   * it. A re-introduced literal would leave the guidance stating a number
   * nothing applies — worse than saying nothing, because it reads as
   * authoritative.
   */
  it("is enforced from the shared limits module, not from re-declared literals", () => {
    for (const source of [queryActionSource, sandboxSource]) {
      expect(source).toContain("@/lib/content/artifact-query-limits");
    }
    expect(queryActionSource).toContain("ARTIFACT_QUERY_DEFAULT_LIMIT");
    expect(queryActionSource).toContain("ARTIFACT_QUERY_RATE_LIMIT");
    expect(sandboxSource).toContain("ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS");
  });

  /**
   * The sandbox host is a static asset with no bundler, so it cannot import the
   * limits. Pin its literals instead — the guidance quotes these two numbers as
   * the frame's behaviour, and the frame is what enforces them.
   */
  it("pins the bundler-less sandbox host to the same numbers", () => {
    expect(renderHtmlNumber(/var QUERY_REQUEST_TIMEOUT_MS = (\d+);/)).toBe(
      ARTIFACT_QUERY_CLIENT_TIMEOUT_MS,
    );
    expect(renderHtmlNumber(/var MAX_PENDING_DATA_REQUESTS = (\d+);/)).toBe(
      ARTIFACT_MAX_PENDING_DATA_REQUESTS,
    );
  });

  /**
   * Behaviour the `allow-scripts`-only sandbox swallows (#1792). Each of these
   * is a feature a model adds in good faith and a viewer then finds dead, with
   * nothing in the console to explain it.
   */
  it("names the sandbox no-ops a model would otherwise build on", () => {
    const g = ATRIUM_DATA_AUTHORING_GUIDANCE;
    for (const fragment of ["alert", "window.print()", "download", "new window"]) {
      expect(g).toContain(fragment);
    }
  });

  /**
   * The `psd-atrium` skill is Markdown baked into a separately-built agent
   * image, so it cannot import any of this. It is the surface most likely to
   * drift, and drift here is silent: the agent confidently writes code against
   * a contract that moved. Assert the load-bearing FACTS, not the prose.
   */
  it("keeps the psd-atrium skill's copy of the contract in step", () => {
    const heading = "### Live PSD data inside an artifact";
    expect(skillSource).toContain(heading);
    const section = skillSource.slice(skillSource.indexOf(heading));

    // The API shape.
    expect(section).toContain("AtriumData.query(");
    expect(section).toContain("tuples in `columns` order");
    // The limits, by value.
    expect(section).toContain(`DEFAULTS to ${ARTIFACT_QUERY_DEFAULT_LIMIT}`);
    expect(section).toContain(`capped at ${ARTIFACT_QUERY_MAX_LIMIT}`);
    expect(section).toContain(`${ARTIFACT_QUERY_MAX_SQL_LENGTH} characters`);
    expect(section).toContain(
      `**${ARTIFACT_QUERY_RATE_LIMIT} queries per minute, per viewer, per artifact**`,
    );
    expect(section).toContain(
      `**${ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS} at a time**`,
    );
    expect(section).toContain(
      `**${ARTIFACT_MAX_PENDING_DATA_REQUESTS} outstanding requests**`,
    );
    expect(section).toContain(
      `**${Math.round(ARTIFACT_QUERY_CLIENT_TIMEOUT_MS / 1000)} s**`,
    );
    // The rules a wrong answer looks correct without.
    expect(section).toMatch(/Never embed query results/i);
    expect(section).toMatch(/no bound parameters/i);
    expect(section).toContain("returnedCount");
  });

  /**
   * #1787: the bridge's failure codes have one source, but two surfaces cannot
   * import it — the sandbox host (a static asset with no bundler) and the agent
   * skill (Markdown). Pin both to the closed set so an added or renamed code
   * fails here instead of silently degrading to `unavailable` in the frame or
   * going undocumented for the agent.
   */
  it("lists exactly the closed failure-code set in every copy", () => {
    for (const code of ARTIFACT_BRIDGE_ERROR_CODES) {
      expect(ATRIUM_DATA_AUTHORING_GUIDANCE).toContain(`\`${code}\``);
    }

    const renderHtml = fs.readFileSync(path.join(root, "infra/sandbox-host/render.html"), "utf8");
    const hostList = renderHtml.match(/var BRIDGE_ERROR_CODES = \[([\s\S]*?)\];/);
    expect(hostList).not.toBeNull();
    const hostCodes = [...(hostList?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect([...hostCodes].sort()).toEqual([...ARTIFACT_BRIDGE_ERROR_CODES].sort());

    const skill = fs.readFileSync(
      path.join(root, "infra/agent-image/skills/psd-atrium/SKILL.md"),
      "utf8",
    );
    const skillCodes = [...skill.matchAll(/^\s*\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect([...skillCodes].sort()).toEqual([...ARTIFACT_BRIDGE_ERROR_CODES].sort());
  });
});
