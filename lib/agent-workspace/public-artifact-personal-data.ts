/**
 * The contents check that stands between an agent-made file and an unsigned,
 * anyone-with-the-link URL. Issue #1886.
 *
 * Before this existed, `publish` checked size and extension and never the
 * bytes, so seating charts with grades, per-student test-score tables, roster
 * CSVs and substitute contact lists were all minted public links by a broker
 * that had no idea what was in them.
 *
 * The detection rules are in `lib/safety/personal-data-scan.ts`; this module is
 * only the bytes-to-text half — which types can be read at all, how much of
 * them to read, and what to do when a file cannot be parsed.
 */

import type { PdfExtractionResult } from "@/lib/repositories/content-platform/pdf-processing";
import {
  detectPersonalDataKinds,
  textExtractionFor,
  type PersonalDataKind,
} from "@/lib/safety/personal-data-scan";

/**
 * How many bytes of an upload are read for the scan.
 *
 * Generous enough that no real district document is affected — the public
 * limit is 100 MB mostly for video — and small enough that one upload cannot
 * pull a hundred megabytes into the web container.
 */
export const MAX_PERSONAL_DATA_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Why an upload went to a public link without its contents being read. Carried
 * into the log so "nothing was found" and "nothing was looked at" are never
 * the same line.
 */
export type UnscannedReason =
  /** A raster image, audio or video file: out of scope for #1886 by design. */
  | "not-text-extractable"
  /**
   * Larger than the scan budget. A PDF is not read at all (a truncated PDF
   * does not parse); a text file has only its first
   * `MAX_PERSONAL_DATA_SCAN_BYTES` read, and a match there is still refused.
   */
  | "over-scan-budget"
  /** A PDF that the parser could not read (encrypted, truncated, malformed). */
  | "unreadable"
  /**
   * A PDF with at least one page carrying no text layer — a scanned or
   * photographed page. Its text pages were read and found nothing, but the
   * image pages could not be, and a scanned seating chart is exactly the case
   * #1886 opened with.
   */
  | "needs-ocr";

export type PublicArtifactScanResult =
  | { refused: true; kinds: PersonalDataKind[] }
  | { refused: false; scanned: true }
  | {
      refused: false;
      scanned: false;
      reason: UnscannedReason;
      /** For `unreadable`: the parser's own error, never the file's text. */
      parserError?: string;
    };

/** The slice of the PDF parser's result this check reads. */
export type PdfTextReader = (
  bytes: Uint8Array
) => Promise<Pick<PdfExtractionResult, "pages" | "needsOcrPages">>;

async function defaultPdfTextReader(
  bytes: Uint8Array
): Promise<PdfExtractionResult> {
  // Deferred so the scan module — and every unit test that only exercises the
  // utf8 path — does not pull the PDF parser in.
  const { extractPdfText } = await import(
    "@/lib/repositories/content-platform/pdf-processing"
  );
  return extractPdfText(bytes);
}

/**
 * Read a staged public upload as text and say whether it may be published.
 *
 * `readBytes` is passed the cap rather than the object being handed over whole,
 * so the caller can range-read instead of downloading a file it will truncate.
 *
 * A file the check could not fully read is ALLOWED, not refused — a PDF the
 * parser rejects, a scanned page with no text layer, the tail of a text file
 * past the budget. The risk the issue names is false positives blocking
 * legitimate public flyers, and "could not read it" is not evidence of
 * personal data. But each of those comes back `scanned: false` with its
 * reason, never as a clean scan, so the caller's log can tell them apart.
 */
export async function scanPublicArtifactForPersonalData(input: {
  fileName: string;
  contentType: string;
  byteLength: number;
  readBytes: (maxBytes: number) => Promise<Uint8Array>;
  readPdfText?: PdfTextReader;
}): Promise<PublicArtifactScanResult> {
  const extraction = textExtractionFor(input.fileName, input.contentType);
  if (!extraction) {
    return { refused: false, scanned: false, reason: "not-text-extractable" };
  }
  const overBudget = input.byteLength > MAX_PERSONAL_DATA_SCAN_BYTES;
  if (extraction === "pdf" && overBudget) {
    // A truncated PDF does not parse, so unlike the utf8 path there is no
    // partial scan to fall back to.
    return { refused: false, scanned: false, reason: "over-scan-budget" };
  }

  const bytes = await input.readBytes(MAX_PERSONAL_DATA_SCAN_BYTES);
  let text: string;
  let imagePages = false;
  if (extraction === "utf8") {
    // Non-fatal: a mis-declared or truncated-mid-codepoint file still yields
    // text to scan rather than throwing the gate open.
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } else {
    try {
      const extracted = await (input.readPdfText ?? defaultPdfTextReader)(
        bytes
      );
      text = extracted.pages.map((page) => page.text).join("\n");
      imagePages = extracted.needsOcrPages.length > 0;
    } catch (error) {
      return {
        refused: false,
        scanned: false,
        reason: "unreadable",
        // So a bug in our own extraction does not hide among encrypted PDFs.
        parserError: (error instanceof Error ? error.message : String(error))
          .slice(0, 200),
      };
    }
  }

  // What WAS read is still checked: a match in the readable part refuses the
  // file however much of it could not be read.
  const kinds = detectPersonalDataKinds(text);
  if (kinds.length > 0) return { refused: true, kinds };
  if (overBudget) {
    return { refused: false, scanned: false, reason: "over-scan-budget" };
  }
  if (imagePages) {
    return { refused: false, scanned: false, reason: "needs-ocr" };
  }
  return { refused: false, scanned: true };
}
