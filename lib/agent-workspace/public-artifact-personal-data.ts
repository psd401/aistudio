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
 * The largest text-extractable file that may go to a public link: the check
 * reads it in full, so this is also how much one upload can pull into the web
 * container. The public limit is 100 MB mostly for video; a CSV, text file or
 * PDF past this is refused at publish time rather than published partly read
 * (#1886 review: an agent choosing to pad a roster past the read window would
 * otherwise get it through).
 */
export const MAX_PERSONAL_DATA_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Refuse, before any bytes are uploaded, a public upload this check could not
 * read in full. Only text-extractable types are bounded; images, audio and
 * video keep the broker's ordinary public limit.
 *
 * The message starts with "Invalid" so the route returns it to the agent as a
 * 400 with the guidance intact.
 */
export function assertPublicArtifactScannable(
  fileName: string,
  contentType: string,
  byteLength: number
): void {
  if (!textExtractionFor(fileName, contentType)) return;
  if (byteLength <= MAX_PERSONAL_DATA_SCAN_BYTES) return;
  throw new Error(
    `Invalid public artifact size: a file of this type over ` +
      `${MAX_PERSONAL_DATA_SCAN_BYTES / (1024 * 1024)} MiB is too large to ` +
      "check for personal data, so it cannot get a public link. Deliver it " +
      "privately instead (run psd-publish-file without --to public, or with " +
      "--to drive), or split it into smaller files."
  );
}

/**
 * Why an upload went to a public link without its contents being read. Carried
 * into the log so "nothing was found" and "nothing was looked at" are never
 * the same line.
 */
export type UnscannedReason =
  /** A raster image, audio or video file: out of scope for #1886 by design. */
  | "not-text-extractable"
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
      /**
       * For `unreadable`: the parser's error CLASS (e.g. `PasswordException`).
       * Never its message — pdf.js messages can quote tokens from the file.
       */
      parserError?: string;
    };

/** The slice of the PDF parser's result this check reads. */
export type PdfTextReader = (
  bytes: Uint8Array
) => Promise<Pick<PdfExtractionResult, "pages" | "needsOcrPages">>;

/**
 * Decode a text upload for scanning. UTF-8 unless the bytes say otherwise:
 * spreadsheet exports are often UTF-16, and read as UTF-8 every ASCII
 * character comes out separated by a NUL — `2\u00002\u00004...` — so no
 * pattern matches and the file would pass as clean.
 *
 * A byte-order mark decides it when present. Without one, a run of NUL bytes
 * is the tell (real UTF-8 text does not contain them), and which side of each
 * character pair the NULs sit on gives the byte order. Big-endian is decoded
 * by swapping each pair to little-endian, which every runtime supports.
 */
export function decodeTextForScan(bytes: Uint8Array): string {
  const utf16 = utf16ByteOrder(bytes);
  if (!utf16) {
    // Non-fatal: a mis-declared or truncated-mid-codepoint file still yields
    // text to scan rather than throwing the gate open.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  const body = utf16.bom ? bytes.subarray(2) : bytes;
  const littleEndian =
    utf16.order === "le" ? body : swapBytePairs(body);
  return new TextDecoder("utf-16le", { fatal: false }).decode(littleEndian);
}

function utf16ByteOrder(
  bytes: Uint8Array
): { order: "le" | "be"; bom: boolean } | null {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { order: "le", bom: true };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { order: "be", bom: true };
  const sample = bytes.subarray(0, 4096);
  let evenNuls = 0;
  let oddNuls = 0;
  for (const [index, element] of sample.entries()) {
    if (element !== 0) continue;
    if (index % 2 === 0) evenNuls++;
    else oddNuls++;
  }
  // A quarter of the bytes being NUL, nearly all on one side, is UTF-16 text
  // that is mostly ASCII — the rosters and CSVs this check is for.
  const pairs = Math.floor(sample.length / 2);
  if (pairs === 0) return null;
  if (oddNuls >= pairs / 2 && evenNuls < oddNuls / 8) {
    return { order: "le", bom: false };
  }
  if (evenNuls >= pairs / 2 && oddNuls < evenNuls / 8) {
    return { order: "be", bom: false };
  }
  return null;
}

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped;
}

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
 * parser rejects, or a scanned page with no text layer. (A file too LARGE to
 * read in full never gets here: see `assertPublicArtifactScannable`.) The risk the issue names is false positives blocking
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
  if (input.byteLength > MAX_PERSONAL_DATA_SCAN_BYTES) {
    // assertPublicArtifactScannable refuses this at publish time, so reaching
    // here means that check was bypassed. Fail CLOSED: throwing rejects the
    // upload rather than publishing a file only partly read.
    throw new Error(
      "Public artifact exceeds the personal-data scan budget; refusing it"
    );
  }

  const bytes = await input.readBytes(MAX_PERSONAL_DATA_SCAN_BYTES);
  let text: string;
  let imagePages = false;
  if (extraction === "utf8") {
    text = decodeTextForScan(bytes);
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
        parserError: error instanceof Error ? error.name : typeof error,
      };
    }
  }

  // What WAS read is still checked: a match in a PDF's text pages refuses the
  // file however many of its pages are images.
  const kinds = detectPersonalDataKinds(text);
  if (kinds.length > 0) return { refused: true, kinds };
  if (imagePages) {
    return { refused: false, scanned: false, reason: "needs-ocr" };
  }
  return { refused: false, scanned: true };
}
