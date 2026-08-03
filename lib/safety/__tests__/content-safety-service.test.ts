const evaluateInput = jest.fn();
const evaluateOutput = jest.fn();
const guardrailsService = {
  isEnabled: jest.fn(() => true),
  evaluateInput,
  evaluateOutput,
  getConfig: jest.fn(() => ({ guardrailId: "guardrail-1" })),
};

jest.mock("../bedrock-guardrails-service", () => ({
  BedrockGuardrailsService: jest.fn(),
  getBedrockGuardrailsService: () => guardrailsService,
}));

import { ContentSafetyService } from "../content-safety-service";

describe("ContentSafetyService", () => {
  let service: ContentSafetyService;

  beforeEach(() => {
    jest.clearAllMocks();
    guardrailsService.isEnabled.mockReturnValue(true);
    evaluateInput.mockResolvedValue({
      allowed: true,
      processedContent: "ignored guardrail rewrite",
    });
    evaluateOutput.mockResolvedValue({
      allowed: true,
      processedContent: "ignored guardrail rewrite",
    });
    service = new ContentSafetyService({
      region: "us-west-2",
      guardrailId: "guardrail-1",
    });
  });

  it("passes a person's name through byte-identical on input", async () => {
    const content = "Write a greeting for Johnny Smith.";
    const result = await service.processInput(content, "session-123");

    expect(result).toMatchObject({
      allowed: true,
      processedContent: content,
      contentModified: false,
    });
    expect(evaluateInput).toHaveBeenCalledWith(content, "session-123");
  });

  it("passes output through byte-identical when guardrails allow it", async () => {
    const content = "Hello, Johnny Smith!";
    const result = await service.processOutput(
      content,
      "gpt-5",
      "openai",
      "session-123",
    );

    expect(result).toMatchObject({
      allowed: true,
      processedContent: content,
      contentModified: false,
    });
  });

  it("preserves the input guardrail block contract", async () => {
    evaluateInput.mockResolvedValue({
      allowed: false,
      processedContent: "",
      blockedReason: "HATE",
      blockedMessage: "Blocked input",
      blockedCategories: ["HATE"],
    });

    await expect(service.processInput("blocked", "session-123")).resolves.toMatchObject({
      allowed: false,
      blockedMessage: "Blocked input",
      blockedCategories: ["HATE"],
      contentModified: false,
    });
  });

  it("preserves the output guardrail block contract", async () => {
    evaluateOutput.mockResolvedValue({
      allowed: false,
      processedContent: "",
      blockedReason: "HATE",
      blockedMessage: "Blocked output",
      blockedCategories: ["HATE"],
    });

    await expect(
      service.processOutput("blocked", "gpt-5", "openai", "session-123"),
    ).resolves.toMatchObject({
      allowed: false,
      blockedMessage: "Blocked output",
      blockedCategories: ["HATE"],
      contentModified: false,
    });
  });

  it("reports guardrails-only status", () => {
    expect(service.getStatus()).toEqual({
      guardrailsEnabled: true,
      guardrailsConfig: { guardrailId: "guardrail-1" },
    });
  });
});
