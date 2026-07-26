import type { UIMessage } from "ai"
import {
  applyProcessedInlineAttachmentValues,
  canonicalizeInlineAttachmentMessages,
  MAX_INLINE_ATTACHMENT_BYTES,
  NexusInlineAttachmentValidationError,
  scanCanonicalInlineAttachments,
} from "@/lib/nexus/inline-attachment-security"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"

function message(parts: unknown[]): UIMessage {
  return {
    id: "message-1",
    role: "user",
    parts,
  } as unknown as UIMessage
}

function legacyMessage(content: unknown): UIMessage {
  return {
    id: "message-1",
    role: "user",
    content,
  } as unknown as UIMessage
}

function allowedResult(processedContent: string) {
  return {
    allowed: true,
    processedContent,
    requestId: "request-1",
    processingTimeMs: 1,
    contentModified: true,
    tokens: [],
  }
}

describe("Nexus inline attachment boundary", () => {
  it("rejects dual content/data fields instead of choosing one", () => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        message([
          {
            type: "document",
            content: "scanner sees this",
            data: "sink receives this",
          },
        ]),
      ])
    ).toThrow(NexusInlineAttachmentValidationError)
  })

  it("rejects dual content/data fields in a legacy content array", () => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        legacyMessage([
          {
            type: "document",
            content: "scanner sees this",
            data: "sink receives this",
          },
        ]),
      ])
    ).toThrow(NexusInlineAttachmentValidationError)
  })

  it("rejects simultaneous parts and legacy message content", () => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        {
          ...message([{ type: "text", text: "parts value" }]),
          content: [{ type: "text", text: "legacy value" }],
        } as unknown as UIMessage,
      ])
    ).toThrow("Messages cannot contain both parts and legacy content")
  })

  it.each([
    [""],
    [[{ type: "image", url: "data:image/png;base64,abc" }]],
    [[{ type: "text", text: "ok", extra: true }]],
    [[{ type: "text", text: "ok" }, { type: "image", url: "x" }]],
  ])("rejects malformed or mixed attachment text: %p", (content) => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        message([{ type: "document", content }]),
      ])
    ).toThrow(NexusInlineAttachmentValidationError)
  })

  it("rejects inline data combined with a URL payload", () => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        message([
          {
            type: "file",
            data: "secret",
            url: "https://example.invalid/other",
          },
        ]),
      ])
    ).toThrow(NexusInlineAttachmentValidationError)
  })

  it("allows inline bodies only on the current user message", () => {
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        message([{ type: "document", data: "old raw body" }]),
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "answer" }],
        } as unknown as UIMessage,
        {
          ...message([{ type: "text", text: "next turn" }]),
          id: "message-2",
        },
      ])
    ).toThrow(NexusInlineAttachmentValidationError)
  })

  it("canonicalizes text arrays to one data field", () => {
    const result = canonicalizeInlineAttachmentMessages([
      message([
        {
          type: "document",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ])
    expect(result.inlineAttachmentCount).toBe(1)
    expect(result.messages[0].parts?.[0]).toMatchObject({
      type: "document",
      data: "first\nsecond",
    })
    expect(result.messages[0].parts?.[0]).not.toHaveProperty("content")
  })

  it("rejects aggregate raw attachment text over 25 MiB", () => {
    const half = "x".repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1)
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        message([
          { type: "document", data: half },
          { type: "document", data: half },
        ]),
      ])
    ).toThrow("Combined inline attachment content exceeds")
  })

  it("enforces the aggregate limit on normalized legacy content arrays", () => {
    const half = "x".repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1)
    expect(() =>
      canonicalizeInlineAttachmentMessages([
        legacyMessage([
          { type: "document", data: half },
          { type: "document", data: half },
        ]),
      ])
    ).toThrow("Combined inline attachment content exceeds")
  })

  it("fails closed on an explicit safety block before returning sink values", async () => {
    const processInput = jest.fn().mockResolvedValue({
      ...allowedResult("ignored"),
      allowed: false,
      blockedMessage: "blocked",
      blockedCategories: ["PII"],
    })
    await expect(
      scanCanonicalInlineAttachments({
        messages: [message([{ type: "document", data: "raw" }])],
        sessionId: "session-1",
        safetyProcessor: {
          isEnabled: () => true,
          isPiiTokenizationEnabled: () => true,
          processInput,
        },
        onFailure: jest.fn(),
      })
    ).rejects.toBeInstanceOf(ContentSafetyBlockedError)
  })

  it("uses exact processedContent for every downstream representation", async () => {
    const token = {
      token: "token-id",
      original: "Ada",
      type: "PERSON",
      placeholder: "[PII:token-id]",
    }
    const processInput = jest.fn().mockResolvedValue({
      ...allowedResult("hello [PII:token-id]"),
      tokens: [token],
    })
    const result = await scanCanonicalInlineAttachments({
      messages: [message([{ type: "document", data: "hello Ada" }])],
      sessionId: "session-1",
      safetyProcessor: {
        isEnabled: () => true,
        isPiiTokenizationEnabled: () => true,
        processInput,
      },
      onFailure: jest.fn(),
    })
    expect(result.messages[0].parts?.[0]).toMatchObject({
      data: "hello [PII:token-id]",
    })
    expect(result.processedValues).toEqual(["hello [PII:token-id]"])
    expect(result.tokens).toEqual([token])

    const persistence = applyProcessedInlineAttachmentValues(
      [message([{ type: "document", data: "hello Ada" }])],
      result.processedValues
    )
    expect(persistence[0].parts?.[0]).toMatchObject({
      data: "hello [PII:token-id]",
    })
  })

  it("removes raw legacy content before and after the processed rewrite", async () => {
    const canonical = canonicalizeInlineAttachmentMessages([
      legacyMessage([
        { type: "text", text: "question" },
        { type: "document", data: "raw legacy secret" },
      ]),
    ])
    expect(canonical.inlineAttachmentCount).toBe(1)
    expect(canonical.messages[0]).not.toHaveProperty("content")

    const result = await scanCanonicalInlineAttachments({
      messages: canonical.messages,
      sessionId: "session-1",
      safetyProcessor: {
        isEnabled: () => true,
        isPiiTokenizationEnabled: () => true,
        processInput: jest.fn().mockResolvedValue(
          allowedResult("processed safe value")
        ),
      },
      onFailure: jest.fn(),
    })
    expect(result.messages[0]).not.toHaveProperty("content")
    expect(result.messages[0].parts?.[1]).toMatchObject({
      type: "document",
      data: "processed safe value",
    })
    expect(JSON.stringify(result.messages)).not.toContain("raw legacy secret")

    const downstream = applyProcessedInlineAttachmentValues(
      canonical.messages,
      result.processedValues
    )
    expect(downstream[0]).not.toHaveProperty("content")
    expect(JSON.stringify(downstream)).not.toContain("raw legacy secret")
  })

  it("skips scanning only when all configured content safety is disabled", async () => {
    const processInput = jest.fn()
    const result = await scanCanonicalInlineAttachments({
      messages: [message([{ type: "document", data: "raw" }])],
      sessionId: "session-1",
      safetyProcessor: {
        isEnabled: () => false,
        isPiiTokenizationEnabled: () => false,
        processInput,
      },
      onFailure: jest.fn(),
    })
    expect(processInput).not.toHaveBeenCalled()
    expect(result.processedValues).toEqual(["raw"])
  })

  it("enforces a guardrail block when PII tokenization is disabled", async () => {
    await expect(
      scanCanonicalInlineAttachments({
        messages: [message([{ type: "document", data: "unsafe" }])],
        sessionId: "session-1",
        safetyProcessor: {
          isEnabled: () => true,
          isPiiTokenizationEnabled: () => false,
          processInput: jest.fn().mockResolvedValue({
            ...allowedResult("unsafe"),
            allowed: false,
            blockedMessage: "blocked by guardrails",
            blockedCategories: ["VIOLENCE"],
          }),
        },
        onFailure: jest.fn(),
      })
    ).rejects.toBeInstanceOf(ContentSafetyBlockedError)
  })

  it("rejects aggregate processed expansion over 25 MiB", async () => {
    const expanded = "y".repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1)
    await expect(
      scanCanonicalInlineAttachments({
        messages: [
          message([
            { type: "document", data: "one" },
            { type: "document", data: "two" },
          ]),
        ],
        sessionId: "session-1",
        safetyProcessor: {
          isEnabled: () => true,
          isPiiTokenizationEnabled: () => true,
          processInput: jest.fn().mockResolvedValue(allowedResult(expanded)),
        },
        onFailure: jest.fn(),
      })
    ).rejects.toThrow("Combined processed inline attachment content exceeds")
  })

  it("rejects mismatched downstream attachment copies", () => {
    expect(() =>
      applyProcessedInlineAttachmentValues(
        [message([{ type: "document", data: "one" }])],
        []
      )
    ).toThrow("representations do not match")
  })
})
