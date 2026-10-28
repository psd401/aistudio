/** @jest-environment node */

const interactionCreateMock = jest.fn()
const interactionGetMock = jest.fn()
const interactionCancelMock = jest.fn()
const getGoogleAiMock = jest.fn()
const loggerWarnMock = jest.fn()
const googleGenAiCtor = jest.fn()
const readVertexWifConfigMock = jest.fn()
const getVertexWifAuthClientMock = jest.fn()

jest.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(options: unknown) {
      googleGenAiCtor(options)
    }
    interactions = {
      create: (...args: unknown[]) => interactionCreateMock(...args),
      get: (...args: unknown[]) => interactionGetMock(...args),
      cancel: (...args: unknown[]) => interactionCancelMock(...args),
    }
  },
}))

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getGoogleAI: (...args: unknown[]) => getGoogleAiMock(...args),
  },
}))

jest.mock("@/lib/ai/google-vertex-wif", () => ({
  VERTEX_INTERACTIONS_LOCATION: "global",
  readVertexWifConfig: (...args: unknown[]) => readVertexWifConfigMock(...args),
  getVertexWifAuthClient: (...args: unknown[]) => getVertexWifAuthClientMock(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-test",
}))

jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    sysConfigurationError: (message: string) => new Error(message),
  },
}))

import {
  cancelDeepResearchInteraction,
  createDeepResearchInteraction,
  getDeepResearchInteraction,
  mapInteractionError,
} from "@/lib/ai/gemini-deep-research-service"

beforeEach(() => {
  jest.clearAllMocks()
  getGoogleAiMock.mockResolvedValue("google-api-key")
  readVertexWifConfigMock.mockReturnValue(null)
})

describe("Gemini Deep Research client auth", () => {
  it("uses Vertex AI with the WIF auth client and never reads the API key when configured", async () => {
    const config = {
      audience: "aud",
      serviceAccountEmail: "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com",
      projectId: "psd-aistudio-dev",
      region: "us-east-1",
    }
    const authClient = { kind: "wif" }
    readVertexWifConfigMock.mockReturnValue(config)
    getVertexWifAuthClientMock.mockReturnValue(authClient)
    interactionCreateMock.mockResolvedValueOnce({ id: "i-1", status: "in_progress" })

    await createDeepResearchInteraction("prompt", "deep-research-preview-04-2026")

    expect(googleGenAiCtor).toHaveBeenCalledWith({
      vertexai: true,
      project: "psd-aistudio-dev",
      location: "global",
      googleAuthOptions: { authClient },
    })
    expect(getVertexWifAuthClientMock).toHaveBeenCalledWith(config)
    expect(getGoogleAiMock).not.toHaveBeenCalled()
  })

  it("falls back to the Gemini API key only when Vertex is not configured", async () => {
    interactionCreateMock.mockResolvedValueOnce({ id: "i-1", status: "in_progress" })

    await createDeepResearchInteraction("prompt", "deep-research-preview-04-2026")

    expect(googleGenAiCtor).toHaveBeenCalledWith({ apiKey: "google-api-key" })
  })

  it("fails closed when the Vertex config is partial", async () => {
    readVertexWifConfigMock.mockImplementation(() => {
      throw new Error("Vertex AI auth is partly configured; missing GOOGLE_VERTEX_PROJECT_ID")
    })

    await expect(createDeepResearchInteraction("prompt", "m")).rejects.toThrow("partly configured")
    expect(getGoogleAiMock).not.toHaveBeenCalled()
  })
})

describe("Gemini Deep Research split lifecycle", () => {
  it("starts one background interaction with the resolved model id", async () => {
    interactionCreateMock.mockResolvedValueOnce({
      id: "interaction-1",
      status: "in_progress",
    })

    await expect(
      createDeepResearchInteraction(
        "Research later school start times",
        "model-from-database"
      )
    ).resolves.toEqual({
      interactionId: "interaction-1",
      status: "in_progress",
    })
    expect(interactionCreateMock).toHaveBeenCalledWith({
      input: "Research later school start times",
      agent: "model-from-database",
      background: true,
    })
  })

  it("flattens completed model-output steps and keeps only safe citations", async () => {
    interactionGetMock.mockResolvedValueOnce({
      id: "interaction-1",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: "First section",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.org/source",
                  title: "Safe source",
                },
                {
                  type: "url_citation",
                  url: "javascript:alert(1)",
                  title: "Unsafe source",
                },
              ],
            },
          ],
        },
        {
          type: "tool_output",
          content: [{ type: "text", text: "Ignored tool output" }],
        },
        {
          type: "model_output",
          content: [{ type: "text", text: "Second section" }],
        },
      ],
    })

    await expect(
      getDeepResearchInteraction("interaction-1")
    ).resolves.toEqual({
      interactionId: "interaction-1",
      status: "completed",
      report: "First section\n\nSecond section",
      citations: [
        {
          url: "https://example.org/source",
          title: "Safe source",
          startIndex: undefined,
          endIndex: undefined,
        },
      ],
    })
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Skipping citation with unsafe URL scheme",
      { url: "javascript:alert(1)" }
    )
  })

  it("returns a short snapshot for a non-terminal interaction", async () => {
    interactionGetMock.mockResolvedValueOnce({
      id: "interaction-1",
      status: "in_progress",
      steps: [],
    })

    await expect(
      getDeepResearchInteraction("interaction-1")
    ).resolves.toEqual({
      interactionId: "interaction-1",
      status: "in_progress",
    })
  })

  it("cancels one background interaction", async () => {
    interactionCancelMock.mockResolvedValueOnce(undefined)

    await expect(
      cancelDeepResearchInteraction("interaction-1")
    ).resolves.toBeUndefined()
    expect(interactionCancelMock).toHaveBeenCalledWith("interaction-1")
  })

  it("preserves an already classified interaction error", () => {
    const classified = Object.assign(new Error("Google authentication failed."), {
      type: "AUTHENTICATION" as const,
    })

    expect(mapInteractionError(classified)).toBe(classified)
  })
})
