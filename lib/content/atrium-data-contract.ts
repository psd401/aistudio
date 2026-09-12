/**
 * The Atrium artifact sandbox data bridge (`window.AtriumData`) as described to
 * the models that author artifact code (#1749).
 *
 * Three surfaces let a model author an artifact: the MCP content tools
 * (`lib/mcp/content-tools.ts`), the PSD Agent's `psd-atrium` skill, and the Nexus
 * workspace chat (`lib/nexus/workspace-chat-tools.ts`). Before #1749 the workspace
 * chat said nothing about the bridge, which is why the same "build me a live
 * dashboard" request worked through the MCP tools and failed in the workspace chat:
 * the model was never told `window.AtriumData` existed, invented a helper, saw it
 * fail, and baked a stale snapshot of the data into the source — the exact
 * anti-pattern the mode exists to prevent.
 *
 * What this module does and does NOT guarantee:
 * - `DATA_ACCESS_DESC` is imported by both TypeScript surfaces (MCP content tools
 *   and workspace chat), so those two cannot drift apart.
 * - `ATRIUM_DATA_AUTHORING_GUIDANCE` currently has ONE consumer — the workspace
 *   chat. The MCP tools do not carry it today; add the import here if they should.
 * - The `psd-atrium` skill is a hand-maintained Markdown copy
 *   (`infra/agent-image/skills/psd-atrium/SKILL.md`, "Live PSD data inside an
 *   artifact"). It does NOT read these constants, so editing this file does not
 *   update the skill — change both when the bridge contract changes.
 *
 * These are MODEL-FACING prompt/description text, not user-facing copy.
 */

/**
 * What the three `dataAccess` modes mean. Attached to every tool input that can
 * read or set the mode.
 */
export const DATA_ACCESS_DESC =
  "Artifact sandbox data bridge mode. 'records' (default) allows AtriumData.submit/list, the per-artifact record store. 'query' allows AtriumData.query — read-only PSD data queries run as the PERSON VIEWING the page, under their own row-level permissions — and is what a live dashboard needs. 'none' disables the bridge. The modes are MUTUALLY EXCLUSIVE for security: an artifact that can query district data must never also be able to write records its author can read back. Never embed query results in the artifact source; aggregate in SQL and call AtriumData.query at runtime. Changing the mode takes effect for a reader only on their NEXT page load — an already-open reader keeps the mode it loaded with.";

/**
 * HOW to write artifact code against the bridge — the API shapes and the
 * authoring rules. Appended to the artifact-authoring tool descriptions (the text
 * a model actually reads when deciding how to write the code) and mirrored by the
 * `psd-atrium` skill's "Live PSD data inside an artifact" section.
 */
export const ATRIUM_DATA_AUTHORING_GUIDANCE =
  "DATA BRIDGE: the artifact runs in a sandbox that installs `window.AtriumData` before your code runs — it is the ONLY way an artifact can reach data (fetch/XMLHttpRequest, localStorage and sessionStorage are all blocked by the sandbox CSP and opaque origin, so never propose them). Three operations, gated by the artifact's dataAccess mode: " +
  "(1) `await AtriumData.query(sql, { limit, offset })` — requires mode 'query'; resolves to { columns: string[], rows: unknown[][], totalCount, returnedCount, limit, offset, truncated }, where each row is a TUPLE in `columns` order. The SQL is read-only and runs as the PERSON VIEWING the page, under their row-level permissions. " +
  "(2) `await AtriumData.submit(namespace, payload)` and (3) `await AtriumData.list(namespace, { limit, scope })` — require mode 'records' (the per-artifact record store). " +
  "Rules: never embed query results in the source (they go stale and are shown to every viewer at YOUR permission level, visible verbatim in the Code tab) — query at runtime; aggregate in SQL so a chart query returns tens of rows, not a dataset; page detail tables with limit/offset; pass user filters as SQL parameters and re-query rather than fetching everything and filtering in JavaScript; wrap EVERY call in try/catch and render a clear failure state (a rejection means no session, an expired token, no access to the table, the wrong mode, or a rate limit). " +
  "'query' and 'records' are mutually exclusive — pick the one the artifact needs. Explore the data with a couple of queries at most before you start writing code.";
