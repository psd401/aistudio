import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

describe("tool manifest immutable contract versions", () => {
  it.each([
    "assistants.execute",
    "assistants.list",
    "chat.show_chart",
    "chat.web_search",
    "chat.code_interpreter",
    "chat.generate_image",
  ])("%s publishes its current schema as v2", (identifier) => {
    expect(
      TOOL_MANIFEST.find((entry) => entry.identifier === identifier)?.version
    ).toBe("v2")
  })
})
