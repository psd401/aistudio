/**
 * Agent platform tool descriptors (Issue #926).
 *
 * Pure, dependency-free metadata for the in-process tools the agentic Assistant
 * Architect runtime can call: image generation, bounded web fetch, and document
 * generation. These satisfy acceptance criterion #4 ("Image generation, document
 * generation, web fetch ... callable from agentic assistants").
 *
 * ## Why this module is import-light
 *
 * The catalog manifest (`lib/tools/catalog/manifest.ts`) imports these descriptors
 * to project them into `internal`-surface catalog entries. The manifest is part of
 * the boot-time sync graph, which Next.js also compiles for the Edge runtime — so,
 * exactly like the MCP manifest entries, this file MUST stay pure metadata. The
 * concrete handlers (which pull S3 / AI SDK / Node-only graphs) live in sibling
 * modules and are resolved lazily at dispatch time via `TOOL_HANDLERS`.
 *
 * ## Surface + scope
 *
 * These tools are exposed ONLY on the `internal` surface (not `mcp`), so they are
 * agent-platform capabilities — not advertised to external MCP clients. Each
 * requires `chat:write`, mirroring the existing provider-native `chat.generate_image`
 * / `chat.web_search` tools (so a caller who can use those chat tools can also use
 * the agent equivalents; staff and students already hold `chat:write`).
 */

import type { McpToolDefinition } from "@/lib/mcp/types";

/** Pure descriptor for an internal agent tool (no handler reference). */
export interface AgentToolDescriptor {
  /** Stable catalog `domain.action` identifier. */
  identifier: string;
  /** Wire name — the key under which the handler is registered in TOOL_HANDLERS. */
  name: string;
  /** Model/human-facing description. */
  description: string;
  /** JSON Schema for the tool input (MCP `inputSchema` shape). */
  inputSchema: McpToolDefinition["inputSchema"];
  /** Scope(s) the caller must hold (intersected with the author allow-list). */
  requiredScopes: string[];
}

/** Document formats the `documents.create` tool can produce. */
export const DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "md",
  "html",
  "txt",
  "csv",
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Image sizes accepted by the `images.generate` tool. */
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export const AGENT_TOOL_DESCRIPTORS: AgentToolDescriptor[] = [
  {
    identifier: "images.generate",
    name: "generate_image",
    description:
      "Generate an image from a text prompt using the platform's configured " +
      "image model. Returns a URL to the generated image (stored securely). Use " +
      "for diagrams, illustrations, or visual assets requested by the user.",
    requiredScopes: ["chat:write"],
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate.",
        },
        size: {
          type: "string",
          description: "Output dimensions. Defaults to 1024x1024 (square).",
          enum: [...IMAGE_SIZES],
        },
      },
      required: ["prompt"],
    },
  },
  {
    identifier: "web.fetch",
    name: "web_fetch",
    description:
      "Fetch a single public web page over HTTPS and return its readable text " +
      "content (scripts, styles, and markup stripped). Use to read documentation, " +
      "articles, or reference pages the user links to. Private/internal hosts are " +
      "blocked.",
    requiredScopes: ["chat:write"],
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to fetch.",
        },
        maxChars: {
          type: "number",
          description:
            "Optional cap on returned characters (default 20000, max 100000).",
        },
      },
      required: ["url"],
    },
  },
  {
    identifier: "documents.create",
    name: "generate_document",
    description:
      "Generate a downloadable document from text content and return a URL. " +
      "Supported formats: pdf, docx (Word), xlsx (Excel — content is CSV rows), " +
      "pptx (PowerPoint — slides separated by a line containing only '---'), and " +
      "md/html/txt/csv. Use to deliver reports, spreadsheets, or slide decks.",
    requiredScopes: ["chat:write"],
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Document format to produce.",
          enum: [...DOCUMENT_FORMATS],
        },
        title: {
          type: "string",
          description: "Optional document title / heading.",
        },
        content: {
          type: "string",
          description:
            "Document body. For xlsx/csv use CSV rows; for pptx separate slides " +
            "with a line containing only '---'.",
        },
        filename: {
          type: "string",
          description: "Optional base filename (without extension).",
        },
      },
      required: ["format", "content"],
    },
  },
];
