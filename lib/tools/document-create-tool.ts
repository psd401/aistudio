/**
 * `generate_document` — the Nexus chat tool that hands back a real file (#1898).
 *
 * Nexus could not produce a downloadable document: asked for a Word file, a
 * spreadsheet, a deck or a PDF, it returned text to copy and paste, losing all
 * formatting (in a read of 375 staff, ~55 people hit this and one teacher pasted
 * the same flyer eight times). The generator already existed — `generateDocument()`
 * in `lib/ai/document-generation-service.ts`, reached only by the agent-platform
 * `documents.create` tool on the `internal` surface. This module is the chat
 * surface's binding to that SAME generator: no second implementation.
 *
 * Two things differ from the agent binding, both deliberate:
 *
 *  1. The document is stored under the conversation and delivered by
 *     `/api/nexus/documents/...`, which re-checks on every download that the
 *     caller owns the conversation. The agent binding's presigned S3 URL cannot
 *     be re-authorized, expires in an hour (so the card dies on reload), and is
 *     a bearer credential we would be writing into the model's context.
 *  2. `userId` and `conversationId` come from the authenticated request, never
 *     from the model, so the model cannot write into another conversation's
 *     prefix or attribute a document to another user.
 */

import type { Tool } from "ai";
import { jsonSchema } from "ai";
import { createLogger } from "@/lib/logger";
import {
  generateDocument,
  isDocumentFormat,
} from "@/lib/ai/document-generation-service";
import { DOCUMENT_FORMATS } from "@/lib/agents/agent-tools/descriptors";
import { intersectSkillAllowedTools } from "@/lib/skills/skill-tool-enforcement";
import {
  DOCUMENT_CREATE_TOOL_NAME,
  type DocumentCreateToolArgs,
  type DocumentCreateToolResult,
} from "@/lib/tools/document-create-contract";

export {
  DOCUMENT_CREATE_TOOL_NAME,
  type DocumentCreateToolArgs,
  type DocumentCreateToolResult,
};


const DOCUMENT_CREATE_DESCRIPTION = `Create a real, downloadable file for the user and attach it to this conversation.

Use this whenever the user asks for a Word document, a spreadsheet, a slide deck, a PDF, or "a file I can download". Do NOT answer by pasting the document's text into the chat and asking the user to copy it — that loses all formatting. Call this tool instead, then say in one short sentence what you created.

Formats:
- docx — a Word document. Write \`content\` as MARKDOWN: \`#\`/\`##\` headings, \`**bold**\`, \`*italic*\`, \`-\` bullet lists, \`1.\` numbered lists, and pipe tables all become real Word formatting.
- pptx — a PowerPoint deck. Write \`content\` as MARKDOWN: each \`##\` heading starts a new slide and becomes its title, and the lines under it become that slide's bullets. A line containing only \`---\` also starts a new slide.
- xlsx, csv — a spreadsheet. Write \`content\` as CSV rows, one row per line, first row the header.
- pdf — a PDF. Write \`content\` as plain text; markdown is not formatted in PDF output.
- md, html, txt — the text as-is.

Set \`title\` to the document's title and \`filename\` to a short base name without an extension. The user gets a download card in the chat; you do not need to repeat the link, and the link only works for this user in this conversation.`;

/**
 * Hand-written JSON Schema (as `web_fetch` does) so the wire schema the AI SDK
 * ships to every provider is exactly what is written here, rather than whatever
 * a Zod-to-JSON-Schema pass produces per provider.
 */
const DOCUMENT_CREATE_SCHEMA = jsonSchema<DocumentCreateToolArgs>({
  type: "object",
  properties: {
    format: {
      type: "string",
      description:
        "File format to produce. Use docx for a Word document, pptx for a slide deck, xlsx for a spreadsheet, pdf for a PDF.",
      enum: [...DOCUMENT_FORMATS],
    },
    content: {
      type: "string",
      description:
        "The document body. Markdown for docx and pptx; CSV rows for xlsx and csv; plain text for pdf, md, html and txt.",
    },
    title: {
      type: "string",
      description: "Document title, used as the heading and the default filename.",
    },
    filename: {
      type: "string",
      description: "Optional base filename, without an extension.",
    },
  },
  required: ["format", "content"],
});

export interface CreateDocumentToolInput {
  /** Authenticated user's numeric id — never model-supplied. */
  userId: number;
  /** Conversation the document is scoped to — never model-supplied. */
  conversationId: string;
}

/**
 * Build the Nexus `generate_document` tool.
 *
 * Always on rather than a toggle, matching `web_fetch`: a user who asks for a
 * Word document has no way to know they were meant to flip a switch first, and
 * every role that can reach the chat route already holds `chat:write`
 * (`ROLE_SCOPES` in `lib/api-keys/scopes.ts` grants it to student, staff and
 * administrator alike), so no scope check here could change the outcome for any
 * caller. A bound skill's `allowed-tools` pin can still exclude it — see
 * {@link skillPinAllowsDocumentCreate}.
 */
export function createDocumentCreateTool(
  input: CreateDocumentToolInput
): Tool<DocumentCreateToolArgs, DocumentCreateToolResult> {
  const log = createLogger({ module: "nexus-document-create-tool" });
  return {
    description: DOCUMENT_CREATE_DESCRIPTION,
    inputSchema: DOCUMENT_CREATE_SCHEMA,
    execute: async (
      args: DocumentCreateToolArgs
    ): Promise<DocumentCreateToolResult> => {
      const format = args?.format;
      if (!isDocumentFormat(format)) {
        return {
          ok: false,
          error: `Unsupported format "${String(format)}". Use one of: ${DOCUMENT_FORMATS.join(", ")}.`,
        };
      }
      const content = typeof args?.content === "string" ? args.content : "";
      if (content.trim() === "") {
        return { ok: false, error: "The document body was empty." };
      }

      try {
        const result = await generateDocument({
          format,
          content,
          title: typeof args.title === "string" ? args.title : undefined,
          filename: typeof args.filename === "string" ? args.filename : undefined,
          userId: String(input.userId),
          conversationId: input.conversationId,
        });
        log.info("Nexus document generated", {
          conversationId: input.conversationId,
          format: result.format,
          bytes: result.bytes,
        });
        return {
          ok: true,
          filename: result.filename,
          format: result.format,
          bytes: result.bytes,
          // Always set for a conversation-scoped request; the fallback keeps the
          // result shape honest rather than asserting non-null.
          ...(result.downloadPath ? { downloadUrl: result.downloadPath } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Nexus document generation failed", {
          conversationId: input.conversationId,
          format,
          error: message,
        });
        // Returned rather than thrown so the turn continues and the model can
        // tell the user what went wrong, as `web_fetch` does for a failed fetch.
        return { ok: false, error: `The file could not be created: ${message}` };
      }
    },
  };
}

/**
 * Whether a bound skill's `allowed-tools` pin permits `generate_document`. An
 * empty pin (no skill, or a skill that pins nothing) allows it. A pin may name
 * the tool by wire name, friendly name or catalog identifier.
 */
export function skillPinAllowsDocumentCreate(skillAllowedTools: string[]): boolean {
  return (
    intersectSkillAllowedTools(
      [DOCUMENT_CREATE_TOOL_NAME, "generateDocument", "documents.create"],
      skillAllowedTools
    ).length > 0
  );
}
