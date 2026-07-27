import { describe, expect, it } from "@jest/globals"
import { getModelSelectorButtonText } from "@/components/features/model-selector/model-selector-label"

describe("model selector button label", () => {
  it("shows the selected model name", () => {
    expect(
      getModelSelectorButtonText({ name: "GPT Test" }, 0, 10, "Choose")
    ).toBe("GPT Test")
  })

  it("distinguishes an inaccessible result set from an empty one", () => {
    expect(getModelSelectorButtonText(null, 0, 2, "Choose")).toBe(
      "No accessible models"
    )
    expect(getModelSelectorButtonText(null, 0, 0, "Choose")).toBe("Choose")
  })
})
