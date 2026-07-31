"use client";

import { REPOSITORY_UPLOAD_TEMPORARY_TAGGING } from "./upload-state";

export interface BrowserRepositoryUpload {
  sessionId: string;
  uploadMethod: "single" | "multipart";
  uploadUrl?: string;
  partSize?: number;
  partUrls?: Array<{ partNumber: number; uploadUrl: string }>;
}

export interface BrowserCompletedPart {
  ETag: string;
  PartNumber: number;
}

const STORAGE_UPLOAD_DEADLINE_MS = 15 * 60 * 1_000;

async function uploadWithDeadline(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    STORAGE_UPLOAD_DEADLINE_MS
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Upload directly from the browser to canonical object storage. Product
 * surfaces share this helper so large sources never traverse a Next.js body.
 */
export async function uploadFileToRepositoryStorage(
  file: File,
  upload: BrowserRepositoryUpload,
  contentType: string
): Promise<BrowserCompletedPart[] | undefined> {
  if (upload.uploadMethod === "single") {
    if (!upload.uploadUrl) {
      throw new Error("Upload URL was not provided");
    }
    const response = await uploadWithDeadline(upload.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "If-None-Match": "*",
        "x-amz-tagging": REPOSITORY_UPLOAD_TEMPORARY_TAGGING,
      },
      body: file,
    }, "Storage upload");
    if (!response.ok) {
      throw new Error("Failed to upload file to storage");
    }
    return undefined;
  }

  if (!upload.partSize || !upload.partUrls?.length) {
    throw new Error("Multipart upload configuration was incomplete");
  }

  const completedParts: BrowserCompletedPart[] = [];
  let nextPartIndex = 0;
  const workers = Array.from(
    { length: Math.min(4, upload.partUrls.length) },
    async () => {
      while (nextPartIndex < upload.partUrls!.length) {
        const index = nextPartIndex;
        nextPartIndex += 1;
        const part = upload.partUrls![index];
        const start = (part.partNumber - 1) * upload.partSize!;
        const body = file.slice(
          start,
          Math.min(start + upload.partSize!, file.size)
        );
        const response = await uploadWithDeadline(part.uploadUrl, {
          method: "PUT",
          body,
        }, `Storage upload part ${part.partNumber}`);
        if (!response.ok) {
          throw new Error(`Failed to upload part ${part.partNumber}`);
        }
        const ETag = response.headers.get("ETag");
        if (!ETag) {
          throw new Error(
            `Storage did not return an ETag for part ${part.partNumber}`
          );
        }
        completedParts.push({ ETag, PartNumber: part.partNumber });
      }
    }
  );
  await Promise.all(workers);
  return completedParts.sort((left, right) => left.PartNumber - right.PartNumber);
}
