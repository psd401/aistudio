/**
 * @jest-environment node
 *
 * PPTX generation orchestration (Issue #926).
 *
 * pptxgenjs is mocked here. Its real `write()` lazy-imports `node:fs`/`node:https`
 * via a fire-and-forget path that is non-deterministic under jest's module loader
 * (it produces a valid deck in the Node server runtime, but flakes in-test). So
 * this test validates the parts WE own — slide splitting on the `---` delimiter,
 * the cover slide, and the S3 storage + return contract — while treating the
 * third-party binary serialization as a black box.
 *
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */

const addText = jest.fn();
const addSlide = jest.fn(() => ({ addText }));
const write = jest.fn().mockResolvedValue(Buffer.from("PPTX-BYTES-XXXXXXXX"));
jest.mock("pptxgenjs", () => ({
  __esModule: true,
  default: class {
    addSlide = addSlide;
    write = write;
  },
}));

const sendMock = jest.fn().mockResolvedValue({});
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendMock;
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/deck"),
}));
jest.mock("@/lib/settings-manager", () => ({
  Settings: { getS3: jest.fn().mockResolvedValue({ region: "us-west-2" }) },
}));

import { generateDocument } from "@/lib/ai/document-generation-service";

describe("generateDocument (pptx orchestration)", () => {
  beforeEach(() => {
    addText.mockClear();
    addSlide.mockClear();
    write.mockClear();
    sendMock.mockClear();
  });

  it("splits slides on the --- delimiter and adds a title cover slide", async () => {
    const result = await generateDocument({
      format: "pptx",
      title: "Deck",
      content: "Slide one\nbody text\n---\nSlide two\nmore body",
      userId: "9",
    });

    // 1 cover (title present) + 2 content slides = 3 slides.
    expect(addSlide).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith({ outputType: "nodebuffer" });
    expect(result.format).toBe("pptx");
    expect(result.filename.endsWith(".pptx")).toBe(true);
    expect(result.bytes).toBe(Buffer.from("PPTX-BYTES-XXXXXXXX").length);
    expect(result.url).toBe("https://signed.example/deck");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("omits the cover slide when no title is given", async () => {
    await generateDocument({
      format: "pptx",
      content: "Only slide\nbody",
      userId: "9",
    });
    // No title => no cover slide; one content slide.
    expect(addSlide).toHaveBeenCalledTimes(1);
  });
});
