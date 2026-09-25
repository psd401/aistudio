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
 * - `ATRIUM_DATA_AUTHORING_GUIDANCE` is carried by BOTH TypeScript surfaces as of
 *   #1792: the workspace chat's artifact tools AND the artifact-authoring MCP
 *   tools (`create_artifact` / `create_version`). Before that it had a single
 *   consumer, so a model in Claude Code or Claude Desktop knew query mode existed
 *   but not that rows come back as TUPLES — and `rows.map(r => r.school_name)`
 *   rendered a dashboard of blanks.
 * - The numeric limits below are interpolated from
 *   `lib/content/artifact-query-limits.ts`, the same module the query action and
 *   the sandbox bridge enforce them from, so the guidance cannot state a number
 *   the code does not apply.
 * - The `psd-atrium` skill is a hand-maintained Markdown copy
 *   (`infra/agent-image/skills/psd-atrium/SKILL.md`, "Live PSD data inside an
 *   artifact"). It does NOT read these constants, so editing this file does not
 *   update the skill — change both when the bridge contract changes.
 *
 * These are MODEL-FACING prompt/description text, not user-facing copy.
 */

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

/**
 * The bridge's failure codes as the guidance lists them — built from the closed
 * set (#1787) so adding or renaming a code cannot leave the model's list stale.
 */
const BRIDGE_ERROR_CODE_LIST = ARTIFACT_BRIDGE_ERROR_CODES.map((code) =>
  code === "rate_limited" ? "`rate_limited` (with `err.retryAfterSeconds`)" : `\`${code}\``
).join(", ");

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
  "Rules: never embed query results in the source (they go stale and are shown to every viewer at YOUR permission level, visible verbatim in the Code tab) — query at runtime; aggregate in SQL so a chart query returns tens of rows, not a dataset; page detail tables with limit/offset. " +
  "BUDGET: aim for 3-8 aggregate queries per page load. Fire them together (`Promise.all`) — they run in parallel, up to 6 at a time, and anything beyond that queues rather than failing. The hard limit is 60 queries per minute per viewer per artifact; exceeding it rejects with `rate_limited`. So do NOT query in a loop over rows, and do NOT re-query on every filter change if one aggregate could be filtered in JavaScript. " +
  "FAILURES ARE TYPED: wrap EVERY call in try/catch and branch on `err.code`, which is one of " + BRIDGE_ERROR_CODE_LIST + ". Render a no-access/sign-in state ONLY for `forbidden` and `unauthenticated`. For `query_error` the SQL ITSELF is wrong (a bad column or syntax) — show `err.message`, which for someone who can edit the artifact is the database's own message; do NOT dress a broken query up as a permissions problem. Never assume a call succeeded, and never leave a chart silently empty on a rejection. " +
  "There are NO bound parameters: `query` takes the SQL string plus `{ limit, offset }` and nothing else. So do NOT concatenate a user-typed value into the SQL. Either fetch an aggregated/bounded result set once and filter it in JavaScript, or — when a filter really must reach the database — build the SQL from a FIXED set of predicates you wrote, selected by the user's choice (a dropdown of known values), never from free text. " +
  "'query' and 'records' are mutually exclusive — pick the one the artifact needs. Explore the data with a couple of queries at most before you start writing code. " +
  // #1792: every number below is enforced somewhere and was previously stated
  // nowhere the model could read it. The default limit is the dangerous one —
  // it does not fail, it silently answers with the first page.
  "ENFORCED LIMITS (stated because breaking one of them mostly does NOT look like an error): " +
  `\`limit\` DEFAULTS TO ${ARTIFACT_QUERY_DEFAULT_LIMIT} when you omit it and is capped at ${ARTIFACT_QUERY_MAX_LIMIT} — an unaggregated SELECT therefore returns its FIRST ${ARTIFACT_QUERY_DEFAULT_LIMIT} rows and a total computed from them is simply wrong, with no rejection. Aggregate in SQL, and compare \`returnedCount\` to \`totalCount\` (do not rely on \`truncated\` alone) before you render a total. ` +
  `The SQL is capped at ${ARTIFACT_QUERY_MAX_SQL_LENGTH} characters. ` +
  `Rate limit: ${ARTIFACT_QUERY_RATE_LIMIT} queries per minute, per viewer, per artifact — past it calls reject with \`rate_limited\` and \`err.retryAfterSeconds\`, so never query inside a loop over rows and prefer filtering one aggregate result in JavaScript over re-querying on every control change. ` +
  `Concurrency: ${ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS} requests run in parallel and the rest QUEUE (a \`Promise.all\` of several panels is fine and is the right shape); only past ${ARTIFACT_MAX_PENDING_DATA_REQUESTS} outstanding at once does a call reject with \`too_many_requests\`. ` +
  `Each query has ${Math.round(ARTIFACT_QUERY_CLIENT_TIMEOUT_MS / 1000)}s from the moment it is dispatched, then \`timeout\`. ` +
  "SQL RULES from the data server: SELECT only (DDL/DML is rejected); row-level security rewrites your query, so never add your own access filters; and ALWAYS give a NUMERIC/DECIMAL cast a precision — `score::NUMERIC(10,2)`, never a bare `::NUMERIC`, which is rejected and is the leading suspect when a numeric column comes back blank. " +
  // The sandbox attributes, stated as behaviour rather than as an attribute
  // list: each of these is a feature a model adds in good faith and a viewer
  // then finds dead, with nothing in the console.
  "SANDBOX NO-OPS: the frame is `sandbox=\"allow-scripts\"` and nothing else, so `alert`/`confirm`/`prompt`, `window.print()`, file downloads (an `<a download>` or an 'Export CSV'/'Download PDF' button) and opening a new window or tab ALL SILENTLY DO NOTHING — no dialog, no file, no error. Never build a feature on them: render the message in the page, and offer data as an on-page table or a copyable <textarea> rather than a download. " +
  "SCRIPT TIMING: the sandbox runs your <script> tags in document order and waits for each external script to finish before the next tag runs, so inline code may use a library the tag before it loaded; after the last script it fires DOMContentLoaded on document and load on window exactly once, so a DOMContentLoaded bootstrap works.";
