/**
 * #1850: phone photos inlined at full size pushed Nexus chat requests past the
 * 10MB proxied-body limit. These pin the shrink rules and the config safety net.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_IMAGE_EDGE_PX,
  MAX_UNTOUCHED_IMAGE_BYTES,
  dataUrlMediaType,
  downscaleImageDataUrl,
  planImageDownscale,
} from "../image-downscale";

describe("planImageDownscale (#1850)", () => {
  it("scales a 12MP phone JPEG to a 2048px longest edge, keeping the aspect ratio", () => {
    expect(
      planImageDownscale({ width: 4032, height: 3024, bytes: 8_000_000, mimeType: "image/jpeg" })
    ).toEqual({ width: 2048, height: 1536, mimeType: "image/jpeg" });
  });

  it("handles portrait photos", () => {
    expect(
      planImageDownscale({ width: 3024, height: 4032, bytes: 8_000_000, mimeType: "image/jpeg" })
    ).toEqual({ width: 1536, height: 2048, mimeType: "image/jpeg" });
  });

  it("re-encodes a large-in-bytes image that is already small in pixels", () => {
    expect(
      planImageDownscale({ width: 1600, height: 1200, bytes: 4_000_000, mimeType: "image/jpeg" })
    ).toEqual({ width: 1600, height: 1200, mimeType: "image/jpeg" });
  });

  it("keeps WebP as WebP so transparency is not flattened", () => {
    expect(
      planImageDownscale({ width: 4000, height: 3000, bytes: 4_000_000, mimeType: "image/webp" })
    ).toEqual({ width: 2048, height: 1536, mimeType: "image/webp" });
  });

  it("keeps PNG as PNG so transparency is not flattened", () => {
    expect(
      planImageDownscale({ width: 5000, height: 2500, bytes: 9_000_000, mimeType: "image/png" })
    ).toEqual({ width: MAX_IMAGE_EDGE_PX, height: 1024, mimeType: "image/png" });
  });

  it("leaves small images and animated GIFs untouched", () => {
    expect(
      planImageDownscale({ width: 1200, height: 900, bytes: MAX_UNTOUCHED_IMAGE_BYTES, mimeType: "image/jpeg" })
    ).toBeNull();
    expect(
      planImageDownscale({ width: 4000, height: 3000, bytes: 9_000_000, mimeType: "image/gif" })
    ).toBeNull();
  });

  it("leaves images with unknown dimensions untouched", () => {
    expect(planImageDownscale({ width: 0, height: 0, bytes: 9_000_000, mimeType: "image/jpeg" })).toBeNull();
  });
});

describe("downscaleImageDataUrl", () => {
  const original = "data:image/jpeg;base64,/9j/AAAA";
  const file = new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])], "a.jpg", { type: "image/jpeg" });

  afterEach(() => {
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  });

  it("returns the original when the browser has no createImageBitmap", async () => {
    await expect(downscaleImageDataUrl(file, original)).resolves.toBe(original);
  });

  it("returns the original when decoding the image fails (fail-open)", async () => {
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = jest
      .fn<() => Promise<ImageBitmap>>()
      .mockRejectedValue(new Error("decode failed"));
    await expect(downscaleImageDataUrl(file, original)).resolves.toBe(original);
    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(file);
  });
});

describe("dataUrlMediaType", () => {
  it("reads the declared media type", () => {
    expect(dataUrlMediaType("data:image/jpeg;base64,AAAA")).toBe("image/jpeg");
    expect(dataUrlMediaType("not a data url")).toBeNull();
  });
});

describe("next.config proxied request body limit (#1850)", () => {
  it("raises proxyClientMaxBodySize above Next's silent 10MB truncation", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo's next.config.
    const source = readFileSync(join(__dirname, "..", "..", "..", "next.config.mjs"), "utf8");
    expect(source).toMatch(/proxyClientMaxBodySize:\s*'50mb'/);
  });
});
