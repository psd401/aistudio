import { beforeEach, describe, expect, it } from "@jest/globals";

/* eslint-disable no-var */
var mockGetAIModelById: jest.Mock;
var mockGetArchitectEnabledModels: jest.Mock;
var mockGetAvailableToolsForModel: jest.Mock;
var mockGetAllTools: jest.Mock;
var mockFilterAccessibleResourceIds: jest.Mock;
/* eslint-enable no-var */

mockGetAIModelById = jest.fn();
mockGetArchitectEnabledModels = jest.fn();
mockGetAvailableToolsForModel = jest.fn();
mockGetAllTools = jest.fn();
mockFilterAccessibleResourceIds = jest.fn();

jest.mock("@/lib/db/drizzle/ai-models", () => ({
  getAIModelById: (...args: unknown[]) => mockGetAIModelById(...args),
  getArchitectEnabledModels: (...args: unknown[]) =>
    mockGetArchitectEnabledModels(...args),
}));

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) =>
    mockFilterAccessibleResourceIds(...args),
}));

jest.mock("@/lib/tools/tool-registry", () => ({
  getAvailableToolsForModel: (...args: unknown[]) =>
    mockGetAvailableToolsForModel(...args),
  getAllTools: (...args: unknown[]) => mockGetAllTools(...args),
}));

jest.mock("@/lib/ai/model-router/core", () => ({
  inferModelFamily: jest.fn(() => "openai"),
  isExecutableTextModel: jest.fn(() => true),
  modelSupportsProviderNativeTool: jest.fn(() => true),
}));

import { validatePromptToolsForRouting } from "@/lib/assistant-architect/prompt-tool-validation";

describe("validatePromptToolsForRouting", () => {
  beforeEach(() => {
    mockGetAIModelById.mockReset();
    mockGetArchitectEnabledModels.mockReset();
    mockGetAvailableToolsForModel.mockReset();
    mockGetAllTools.mockReset();
    mockFilterAccessibleResourceIds.mockReset();
    mockGetAIModelById.mockResolvedValue({
      id: 91,
      modelId: "gpt-source",
      active: true,
    });
    mockGetAvailableToolsForModel.mockResolvedValue([
      { name: "web_search" },
    ]);
    mockGetAllTools.mockReturnValue([{ name: "web_search" }]);
  });

  it("accepts a registered tool supported by the mapped legacy model", async () => {
    await expect(
      validatePromptToolsForRouting(
        ["web_search"],
        { modelRoutingMode: "legacy", modelRoutingFamily: null },
        7,
        91,
      ),
    ).resolves.toEqual({ isValid: true, invalidTools: [] });
  });

  it("rejects an unknown imported prompt tool", async () => {
    const result = await validatePromptToolsForRouting(
      ["unknown_tool"],
      { modelRoutingMode: "legacy", modelRoutingFamily: null },
      7,
      91,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidTools: ["unknown_tool"],
      message: "Unknown tools: unknown_tool",
    });
  });

  it("rejects a known tool unavailable to the mapped legacy model", async () => {
    mockGetAllTools.mockReturnValue([
      { name: "web_search" },
      { name: "image_generate" },
    ]);

    const result = await validatePromptToolsForRouting(
      ["image_generate"],
      { modelRoutingMode: "legacy", modelRoutingFamily: null },
      7,
      91,
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidTools: ["image_generate"],
      message: "Tools not supported by this model: image_generate",
    });
  });

  it("does not expose dependency errors through validation results", async () => {
    mockGetAIModelById.mockRejectedValue(
      new Error("postgres://internal-host/private_schema"),
    );

    const result = await validatePromptToolsForRouting(
      ["web_search"],
      { modelRoutingMode: "legacy", modelRoutingFamily: null },
      7,
      91,
    );

    expect(result).toEqual({
      isValid: false,
      invalidTools: ["web_search"],
      message: "Unable to validate prompt tools",
    });
    expect(result.message).not.toContain("internal-host");
  });
});
