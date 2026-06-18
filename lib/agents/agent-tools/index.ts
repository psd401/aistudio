/**
 * Agent platform tools (Issue #926) — handler registry.
 *
 * The in-process handlers for the `internal`-surface agent tools (image
 * generation, web fetch, document generation). Keyed by the same wire `name`
 * used in `descriptors.ts`, so the unified catalog's lazy `dispatch()` resolves
 * them exactly like the MCP tool handlers (`lib/mcp/tool-handlers.ts` spreads
 * this map into its `TOOL_HANDLERS`).
 *
 * This module pulls Node-only graphs (S3, AI SDK, format libraries) and is loaded
 * ONLY at dispatch time — never by the Edge-compiled boot-sync/manifest graph.
 */

import type { McpToolHandler } from "@/lib/mcp/types";
import { handleGenerateImage } from "./image-generate";
import { handleWebFetch } from "./web-fetch";
import { handleGenerateDocument } from "./document-generate";

export const AGENT_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  generate_image: handleGenerateImage,
  web_fetch: handleWebFetch,
  generate_document: handleGenerateDocument,
};

export { AGENT_TOOL_DESCRIPTORS } from "./descriptors";
