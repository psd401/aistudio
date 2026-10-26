/**
 * A scanned answer sheet's circled letters were invisible to the model: it only
 * received the PDF's extracted text ("1. A B C D"). The current turn's PDFs are
 * now also sent as documents the model reads visually (prod, 2026-10-26).
 */
import { describe, it, expect, jest } from "@jest/globals";
import type { UIMessage } from "ai";
import {
  MAX_PDF_DOCUMENTS,
  MAX_PDF_DOCUMENTS_TOTAL_BYTES,
  bedrockSafePdfFilename,
  modelReadsPdfDocuments,
  withAttachedPdfDocuments,
} from "../pdf-attachment-documents";
import type { NexusAttachmentImageSource } from "@/lib/nexus/ephemeral-repository-service";

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;
const CLAUDE = { provider: "amazon-bedrock", model_id: "us.anthropic.claude-sonnet-5-5" };
const reference = { bindingId: "00000000-0000-4000-8000-000000000001", itemId: 7 };
const PDF = Buffer.from("%PDF-1.7 test");

function source(itemId: number, itemName = "va.pdf"): NexusAttachmentImageSource {
  return {
    bindingId: reference.bindingId, itemId, itemName, repositoryId: 1, itemVersionId: "v",
    objectKey: "k", declaredContentType: "application/pdf", detectedContentType: "application/pdf",
    byteSize: PDF.byteLength,
  };
}

const messages: UIMessage[] = [
  { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
  { id: "3", role: "user", parts: [{ type: "text", text: "score the MC questions" }] },
];

function run(overrides: Partial<Parameters<typeof withAttachedPdfDocuments>[0]> = {}) {
  return withAttachedPdfDocuments({
    messages,
    references: [reference],
    ownerId: 272,
    conversationId: "00000000-0000-4000-8000-000000000002",
    modelConfig: CLAUDE,
    log,
    resolveSources: async () => [source(7)],
    loadPdf: async () => PDF,
    ...overrides,
  });
}

describe("withAttachedPdfDocuments", () => {
  it("prepends the current turn's PDF to the last user message for Claude", async () => {
    const result = await run();
    expect(result.attachedCount).toBe(1);
    const parts = result.messages[2].parts;
    expect(parts[0]).toEqual({
      type: "file",
      mediaType: "application/pdf",
      filename: "va.pdf",
      url: `data:application/pdf;base64,${PDF.toString("base64")}`,
    });
    expect(parts[1]).toEqual({ type: "text", text: "score the MC questions" });
    // Earlier turns and the caller's array are untouched (model copy only).
    expect(result.messages[0]).toBe(messages[0]);
    expect(messages[2].parts).toHaveLength(1);
  });

  it("works for Gemini", async () => {
    const result = await run({ modelConfig: { provider: "google", model_id: "gemini-3.8-flash" } });
    expect(result.attachedCount).toBe(1);
  });

  it.each([
    { provider: "amazon-bedrock", model_id: "us.openai.gpt-6-sol" },
    { provider: "openai", model_id: "gpt-image-2.5-flare" },
    { provider: "latimer", model_id: "gpt-4o-mini" },
    { provider: "amazon-bedrock", model_id: "us.anthropic.claude-3-5-haiku-20241022-v1:0" },
  ])("leaves the turn unchanged for $model_id (not known to read PDFs visually)", async modelConfig => {
    const resolveSources = jest.fn(async () => [source(7)]);
    const result = await run({ modelConfig, resolveSources });
    expect(result.attachedCount).toBe(0);
    expect(result.messages).toBe(messages);
    expect(resolveSources).not.toHaveBeenCalled();
  });

  it("does nothing without attachment references", async () => {
    const result = await run({ references: [] });
    expect(result.messages).toBe(messages);
  });

  it("fails open when resolving or loading throws", async () => {
    const thrown = await run({ resolveSources: async () => { throw new Error("db down"); } });
    expect(thrown.messages).toBe(messages);
    const loadFails = await run({ loadPdf: async () => { throw new Error("s3 down"); } });
    expect(loadFails.messages).toBe(messages);
  });

  it("skips PDFs the loader rejects (too large, not a PDF)", async () => {
    const result = await run({ loadPdf: async () => null });
    expect(result.messages).toBe(messages);
  });

  it("caps the number and combined size of documents", async () => {
    const many = Array.from({ length: MAX_PDF_DOCUMENTS + 2 }, (_, i) => source(i + 1, `p${i}.pdf`));
    const capped = await run({ resolveSources: async () => many });
    expect(capped.attachedCount).toBe(MAX_PDF_DOCUMENTS);

    const big = Buffer.concat([PDF, Buffer.alloc(Math.ceil(MAX_PDF_DOCUMENTS_TOTAL_BYTES / 2))]);
    const sized = await run({ resolveSources: async () => [source(1), source(2), source(3)], loadPdf: async () => big });
    expect(sized.attachedCount).toBe(1);
  });
});

describe("bedrockSafePdfFilename", () => {
  it("keeps only characters Bedrock document names allow", () => {
    expect(bedrockSafePdfFilename("Period_3 FRQ.v2.pdf", 0)).toBe("Period 3 FRQ v2.pdf");
    expect(bedrockSafePdfFilename("Unit (4) [final]-key.PDF", 0)).toBe("Unit (4) [final]-key.pdf");
    expect(bedrockSafePdfFilename("___.pdf", 1)).toBe("attachment 2.pdf");
  });
});

describe("modelReadsPdfDocuments", () => {
  it("covers Claude 4.x/5.x on Bedrock and Gemini only", () => {
    expect(modelReadsPdfDocuments(CLAUDE)).toBe(true);
    expect(modelReadsPdfDocuments({ provider: "amazon-bedrock", model_id: "us.anthropic.claude-haiku-5-5" })).toBe(true);
    expect(modelReadsPdfDocuments({ provider: "google", model_id: "gemini-4-argon" })).toBe(true);
    expect(modelReadsPdfDocuments({ provider: "amazon-bedrock", model_id: "us.openai.gpt-6-luna" })).toBe(false);
  });
});
