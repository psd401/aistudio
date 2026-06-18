/**
 * @jest-environment node
 *
 * Agent `images.generate` tool (Issue #926): image-model resolution, delegation
 * to the existing image service, and error mapping. Uses the global `jest`.
 */

// Mock with inline jest.fn() (no out-of-scope ref — avoids the hoist TDZ), then
// grab the mocks back via the mocked module (documented jest+ESM learning).
jest.mock("@/lib/db/drizzle/ai-models", () => ({ getAIModels: jest.fn() }));
jest.mock("@/lib/ai/image-generation-service", () => ({
  generateImageForNexus: jest.fn(),
}));

import { handleGenerateImage } from "@/lib/agents/agent-tools/image-generate";
import { getAIModels } from "@/lib/db/drizzle/ai-models";
import { generateImageForNexus } from "@/lib/ai/image-generation-service";
import type { McpToolContext } from "@/lib/mcp/types";

const getAIModelsMock = getAIModels as jest.Mock;
const generateImageMock = generateImageForNexus as jest.Mock;

const ctx: McpToolContext = {
  userId: 7,
  cognitoSub: "sub",
  scopes: ["chat:write"],
  requestId: "req-img",
};

const imageModel = {
  active: true,
  provider: "openai",
  modelId: "gpt-image-1",
  // capabilities is stored as a JSON array string in ai_models.
  capabilities: '["image_generation"]',
};

describe("handleGenerateImage", () => {
  beforeEach(() => {
    getAIModelsMock.mockReset();
    generateImageMock.mockReset();
  });

  it("errors on a missing prompt", async () => {
    const res = await handleGenerateImage({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Missing required field: prompt/);
  });

  it("errors when no image-capable model is configured", async () => {
    getAIModelsMock.mockResolvedValue([
      { active: true, provider: "openai", modelId: "gpt-4", capabilities: '["reasoning"]' },
    ]);
    const res = await handleGenerateImage({ prompt: "a cat" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no image-capable model/);
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("generates an image via the configured model", async () => {
    getAIModelsMock.mockResolvedValue([imageModel]);
    generateImageMock.mockResolvedValue({
      imageUrl: "https://s3.example/img.png",
      s3Key: "v2/generated-images/agent-req-img/abc.png",
      provider: "openai",
      model: "gpt-image-1",
    });

    const res = await handleGenerateImage({ prompt: "a cat", size: "1024x1024" }, ctx);
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.imageUrl).toBe("https://s3.example/img.png");
    expect(payload.model).toBe("gpt-image-1");
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a cat",
        provider: "openai",
        modelId: "gpt-image-1",
        userId: "7",
        size: "1024x1024",
      })
    );
  });

  it("maps a typed image-service error to a tool error result", async () => {
    getAIModelsMock.mockResolvedValue([imageModel]);
    generateImageMock.mockRejectedValue({
      type: "CONTENT_POLICY",
      message: "blocked by policy",
    });
    const res = await handleGenerateImage({ prompt: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/blocked by policy/);
  });
});
