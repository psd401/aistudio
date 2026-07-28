import { describe, expect, it } from "@jest/globals"
import { validateModel } from "@/lib/validators/model-import-validator"

const VALID_MODEL = {
  name: "Test model",
  modelId: "test-model",
  provider: "openai",
}

describe("model import validation", () => {
  it("accepts a valid model with supported optional fields", () => {
    expect(validateModel({
      ...VALID_MODEL,
      capabilities: ["chat", "vision"],
      allowedRoles: ["administrator"],
      maxTokens: 4_096,
      active: true,
      inputCostPer1kTokens: "0.001",
    }, 0)).toEqual({ valid: true, errors: [] })
  })

  it("reports all independent field failures in one result", () => {
    const result = validateModel({
      name: " ",
      modelId: "",
      provider: "unsupported",
      description: 42,
      capabilities: ["chat", 7],
      allowedRoles: "administrator",
      maxTokens: -1,
      active: "yes",
      inputCostPer1kTokens: "-0.5",
    }, 1)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("'name' is required"),
      expect.stringContaining("'modelId' is required"),
      expect.stringContaining("Invalid provider"),
      expect.stringContaining("'description' must be a string"),
      expect.stringContaining("'capabilities' must be an array of strings"),
      expect.stringContaining("'allowedRoles' must be an array"),
      expect.stringContaining("'maxTokens' must be non-negative"),
      expect.stringContaining("'active' must be a boolean"),
      expect.stringContaining(
        "'inputCostPer1kTokens' must be a valid non-negative number"
      ),
    ]))
  })

  it("rejects non-object input with the indexed prefix", () => {
    expect(validateModel(null, 2)).toEqual({
      valid: false,
      errors: ["Model 3: Must be an object"],
    })
  })
})
