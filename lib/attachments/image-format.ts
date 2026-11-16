/**
 * Pure image-format helpers shared by the browser (attach-time conversion in
 * `image-normalize.ts`) and the server (the Nexus chat route's history guard).
 * Kept free of the HEIC decoder so importing it never pulls that into a bundle.
 */

/** Media types every Nexus vision provider accepts inline. */
export const MODEL_SAFE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** Byte signatures: each `[offset, bytes]` pair must match for the format. */
const SIGNATURES: ReadonlyArray<{ type: string; match: ReadonlyArray<[number, number[]]> }> = [
  { type: "image/png", match: [[0, [0x89, 0x50, 0x4E, 0x47]]] },
  { type: "image/jpeg", match: [[0, [0xFF, 0xD8, 0xFF]]] },
  { type: "image/gif", match: [[0, [0x47, 0x49, 0x46, 0x38]]] },
  // "RIFF" .... "WEBP" — RIFF alone is also WAV/AVI.
  { type: "image/webp", match: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] },
];

const startsWithAt = (header: Uint8Array, offset: number, bytes: number[]) =>
  bytes.every((byte, index) => header[offset + index] === byte);

/**
 * The model-safe media type the bytes actually are, "heif" for an ISO-BMFF
 * HEIC/HEIF container, or null for anything else. Sniffed, never trusted from
 * `file.type`: Chrome derives that from the extension.
 */
export function sniffImageFormat(header: Uint8Array): string | "heif" | null {
  for (const signature of SIGNATURES) {
    if (signature.match.every(([offset, bytes]) => startsWithAt(header, offset, bytes))) {
      return signature.type;
    }
  }
  // ISO-BMFF: [size:4]["ftyp"][major brand:4]
  if (startsWithAt(header, 4, [0x66, 0x74, 0x79, 0x70]) && header.length >= 12) {
    const brand = String.fromCharCode(...header.subarray(8, 12));
    if (HEIF_BRANDS.has(brand)) return "heif";
  }
  return null;
}
