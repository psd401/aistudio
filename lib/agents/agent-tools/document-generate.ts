/**
 * Agent tool: `documents.create` (Issue #926).
 *
 * Generates a downloadable document from text content and returns a URL. Delegates
 * to `lib/ai/document-generation-service` so generation + S3 storage is single-
 * sourced and unit-testable independent of the MCP dispatch layer.
 */

import type { McpToolHandler, McpToolResult } from "@/lib/mcp/types";
import { createLogger } from "@/lib/logger";
import {
  generateDocument,
  isDocumentFormat,
} from "@/lib/ai/document-generation-service";

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

export const handleGenerateDocument: McpToolHandler = async (args, context) => {
  const log = createLogger({
    requestId: context.requestId,
    action: "agent.generate_document",
  });

  const format = args.format;
  if (!isDocumentFormat(format)) {
    return textResult(
      `Missing or invalid "format". Supported: pdf, docx, xlsx, pptx, md, html, txt, csv.`,
      true
    );
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content) {
    return textResult("Missing required field: content", true);
  }

  try {
    const result = await generateDocument({
      format,
      content,
      title: typeof args.title === "string" ? args.title : undefined,
      filename: typeof args.filename === "string" ? args.filename : undefined,
      userId: String(context.userId),
    });

    log.info("Agent document generated", {
      format: result.format,
      bytes: result.bytes,
      s3Key: result.s3Key,
    });

    return textResult(
      JSON.stringify({
        url: result.url,
        filename: result.filename,
        format: result.format,
        note: "The URL is a time-limited link to the generated document.",
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Agent document generation failed", { format, error: message });
    return textResult(`Document generation failed: ${message}`, true);
  }
};
