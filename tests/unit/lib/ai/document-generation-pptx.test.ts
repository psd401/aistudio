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

// `markdownToSlides` imports `marked`, which is pure ESM and NOT jest-loadable
// here (next/jest overrides transformIgnorePatterns — the same constraint
// documented for lib/content/render/markdown-render.ts in jest.config.js). The
// markdown -> slide semantics (heading and `---` boundaries, bullets per line)
// are covered by tests/smoke/nexus-document-markdown.smoke.ts under Bun. This
// file owns the ORCHESTRATION: cover slide, one title + bullet block per slide,
// and the S3 storage + return contract.
const markdownToSlides = jest.fn();
jest.mock("@/lib/ai/markdown-blocks", () => ({
  markdownToSlides: (...args: unknown[]) => markdownToSlides(...args),
}));

import { generateDocument } from "@/lib/ai/document-generation-service";

describe("generateDocument (pptx orchestration)", () => {
  beforeEach(() => {
    addText.mockClear();
    addSlide.mockClear();
    write.mockClear();
    sendMock.mockClear();
    markdownToSlides.mockReset();
  });

  it("adds a cover slide plus one slide per parsed slide spec", async () => {
    markdownToSlides.mockReturnValue([
      { title: "Slide one", bullets: ["body text"] },
      { title: "Slide two", bullets: ["more body"] },
    ]);

    const result = await generateDocument({
      format: "pptx",
      title: "Deck",
      content: "## Slide one\n\nbody text\n\n## Slide two\n\nmore body",
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

  it("gives each slide a bold title and its bullets as real bullet points (#1898)", async () => {
    markdownToSlides.mockReturnValue([
      { title: "Why it matters", bullets: ["First point", "Second point"] },
    ]);

    await generateDocument({
      format: "pptx",
      content: "## Why it matters\n\n- First point\n- Second point",
      userId: "9",
    });

    // Title text object: bold, drawn at the top of the slide.
    expect(addText).toHaveBeenCalledWith(
      "Why it matters",
      expect.objectContaining({ bold: true })
    );
    // Bullets: separate text objects with `bullet: true`, NOT one newline-joined
    // block (which is what made every previous deck a wall of text).
    expect(addText).toHaveBeenCalledWith(
      [
        { text: "First point", options: { bullet: true } },
        { text: "Second point", options: { bullet: true } },
      ],
      expect.objectContaining({ fontSize: 16 })
    );
  });

  it("omits the cover slide when no title is given", async () => {
    markdownToSlides.mockReturnValue([{ title: "Only slide", bullets: ["body"] }]);
    await generateDocument({
      format: "pptx",
      content: "Only slide\nbody",
      userId: "9",
    });
    // No title => no cover slide; one content slide.
    expect(addSlide).toHaveBeenCalledTimes(1);
  });

  it("still produces a one-slide deck when the body parses to nothing", async () => {
    markdownToSlides.mockReturnValue([]);
    const result = await generateDocument({
      format: "pptx",
      content: "   ",
      userId: "9",
    });
    // A pptx with zero slides is not a valid deck.
    expect(addSlide).toHaveBeenCalledTimes(1);
    expect(result.bytes).toBeGreaterThan(0);
  });
});
