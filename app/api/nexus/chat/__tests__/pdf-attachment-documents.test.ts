/**
 * A scanned answer sheet's circled letters were invisible to the model: it only
 * received the PDF's extracted text ("1. A B C D"). The current turn's PDFs are
 * now also sent as documents the model reads visually (prod, 2026-10-26).
 */
import { describe, it, expect, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UIMessage } from "ai";
import {
  MAX_PDF_DOCUMENTS,
  MAX_PDF_DOCUMENTS_TOTAL_BYTES,
  bedrockSafePdfFilename,
  pdfContentSafetyCheck,
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
    isPdfContentAllowed: async () => true,
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

  it.each([
    { provider: "google", model_id: "gemini-3.8-flash" }, // accepts PDFs, but unverified on our ids
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

  it("skips only the PDF that fails and still attaches the others", async () => {
    const result = await run({
      resolveSources: async () => [source(1, "a.pdf"), source(2, "b.pdf")],
      loadPdf: async s => { if (s.itemId === 1) throw new Error("s3 down"); return PDF; },
    });
    expect(result.attachedCount).toBe(1);
    expect(result.messages[2].parts[0]).toMatchObject({ filename: "b.pdf" });
  });

  it("does not attach a PDF the content-safety check refuses (and does not load it)", async () => {
    const loadPdf = jest.fn(async () => PDF);
    const result = await run({ isPdfContentAllowed: async () => false, loadPdf });
    expect(result.messages).toBe(messages);
    expect(loadPdf).not.toHaveBeenCalled();
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
  it("covers only the verified path: Claude 4.x/5.x on Bedrock", () => {
    expect(modelReadsPdfDocuments(CLAUDE)).toBe(true);
    expect(modelReadsPdfDocuments({ provider: "amazon-bedrock", model_id: "us.anthropic.claude-haiku-5-5" })).toBe(true);
    expect(modelReadsPdfDocuments({ provider: "google", model_id: "gemini-4-argon" })).toBe(false);
    expect(modelReadsPdfDocuments({ provider: "amazon-bedrock", model_id: "us.openai.gpt-6-luna" })).toBe(false);
  });
});

describe("pdfContentSafetyCheck", () => {
  const allow = { allowed: true, processedContent: "", requestId: "r", processingTimeMs: 0, contentModified: false };
  const block = { ...allow, allowed: false };

  it("allows without loading text when guardrails are off", async () => {
    const loadText = jest.fn(async () => "text");
    const check = pdfContentSafetyCheck("sub", {
      safety: { isEnabled: () => false, processInput: jest.fn(async () => allow) as never },
      loadText,
    });
    await expect(check(source(7))).resolves.toBe(true);
    expect(loadText).not.toHaveBeenCalled();
  });

  it("checks the extracted text in slices and refuses on any blocked slice", async () => {
    const processInput = jest.fn(async (text: string, _sessionId: string) => (text.startsWith("bad") ? block : allow));
    const check = pdfContentSafetyCheck("sub", {
      safety: { isEnabled: () => true, processInput: processInput as never },
      loadText: async () => "x".repeat(20_000) + "bad content",
    });
    await expect(check(source(7))).resolves.toBe(false);
    expect(processInput).toHaveBeenCalledTimes(2);
    expect(processInput).toHaveBeenLastCalledWith("bad content", "sub");
  });

  it("refuses a PDF with no extracted text when guardrails are on (nothing was screened)", async () => {
    const processInput = jest.fn(async () => allow);
    const check = pdfContentSafetyCheck("sub", {
      safety: { isEnabled: () => true, processInput: processInput as never },
      loadText: async () => "  \n ",
    });
    await expect(check(source(7))).resolves.toBe(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it("allows when every slice passes", async () => {
    const check = pdfContentSafetyCheck("sub", {
      safety: { isEnabled: () => true, processInput: jest.fn(async () => allow) as never },
      loadText: async () => "clean text",
    });
    await expect(check(source(7))).resolves.toBe(true);
  });
});

describe("route wiring", () => {
  it("streams the model copy with PDFs and the content-safety check", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the sibling route module.
    const route = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    expect(route).toMatch(/messages: await modelMessagesWithAttachedPdfs\(/);
    expect(route).toMatch(/isPdfContentAllowed: pdfContentSafetyCheck\(prepared\.session\.sub\)/);
  });
});
