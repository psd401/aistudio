/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  CONTENT_ASSET_PROCESSOR_VERSION,
  normalizeContentAsset,
} from "@/lib/content/asset-image";
import { ValidationError } from "@/lib/content/errors";

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

describe("Atrium authored raster normalization (#1284)", () => {
  it("decodes and emits a deterministic, metadata-free PNG", async () => {
    const withMetadata = await sharp(goldenPng)
      .withMetadata({
        exif: { IFD0: { Copyright: "private capture metadata" } },
      })
      .png()
      .toBuffer();
    const first = await normalizeContentAsset({
      source: withMetadata,
      declaredContentType: "image/png",
      declaredWidth: 4,
      declaredHeight: 3,
    });
    const second = await normalizeContentAsset({
      source: withMetadata,
      declaredContentType: "image/png",
    });
    const metadata = await sharp(first.bytes).metadata();

    expect(CONTENT_ASSET_PROCESSOR_VERSION).toBe(
      "atrium-image-normalize-v1"
    );
    expect(first).toMatchObject({
      contentType: "image/png",
      width: 4,
      height: 3,
      sha256: second.sha256,
    });
    expect(Buffer.from(first.bytes)).toEqual(Buffer.from(second.bytes));
    expect(metadata.comments).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it("rejects a declared MIME type that disagrees with the byte signature", async () => {
    await expect(
      normalizeContentAsset({
        source: goldenPng,
        declaredContentType: "image/jpeg",
      })
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { rejectionCode: "MIME_SIGNATURE_MISMATCH" },
    });
  });

  it("rejects undecodable bytes and incorrect declared dimensions", async () => {
    await expect(
      normalizeContentAsset({
        source: Buffer.from("<svg onload=alert(1)>"),
        declaredContentType: "image/png",
      })
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { rejectionCode: "IMAGE_DECODE_FAILED" },
    });
    await expect(
      normalizeContentAsset({
        source: goldenPng,
        declaredContentType: "image/png",
        declaredWidth: 5,
        declaredHeight: 3,
      })
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { rejectionCode: "DIMENSION_MISMATCH" },
    });
  });

  it("rejects oversized dimensions and compressed pixel bombs", async () => {
    const overDimension = await sharp({
      create: {
        width: 12_001,
        height: 1,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();
    await expect(
      normalizeContentAsset({
        source: overDimension,
        declaredContentType: "image/png",
      })
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { rejectionCode: "PIXEL_LIMIT_EXCEEDED" },
    });

    const compressedPixelBomb = await sharp({
      create: {
        width: 6_500,
        height: 6_500,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(compressedPixelBomb.byteLength).toBeLessThan(200_000);
    await expect(
      normalizeContentAsset({
        source: compressedPixelBomb,
        declaredContentType: "image/png",
      })
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { rejectionCode: "IMAGE_DECODE_FAILED" },
    });
  });
});
