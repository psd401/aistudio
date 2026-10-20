/**
 * #1900 — a generated image's markdown carries its real description as alt
 * text, so screen readers and the "Image unavailable" fallback name the
 * picture instead of announcing a fixed "Generated Image" placeholder.
 */
import { generatedImageMarkdown } from "@/lib/nexus/generated-image-markdown"

describe("generatedImageMarkdown", () => {
  it("uses the image's description as its alt text", () => {
    expect(generatedImageMarkdown("/api/images/k.png", "A cat in a hat")).toBe(
      "![A cat in a hat](/api/images/k.png)",
    )
  })

  it("keeps the placeholder when there is no description", () => {
    expect(generatedImageMarkdown("/x.png")).toBe("![Generated Image](/x.png)")
    expect(generatedImageMarkdown("/x.png", "  \n ")).toBe("![Generated Image](/x.png)")
  })

  it("collapses whitespace so a multi-line description stays one label", () => {
    expect(generatedImageMarkdown("/x.png", "A cat\n\nin a  hat")).toBe(
      "![A cat in a hat](/x.png)",
    )
  })

  it("escapes brackets and backslashes that would break the label", () => {
    expect(generatedImageMarkdown("/x.png", "a [b] c\\d")).toBe(
      "![a \\[b\\] c\\\\d](/x.png)",
    )
  })

  it("clips a long description without splitting an emoji", () => {
    const description = `${"a".repeat(123)}👩‍👩‍👧 trailing words`
    const markdown = generatedImageMarkdown("/x.png", description)
    const alt = markdown.slice(2, markdown.indexOf("](/x.png)"))

    expect(alt).toBe(`${"a".repeat(123)}👩‍👩‍👧…`)
  })
})
