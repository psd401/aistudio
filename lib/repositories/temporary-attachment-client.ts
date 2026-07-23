"use client";

import {
  buildTemporaryAttachmentMarker,
  type CanonicalTemporaryAttachmentUpload,
  type TemporaryAttachmentUploadResponse,
} from "./temporary-attachment-contract";
import {
  uploadFileToRepositoryStorage,
  type BrowserRepositoryUpload,
} from "./content-platform/browser-upload";

interface TemporaryAttachmentStatus {
  status:
    | "pending"
    | "processing"
    | "retrying"
    | "processing_embeddings"
    | "embedded"
    | "failed";
  error?: string | null;
}

interface UploadTemporaryAttachmentInput {
  file: File;
  draftKey: string;
  purpose: "nexus" | "assistant-architect";
  conversationId?: string;
}

async function parseErrorResponse(
  response: Response,
  fallback: string
): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(body?.error || `${fallback} (HTTP ${response.status})`);
}

export async function uploadTemporaryAttachment(
  input: UploadTemporaryAttachmentInput
): Promise<TemporaryAttachmentUploadResponse> {
  const contentType =
    input.file.type.toLowerCase().split(";", 1)[0]?.trim() ||
    "application/octet-stream";
  const response = await fetch("/api/repositories/temporary-attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      draftKey: input.draftKey,
      purpose: input.purpose,
      conversationId: input.conversationId,
      fileName: input.file.name,
      contentType,
      byteSize: input.file.size,
    }),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "Temporary attachment upload failed");
  }
  const initiated = (await response.json()) as
    | { mode: "legacy" }
    | {
        mode: "canonical";
        bindingId: string;
        repositoryId: number;
        upload: BrowserRepositoryUpload;
      };
  if (initiated.mode === "legacy") return initiated;

  const parts = await uploadFileToRepositoryStorage(
    input.file,
    initiated.upload,
    contentType
  );
  const completionResponse = await fetch(
    `/api/repositories/temporary-attachments/${initiated.bindingId}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: initiated.upload.sessionId,
        name: input.file.name,
        parts,
      }),
    }
  );
  if (!completionResponse.ok) {
    throw await parseErrorResponse(
      completionResponse,
      "Temporary attachment completion failed"
    );
  }
  return (await completionResponse.json()) as CanonicalTemporaryAttachmentUpload;
}

export async function waitForTemporaryAttachment(
  upload: CanonicalTemporaryAttachmentUpload,
  options: { maxAttempts?: number; initialDelayMs?: number } = {}
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 90;
  let delayMs = options.initialDelayMs ?? 1_000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(
      `/api/repositories/temporary-attachments/${upload.reference.bindingId}/${upload.reference.itemId}`
    );
    if (!response.ok) {
      throw await parseErrorResponse(
        response,
        "Temporary attachment status check failed"
      );
    }
    const result = (await response.json()) as TemporaryAttachmentStatus;
    // "completed" means extraction was published into a building generation;
    // only "embedded" proves the current version is in the active generation
    // (including the no-embedding publication path).
    if (result.status === "embedded") {
      return buildTemporaryAttachmentMarker(upload.reference);
    }
    if (result.status === "failed") {
      throw new Error(result.error || "Attachment processing failed");
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.ceil(delayMs * 1.2), 5_000);
    }
  }

  throw new Error("Attachment processing timed out");
}
