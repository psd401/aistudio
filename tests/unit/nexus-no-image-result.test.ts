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
  isNoImageError,
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
  if (providerText) error.providerText = providerText
  return error
}

describe("isNoImageError", () => {
  it("recognises a NO_IMAGE image-generation error", () => {
    expect(isNoImageError(imageError("NO_IMAGE", "no image"))).toBe(true)
  })

  it("leaves every other failure on the error path", () => {
    expect(isNoImageError(imageError("CONTENT_POLICY", "blocked"))).toBe(false)
    expect(isNoImageError(imageError("STORAGE_ERROR", "s3 down"))).toBe(false)
    expect(isNoImageError(new Error("boom"))).toBe(false)
    expect(isNoImageError("NO_IMAGE")).toBe(false)
    expect(isNoImageError(null)).toBe(false)
  })
})

describe("buildNoImageMessage", () => {
  it("returns the model's own explanation under a no-image label", () => {
    const text = buildNoImageMessage(
      imageError(
        "NO_IMAGE",
        "Gemini did not generate an image. Try a different prompt.",
        "I can't create images of identifiable real people.",
      ),
    )

    expect(text.startsWith(NO_IMAGE_LABEL)).toBe(true)
    expect(text).toContain("I can't create images of identifiable real people.")
    // The generic retry advice must not replace what the model actually said.
    expect(text).not.toContain("Image generation failed")
  })

  it("falls back to the error message when the model said nothing", () => {
    const text = buildNoImageMessage(
      imageError("NO_IMAGE", "Could not extract image data from Gemini response"),
    )

    expect(text).toBe(
      `${NO_IMAGE_LABEL}\n\nCould not extract image data from Gemini response`,
    )
  })

  it("still labels the turn when there is nothing to explain at all", () => {
    const text = buildNoImageMessage(imageError("NO_IMAGE", "   "))

    expect(text).toBe(
      `${NO_IMAGE_LABEL}\n\nThe model did not return an image and gave no explanation.`,
    )
  })
})
