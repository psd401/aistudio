/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import {
  buildImageSearchDocument,
  IMAGE_PROCESSOR_VERSION,
  imageArtifactObjectKey,
  isImageContentType,
  prepareRepositoryImage,
} from "@/lib/repositories/content-platform/image-processing";

const goldenPng = Buffer.from(
  fs
    .readFileSync(
      path.join(
        process.cwd(),
        "tests/fixtures/unified-content/images/red-pixel.png.base64"
      ),
      "utf8"
    )
    .trim(),
  "base64"
);

describe("canonical image processing", () => {
  it("recognizes the deliberately bounded image format allowlist", () => {
    expect(isImageContentType("image/jpeg")).toBe(true);
    expect(isImageContentType("image/png")).toBe(true);
    expect(isImageContentType("image/webp")).toBe(true);
    expect(isImageContentType("image/gif")).toBe(true);
    expect(isImageContentType("image/tiff")).toBe(true);
    expect(isImageContentType("image/svg+xml")).toBe(false);
  });

  it("inspects a golden image and emits bounded JPEG derivatives", async () => {
    const result = await prepareRepositoryImage(goldenPng, "image/png");

    expect(result).toMatchObject({
      detectedContentType: "image/png",
      width: 4,
      height: 3,
      frameCount: 1,
    });
    expect(Buffer.from(result.thumbnail).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8])
    );
    expect(result.captionImage.byteLength).toBeLessThanOrEqual(4_500_000);
    expect(result.ocrImage.byteLength).toBeLessThanOrEqual(9_500_000);
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.thumbnailSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a declared type that disagrees with the byte signature", async () => {
    await expect(
      prepareRepositoryImage(goldenPng, "image/jpeg")
    ).rejects.toThrow("does not match declared type");
  });

  it("builds caption and OCR segments with exact normalized regions", () => {
    const document = buildImageSearchDocument({
      caption: "A school evacuation map with two marked exits.",
      ocrLines: [
        {
          text: "EXIT A",
          region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        },
        {
          text: "EXIT B",
          region: { x: 0.6, y: 0.7, width: 0.3, height: 0.1 },
        },
      ],
      width: 1_600,
      height: 900,
      detectedContentType: "image/png",
    });

    expect(document.canonicalText).toContain("<!-- image:description -->");
    expect(document.canonicalText).toContain("<!-- image:ocr -->");
    expect(document.ocrText).toBe("EXIT A\nEXIT B");
    expect(document.segments).toHaveLength(2);
    expect(document.segments.every((segment) => segment.modality === "image"))
      .toBe(true);
    expect(document.segments[1]?.sourceLocator.regions).toHaveLength(2);
    expect(
      document.segments.every((segment) => /^[0-9a-f]{64}$/.test(segment.contentHash))
    ).toBe(true);
  });

  it("keeps an image searchable when neither OCR nor a caption is available", () => {
    const document = buildImageSearchDocument({
      caption: "",
      ocrLines: [],
      width: 320,
      height: 200,
      detectedContentType: "image/gif",
    });
    expect(document.segments).toHaveLength(1);
    expect(document.segments[0]?.content).toContain("320 by 200 pixels");
  });

  it("creates deterministic repository-scoped derivative keys", () => {
    expect(
      imageArtifactObjectKey(
        7,
        "11111111-2222-4333-8444-555555555555",
        "thumbnail.jpg"
      )
    ).toBe(
      `repositories/7/artifacts/11111111-2222-4333-8444-555555555555/${IMAGE_PROCESSOR_VERSION}/thumbnail.jpg`
    );
    expect(() => imageArtifactObjectKey(0, "not-a-version", "ocr-source.jpg"))
      .toThrow();
  });
});
