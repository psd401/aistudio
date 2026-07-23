import { createHash } from "node:crypto";
import { uploadRepositoryTextSource } from "@/lib/aws/s3-client";
import {
  type CanonicalUploadRegistration,
  registerCanonicalUpload,
} from "./ingestion-service";
import { getContentPlatformConfig, isContentDualWriteActive } from "./config";

export interface RegisterCanonicalTextInput {
  itemId: number;
  repositoryId: number;
  userId: number;
  name: string;
  content: string;
  traceId?: string;
}

function textSourceFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^\d.A-Za-z-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 240);
  const base = sanitized || "repository-text";
  return base.toLowerCase().endsWith(".txt") ? base : `${base}.txt`;
}

/**
 * Shadow-write Repository Manager inline text through the same immutable S3,
 * inspection, processing, generation, and embedding pipeline as uploaded files.
 */
export async function registerCanonicalTextIfEnabled(
  input: RegisterCanonicalTextInput
): Promise<CanonicalUploadRegistration | null> {
  const config = await getContentPlatformConfig();
  if (!isContentDualWriteActive(config)) return null;
  if (!input.content.trim()) throw new Error("Text content is required");

  const byteSize = Buffer.byteLength(input.content, "utf8");
  const maximumBytes = Math.min(
    config.maxFileSizeGb * 1024 ** 3,
    config.maxOfficeSizeMb * 1024 ** 2
  );
  if (byteSize > maximumBytes) {
    throw new Error(
      `Text content must not exceed ${Math.floor(maximumBytes / 1024 ** 2)} MiB`
    );
  }

  const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
  const originalFileName = textSourceFileName(input.name);
  const source = await uploadRepositoryTextSource({
    repositoryId: input.repositoryId,
    itemId: input.itemId,
    userId: input.userId,
    fileName: originalFileName,
    content: input.content,
  });

  return registerCanonicalUpload({
    itemId: input.itemId,
    userId: input.userId,
    objectKey: source.key,
    originalFileName,
    declaredContentType: "text/plain",
    byteSize: source.byteSize,
    sha256,
    traceId: input.traceId,
  });
}
