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
