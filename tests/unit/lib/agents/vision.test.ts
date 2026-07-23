/**
 * Agentic image / vision input handling (Issue #926).
 */
import { detectImageInput, extractImageInputParts } from "@/lib/agents/vision";

describe("detectImageInput", () => {
  it("detects a base64 data:image URI and reads its media type", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    expect(detectImageInput(uri)).toEqual({
      type: "file",
      mediaType: "image/png",
      url: uri,
    });
  });

  it("detects an http(s) image URL and maps the extension to a media type", () => {
    expect(detectImageInput("https://cdn.example/pic.JPG")).toEqual({
      type: "file",
      mediaType: "image/jpeg",
      url: "https://cdn.example/pic.JPG",
    });
    expect(detectImageInput("http://x.test/a.webp?token=1")?.mediaType).toBe("image/webp");
  });

  it("returns null for non-image strings and non-strings", () => {
    expect(detectImageInput("just some text")).toBeNull();
    expect(detectImageInput("https://example.com/page.html")).toBeNull();
    expect(detectImageInput("data:text/plain;base64,QQ==")).toBeNull();
    expect(detectImageInput(42)).toBeNull();
    expect(detectImageInput(null)).toBeNull();
    expect(detectImageInput({ url: "x.png" })).toBeNull();
  });
});

describe("extractImageInputParts", () => {
  it("extracts image parts from image-valued inputs, ignoring the rest", () => {
    const parts = extractImageInputParts({
      topic: "cats",
      photo: "https://cdn.example/cat.png",
      diagram: "data:image/gif;base64,R0lGOD==",
      note: "not an image",
    });
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.mediaType)).toEqual(["image/png", "image/gif"]);
  });

  it("returns an empty array when there are no image inputs", () => {
    expect(extractImageInputParts({ a: "x", b: 5 })).toEqual([]);
  });

  it("caps the number of attached images at 10", () => {
    const inputs: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) inputs[`img${i}`] = `https://cdn.example/${i}.png`;
    expect(extractImageInputParts(inputs)).toHaveLength(10);
  });
});
