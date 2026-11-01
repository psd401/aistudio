/**
 * Browser-safe contract for the Nexus `generate_document` tool (Issue #1898).
 *
 * The wire name and the arg/result shapes live here, apart from the tool
 * implementation, because the download card is a client component. Importing
 * them from `document-create-tool.ts` would drag the AWS S3 client, the winston
 * logger and the four format libraries into the browser bundle.
 *
 * This module must NOT import server-only code (DB, `node:*`, AWS SDK), exactly
 * like `lib/tools/catalog/ai-sdk-tools.ts`.
 */

/** Wire name — shared with the agent-platform binding of the same catalog tool. */
export const DOCUMENT_CREATE_TOOL_NAME = "generate_document";

/** Route prefix the download card accepts as an href (see `safeDownloadHref`). */
export const NEXUS_DOCUMENT_DOWNLOAD_PREFIX = "/api/nexus/documents/";

export interface DocumentCreateToolArgs {
  format: string;
  content: string;
  title?: string;
  filename?: string;
}

export interface DocumentCreateToolResult {
  ok: boolean;
  /** Final filename including extension, e.g. `staff-newsletter.docx`. */
  filename?: string;
  format?: string;
  bytes?: number;
  /** App-relative authenticated download path the UI card links to. */
  downloadUrl?: string;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}
