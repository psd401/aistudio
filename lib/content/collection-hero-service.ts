/**
 * Atrium collection hero images (migration 178).
 *
 * A section had a name, and after migration 175 a description — but no visual
 * identity, so every section landing page read as the same wall of text and the
 * intranet's top level was indistinguishable from its SOP index.
 *
 * Two ways to get one, both landing in the same place (an S3 key on the
 * collection row):
 *
 *  1. UPLOAD — the author already has the photo.
 *  2. GENERATE — the author does not, and describing the section is faster than
 *     finding stock art. Routed through the SAME `generateImageForNexus`
 *     service Nexus chat and the agent `images.generate` tool use, so there is
 *     one image-generation code path in the codebase rather than three.
 *
 * ## Why the bytes are re-stored rather than linked
 *
 * `generateImageForNexus` writes to its own `v2/generated-images/{conversationId}/…`
 * prefix, which `/api/images/[...key]` serves ONLY after validating conversation
 * ownership. A collection has no conversation, so that route would (correctly)
 * 404 every hero. Copying the bytes under `atrium/collections/{id}/hero/{imageId}`
 * puts them behind Atrium's own collection-access check instead of borrowing a
 * conversation's.
 *
 * ## Content safety
 *
 * Generated hero images are NOT guardrail-screened (Hagel, 2026-08-14: authors
 * self-discern), and every image is attributable through the audit log.
 *
 * ## Neither function here authorizes anything
 *
 * Both take a `collectionId` and act on it. The permission check lives in
 * `setCollectionHeroImageAction`, which calls
 * `collectionManagementService.assertMaySetSectionCopy` BEFORE either of them —
 * deliberately before, because both spend real resources (an S3 write, a paid
 * model call) and a check that runs afterwards cannot prevent the cost.
 *
 * Any NEW caller must do the same. Reaching these functions without that check
 * hands every signed-in account a storage- and spend-abuse vector against
 * arbitrary collection ids.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logger";
import { getAIModels } from "@/lib/db/drizzle/ai-models";
import { hasCapability } from "@/lib/ai/capability-utils";
import { generateImageForNexus } from "@/lib/ai/image-generation-service";
import { safeFetch } from "@/lib/security/safe-fetch";
import { s3Store } from "./storage/s3-store";
import { ValidationError } from "./errors";

const log = createLogger({ context: "collection-hero-service" });

/**
 * Upload ceiling for a hero image. Generous for photography, small enough that
 * a mis-selected RAW file or video fails fast instead of tying up a server
 * action — and it bounds the base64 payload a single action can be asked to
 * decode.
 */
export const MAX_HERO_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Raster formats only, and an explicit ALLOWLIST rather than a `image/*` test.
 * `image/svg+xml` is the reason: an SVG is an active document that can carry
 * script, and it would be served from our own origin. Nothing about a section
 * header needs it.
 */
const ALLOWED_HERO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Extension for the stored key, so a download has a sensible filename. */
function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "gif";
  }
}

export interface StoredHeroImage {
  key: string;
  contentType: string;
  byteLength: number;
}

/**
 * Decode a `data:` URL from the upload control and store it as this
 * collection's hero image.
 *
 * The size check runs on the DECODED bytes, not the base64 string — base64
 * inflates by ~33%, so checking the encoded length would silently enforce a
 * different (smaller) limit than the one documented.
 */
export async function storeHeroImageFromDataUrl(
  collectionId: string,
  dataUrl: string
): Promise<StoredHeroImage> {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new ValidationError(
      "Expected a base64 image. Try choosing the file again."
    );
  }
  const [, contentType, base64] = match;
  if (!ALLOWED_HERO_TYPES.has(contentType.toLowerCase())) {
    throw new ValidationError(
      `Unsupported image type "${contentType}". Use PNG, JPEG, WebP, or GIF.`
    );
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) {
    throw new ValidationError("That image file appears to be empty.");
  }
  if (bytes.byteLength > MAX_HERO_IMAGE_BYTES) {
    throw new ValidationError(
      `That image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB. The limit is ${
        MAX_HERO_IMAGE_BYTES / 1024 / 1024
      }MB.`
    );
  }

  const key = s3Store.collectionHeroKey(
    collectionId,
    `${randomUUID()}.${extensionFor(contentType.toLowerCase())}`
  );
  await s3Store.putBytes(key, new Uint8Array(bytes), contentType.toLowerCase());
  log.info("Stored uploaded collection hero image", {
    collectionId,
    byteLength: bytes.byteLength,
  });
  return { key, contentType, byteLength: bytes.byteLength };
}

/**
 * The platform's configured image model, or null when none is active.
 *
 * Mirrors the agent tool's resolver rather than importing it: that one lives in
 * the MCP tool registry and returns tool-shaped results. Same query, same
 * capability flag, no cache — one indexed read is negligible beside the
 * multi-second generation call it precedes.
 */
async function resolveImageModel(): Promise<
  { modelId: string; provider: "openai" | "google" } | null
> {
  const models = await getAIModels();
  const candidate = models.find(
    (m) =>
      m.active &&
      (m.provider === "openai" || m.provider === "google") &&
      hasCapability(m.capabilities, "imageGeneration")
  );
  if (!candidate) return null;
  return {
    modelId: candidate.modelId,
    provider: candidate.provider as "openai" | "google",
  };
}

/**
 * Read generated image bytes back from the presigned URL the generation
 * service returned.
 *
 * Through `safeFetch` (SSRF-guarded, no redirect following) even though the URL
 * comes from our own service: it is still an outbound request to a host
 * resolved at runtime, and this is the same treatment the generation service
 * gives its own reference-image fetches.
 *
 * The body is read as an ArrayBuffer and then LENGTH-CHECKED. That check is a
 * backstop, not the primary bound — the bytes originate from our own generation
 * call at a size we requested, so a response over the cap means something is
 * wrong upstream rather than a hostile payload.
 */
async function fetchGeneratedImageBytes(url: string): Promise<Uint8Array> {
  const response = await safeFetch(url, { method: "GET" });
  if (!response.ok) {
    throw new ValidationError(
      "The generated image could not be retrieved. Please try again."
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new ValidationError("The generated image came back empty.");
  }
  if (buffer.byteLength > MAX_HERO_IMAGE_BYTES) {
    throw new ValidationError("The generated image was unexpectedly large.");
  }
  return buffer;
}

/**
 * Generate a hero image from a text prompt and store it against the collection.
 *
 * Re-reads the generated bytes back out of the generation service's own
 * storage and re-stores them under the Atrium collection prefix — see the
 * module docblock for why linking the original key does not work.
 */
export async function generateHeroImage(
  collectionId: string,
  prompt: string,
  userId: number
): Promise<StoredHeroImage> {
  const trimmed = prompt.trim();
  if (trimmed.length < 3) {
    throw new ValidationError(
      "Describe the image you want in a few more words."
    );
  }

  const model = await resolveImageModel();
  if (!model) {
    throw new ValidationError(
      "No image-generation model is configured for this deployment."
    );
  }

  const result = await generateImageForNexus({
    prompt: trimmed,
    modelId: model.modelId,
    provider: model.provider,
    // No conversation exists here. A stable, collection-scoped synthetic id
    // keeps the generation service's own key layout meaningful (and traceable
    // back to the section) without pretending a chat took place — the same
    // approach the agent `images.generate` tool takes with `agent-{requestId}`.
    conversationId: `atrium-collection-${collectionId}`,
    userId: String(userId),
    // Wide, because it renders as a banner across the top of a section page.
    size: "1792x1024",
  });

  // Read the bytes back through the presigned URL the generation service
  // returned, NOT through `s3Store.getBytesBounded(result.s3Key)`.
  //
  // The two services resolve their bucket differently: the generation service
  // reads `DOCUMENTS_BUCKET_NAME` directly, while `s3Store` goes through
  // `Settings.getS3()`, which prefers an `S3_BUCKET` setting and only falls
  // back to that env var. They are the same bucket in every current
  // deployment — but a key read is silent when that assumption breaks, and it
  // breaks by configuration rather than by code change. The presigned URL
  // carries its own bucket and needs no such assumption.
  const bytes = await fetchGeneratedImageBytes(result.imageUrl);
  const contentType = "image/png";
  const key = s3Store.collectionHeroKey(
    collectionId,
    `${randomUUID()}.${extensionFor(contentType)}`
  );
  await s3Store.putBytes(key, bytes, contentType);
  log.info("Stored generated collection hero image", {
    collectionId,
    provider: model.provider,
    byteLength: bytes.byteLength,
  });
  return { key, contentType, byteLength: bytes.byteLength };
}
