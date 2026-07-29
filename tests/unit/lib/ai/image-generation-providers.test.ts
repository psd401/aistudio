/** @jest-environment node */

const generateImageMock = jest.fn()
const generateTextMock = jest.fn()
const openAIImageModelMock = jest.fn()
const googleImageModelMock = jest.fn()
const s3SendMock = jest.fn()
const getSignedUrlMock = jest.fn()

jest.mock("ai", () => ({
  experimental_generateImage: (...args: unknown[]) =>
    generateImageMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
}))

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ image: openAIImageModelMock }),
}))

jest.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => googleImageModelMock,
}))

jest.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    GetObjectCommand: MockCommand,
    PutObjectCommand: MockCommand,
    S3Client: class MockS3Client {
      send(...args: unknown[]) {
        return s3SendMock(...args)
      }
    },
  }
})

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...args),
}))

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getGoogleAI: jest.fn(async () => "google-key"),
    getOpenAI: jest.fn(async () => "openai-key"),
    getS3: jest.fn(async () => ({ region: "us-west-2" })),
  },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "request-1",
}))

jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    sysConfigurationError: (message: string) => new Error(message),
  },
}))

import { generateImageForNexus } from "@/lib/ai/image-generation-service"

describe("image generation provider pipelines", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openAIImageModelMock.mockReturnValue({ provider: "openai-image-model" })
    googleImageModelMock.mockReturnValue({ provider: "google-image-model" })
    s3SendMock.mockResolvedValue({})
    getSignedUrlMock.mockResolvedValue("https://signed.example/image")
  })

  it("preserves OpenAI defaults and stores returned base64 image bytes", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ base64: Buffer.from("openai-image").toString("base64") }],
    })

    const result = await generateImageForNexus({
      prompt: "Draw a lighthouse",
      modelId: "gpt-image-1.5",
      provider: "openai",
      conversationId: "conversation-1",
      userId: "user-1",
    })

    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "openai-image-model" },
        prompt: "Draw a lighthouse",
        size: "1024x1024",
        providerOptions: {
          openai: { output_format: "png", quality: "medium" },
        },
      })
    )
    const putCommand = s3SendMock.mock.calls[0][0] as {
      input: { Body: Buffer; ContentType: string }
    }
    expect(putCommand.input.Body.toString()).toBe("openai-image")
    expect(putCommand.input.ContentType).toBe("image/png")
    expect(result).toMatchObject({
      imageUrl: "https://signed.example/image",
      provider: "openai",
      model: "gpt-image-1.5",
      dimensions: { width: 1024, height: 1024 },
    })
  })

  it("preserves Gemini reference-image content and result media type", async () => {
    generateTextMock.mockResolvedValue({
      text: "A watercolor lighthouse",
      files: [
        {
          uint8Array: new TextEncoder().encode("gemini-image"),
          mediaType: "image/webp",
        },
      ],
    })

    const result = await generateImageForNexus({
      prompt: "Restyle this image",
      modelId: "gemini-2.5-flash-image",
      provider: "google",
      conversationId: "conversation-2",
      userId: "user-2",
      referenceImages: [
        {
          base64: `data:image/jpeg;base64,${Buffer.from("reference").toString("base64")}`,
        },
      ],
    })

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "google-image-model" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: Buffer.from("reference").toString("base64"),
                mimeType: "image/jpeg",
              },
              { type: "text", text: "Restyle this image" },
            ],
          },
        ],
        providerOptions: {
          google: { responseModalities: ["TEXT", "IMAGE"] },
        },
      })
    )
    const putCommand = s3SendMock.mock.calls[0][0] as {
      input: { Body: Buffer; ContentType: string }
    }
    expect(putCommand.input.Body.toString()).toBe("gemini-image")
    expect(putCommand.input.ContentType).toBe("image/webp")
    expect(result).toMatchObject({
      imageUrl: "https://signed.example/image",
      provider: "google",
      model: "gemini-2.5-flash-image",
      altText: "A watercolor lighthouse",
    })
  })
})
