/** @jest-environment node */
/**
 * #1900 — a Gemini reply with text but no image used to become a generic 500.
 *
 * `extractGeminiImage` threw `NO_IMAGE` and discarded `result.text`, so the
 * user saw "Image generation failed. Please try again." while the model had
 * already explained why retrying would not help. The explanation now travels
 * with the error and is shown under an unambiguous label.
 */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: jest.fn(),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

import {
  NO_IMAGE_LABEL,
  buildNoImageMessage,
  getNoImageExplanation,
  respondToImageFailure,
} from "@/app/api/nexus/chat/image-generation-handler"

function imageError(
  type: string,
  message: string,
  providerText?: string,
): Error {
  const error = new Error(message) as Error & {
    type: string
    providerText?: string
  }
  error.type = type
  if (providerText !== undefined) error.providerText = providerText
  return error
}

describe("getNoImageExplanation", () => {
  it("returns the model's words when it answered with text instead of an image", () => {
    expect(
      getNoImageExplanation(
        imageError(
          "NO_IMAGE",
          "Gemini did not generate an image. Try a different prompt.",
          "  I can't create images of identifiable real people.  ",
        ),
      ),
    ).toBe("I can't create images of identifiable real people.")
  })

  /**
   * NO_IMAGE is also thrown for reference-image validation and empty provider
   * responses. Those are failures, not answers: they must keep the error path
   * (and its rollback) rather than be saved as a friendly assistant turn.
   */
  it("returns null for a NO_IMAGE failure the model did not explain", () => {
    expect(
      getNoImageExplanation(
        imageError("NO_IMAGE", "Reference image exceeds maximum allowed size"),
      ),
    ).toBeNull()
    expect(
      getNoImageExplanation(imageError("NO_IMAGE", "OpenAI returned no image data")),
    ).toBeNull()
    expect(
      getNoImageExplanation(imageError("NO_IMAGE", "Gemini did not generate an image.", "   ")),
    ).toBeNull()
  })

  it("leaves every other failure on the error path", () => {
    expect(getNoImageExplanation(imageError("CONTENT_POLICY", "blocked", "no"))).toBeNull()
    expect(getNoImageExplanation(imageError("STORAGE_ERROR", "s3 down"))).toBeNull()
    expect(getNoImageExplanation(new Error("boom"))).toBeNull()
    expect(getNoImageExplanation("NO_IMAGE")).toBeNull()
    expect(getNoImageExplanation(null)).toBeNull()
  })
})

describe("buildNoImageMessage", () => {
  it("shows the model's explanation under the no-image label", () => {
    const text = buildNoImageMessage("I can't create images of identifiable real people.")

    expect(text).toBe(
      `${NO_IMAGE_LABEL}\n\nI can't create images of identifiable real people.`,
    )
    expect(NO_IMAGE_LABEL).toBe("**Image not generated.**")
  })
})

/**
 * What the route returns once generation threw. The model's explanation is
 * a saved reply; anything else, including an explanation that could not be
 * saved, rolls back a new conversation and returns the error.
 */
describe("respondToImageFailure", () => {
  function harness() {
    const reply = new Response("reply")
    const errorResponse = new Response("error", { status: 500 })
    return {
      reply,
      errorResponse,
      replyWithExplanation: jest.fn().mockResolvedValue(reply),
      rollback: jest.fn().mockResolvedValue(null),
      toErrorResponse: jest.fn().mockReturnValue(errorResponse),
    }
  }

  it("saves and returns the model's explanation without rolling back", async () => {
    const h = harness()

    const response = await respondToImageFailure({
      error: imageError("NO_IMAGE", "no image", "I can't draw real people."),
      conversationId: "c1",
      ...h,
    })

    expect(response).toBe(h.reply)
    expect(h.replyWithExplanation).toHaveBeenCalledWith("I can't draw real people.")
    expect(h.rollback).not.toHaveBeenCalled()
  })

  it("rolls back and returns the save error when the explanation cannot be saved", async () => {
    const h = harness()
    const saveError = new Error("connection reset")
    h.replyWithExplanation.mockRejectedValue(saveError)

    const response = await respondToImageFailure({
      error: imageError("NO_IMAGE", "no image", "I can't draw real people."),
      conversationId: "c1",
      ...h,
    })

    expect(h.rollback).toHaveBeenCalledTimes(1)
    expect(h.toErrorResponse).toHaveBeenCalledWith(saveError)
    expect(response).toBe(h.errorResponse)
  })

  it("rolls back an unexplained NO_IMAGE without a friendly reply", async () => {
    const h = harness()
    const error = imageError("NO_IMAGE", "Reference image exceeds maximum allowed size")

    const response = await respondToImageFailure({ error, conversationId: "c1", ...h })

    expect(h.replyWithExplanation).not.toHaveBeenCalled()
    expect(h.rollback).toHaveBeenCalledTimes(1)
    expect(h.toErrorResponse).toHaveBeenCalledWith(error)
    expect(response).toBe(h.errorResponse)
  })

  it("returns the rollback's own error when compensation fails", async () => {
    const h = harness()
    const cleanupError = new Response("cleanup", { status: 500 })
    h.rollback.mockResolvedValue(cleanupError)

    const response = await respondToImageFailure({
      error: imageError("CONTENT_POLICY", "blocked"),
      conversationId: "c1",
      ...h,
    })

    expect(response).toBe(cleanupError)
    expect(h.toErrorResponse).not.toHaveBeenCalled()
  })
})
