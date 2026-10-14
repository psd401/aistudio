/** @jest-environment node */

/**
 * The contents rule for public links (#1886).
 *
 * The cases here are the ones the issue was written from: a roster CSV and a
 * staff phone list must be refused, a flyer whose only contact detail is the
 * school's own phone number must NOT be, and a binary image must pass without
 * being read at all.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it, jest } from "@jest/globals"

import {
  assertPublicArtifactScannable,
  decodeTextForScan,
  MAX_PERSONAL_DATA_SCAN_BYTES,
  scanPublicArtifactForPersonalData,
} from "@/lib/agent-workspace/public-artifact-personal-data"
import {
  detectPersonalDataKinds,
  TEXT_EXTRACTABLE_EXTENSIONS,
  textExtractionFor,
} from "@/lib/safety/personal-data-scan"

// Shared with the CJS (chat-chart) and Python (psd-tts) loaders' suites.
const SHARED_CASES = (
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "..", "fixtures", "personal-data-cases.json"),
      "utf8"
    )
  ) as { cases: Array<{ name: string; text: string; publicFile: string[] }> }
).cases

function utf8Upload(
  fileName: string,
  contentType: string,
  body: string,
  readBytes?: (maxBytes: number) => Promise<Uint8Array>
) {
  const bytes = new TextEncoder().encode(body)
  return {
    fileName,
    contentType,
    byteLength: bytes.byteLength,
    readBytes: readBytes ?? (async () => bytes),
  }
}

describe("public-file personal-data rule", () => {
  it("refuses a roster CSV of student IDs", async () => {
    const result = await scanPublicArtifactForPersonalData(
      utf8Upload(
        "roster.csv",
        "text/csv",
        [
          "student_id,last,first,grade",
          "2240393,Garcia,Maria,7",
          "2187654,Nguyen,Liam,7",
          "2203311,Okafor,Ada,8",
        ].join("\n")
      )
    )
    expect(result).toEqual({ refused: true, kinds: ["psd-student-id"] })
  })

  it("refuses a substitute contact list of phone numbers and emails", async () => {
    const result = await scanPublicArtifactForPersonalData(
      utf8Upload(
        "subs.csv",
        "text/csv",
        [
          "name,phone,email",
          "A. Hall,253-555-0147,ahall@psd401.net",
          "B. Reyes,253-555-0192,breyes@psd401.net",
          "C. Doyle,(253) 555-0233,cdoyle@psd401.net",
        ].join("\n")
      )
    )
    expect(result.refused).toBe(true)
    // Both kinds, named — and the numbers themselves nowhere in the result.
    expect(result).toEqual({ refused: true, kinds: ["email", "us-phone"] })
    expect(JSON.stringify(result)).not.toContain("555")
  })

  it("allows a flyer PDF whose only contact detail is the school's own number", async () => {
    const readPdfText = jest.fn(async () => ({
      pages: [
        {
          page: 1,
          text:
            "Harbor Ridge Middle School Open House\n" +
            "Thursday 6:00pm in the commons. Families welcome.\n" +
            "Questions? Call the front office at 253-530-1000.",
        },
      ],
      needsOcrPages: [],
    }))
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("flyer.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText,
    })
    expect(result).toEqual({ refused: false, scanned: true })
    expect(readPdfText).toHaveBeenCalledTimes(1)
  })

  it("refuses a flyer PDF once a second contact detail turns it into a list", async () => {
    // The allowance above is for ONE contact detail, not for PDFs.
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("flyer.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText: async () => ({
        pages: [
          { page: 1, text: "Call 253-530-1000" },
          { page: 2, text: "or Mrs Hall directly on 253-555-0147" },
        ],
        needsOcrPages: [],
      }),
    })
    expect(result).toEqual({ refused: true, kinds: ["us-phone"] })
  })

  it("passes a binary image through without reading it", async () => {
    const readBytes = jest.fn(async () => new Uint8Array())
    const result = await scanPublicArtifactForPersonalData({
      fileName: "chart.png",
      contentType: "image/png",
      byteLength: 4096,
      readBytes,
    })
    expect(result).toEqual({
      refused: false,
      scanned: false,
      reason: "not-text-extractable",
    })
    // The point: no fetch of the object at all, not merely no refusal.
    expect(readBytes).not.toHaveBeenCalled()
  })

  it("treats one repeated school number as one number, not a list", async () => {
    // Distinct values, not occurrences: a header and a footer carrying the
    // same front-office number is still a flyer.
    const result = await scanPublicArtifactForPersonalData(
      utf8Upload(
        "notice.md",
        "text/markdown",
        "# Notice\n\nCall 253-530-1000.\n\nFooter: 253-530-1000\n"
      )
    )
    expect(result).toEqual({ refused: false, scanned: true })
  })

  it("refuses a single SSN or student ID, with no list threshold", async () => {
    await expect(
      scanPublicArtifactForPersonalData(
        utf8Upload("note.txt", "text/plain", "SSN on file: 123-45-6789")
      )
    ).resolves.toEqual({ refused: true, kinds: ["ssn"] })
    await expect(
      scanPublicArtifactForPersonalData(
        utf8Upload("note.txt", "text/plain", "see student 2240393 for details")
      )
    ).resolves.toEqual({ refused: true, kinds: ["psd-student-id"] })
  })


  it("reads a UTF-16 spreadsheet export, with or without a byte-order mark", async () => {
    // Read as UTF-8, every character comes out NUL-separated and nothing
    // matches — a UTF-16 roster would publish as clean.
    const roster = "student_id,last\n2240393,Garcia\n"
    const littleEndian = Uint8Array.from(Buffer.from(roster, "utf16le"))
    const bigEndian = Uint8Array.from(littleEndian)
    for (let index = 0; index + 1 < bigEndian.length; index += 2) {
      ;[bigEndian[index], bigEndian[index + 1]] = [
        bigEndian[index + 1]!,
        bigEndian[index]!,
      ]
    }
    for (const bytes of [
      Uint8Array.from([0xFF, 0xFE, ...littleEndian]),
      Uint8Array.from([0xFE, 0xFF, ...bigEndian]),
      littleEndian,
      bigEndian,
    ]) {
      const result = await scanPublicArtifactForPersonalData({
        fileName: "roster.csv",
        contentType: "text/csv",
        byteLength: bytes.byteLength,
        readBytes: async () => bytes,
      })
      expect(result).toEqual({ refused: true, kinds: ["psd-student-id"] })
    }
  })

  it("still reads plain UTF-8 text that happens to contain a stray NUL", async () => {
    const bytes = new TextEncoder().encode("note\u0000 student 2240393 moved")
    expect(decodeTextForScan(bytes)).toContain("2240393")
  })

  it("reads an SVG's text: a <text> element can carry a roster", async () => {
    const result = await scanPublicArtifactForPersonalData(
      utf8Upload(
        "seating.svg",
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Garcia 2240393</text></svg>'
      )
    )
    expect(result).toEqual({ refused: true, kinds: ["psd-student-id"] })
  })
})

// A file the check cannot read in full is allowed, but never reported as a
// clean scan — "nothing was found" and "nothing was looked at" must differ.
describe("public-file rule on files it cannot fully read", () => {
  it("allows a PDF the parser cannot read, and says it was not scanned", async () => {
    // Deliberate: a parser error is not evidence of personal data, and the
    // risk #1886 names is false positives blocking legitimate public flyers.
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("encrypted.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText: async () => {
        const error = new Error("Incorrect Password: Garcia-2240393")
        error.name = "PasswordException"
        throw error
      },
    })
    expect(result).toEqual({
      refused: false,
      scanned: false,
      reason: "unreadable",
      // The parser's error CLASS, so a bug in our extraction is visible in the
      // log — and never its message, which pdf.js can fill from the file.
      parserError: "PasswordException",
    })
  })

  it("does not call a scanned-image PDF clean: its image pages were not read", async () => {
    // A photographed seating chart parses fine and yields no text. Before
    // this, it came back `scanned: true` — the same line as a clean flyer.
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("seating.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText: async () => ({
        pages: [{ page: 1, text: "" }],
        needsOcrPages: [1],
      }),
    })
    expect(result).toEqual({
      refused: false,
      scanned: false,
      reason: "needs-ocr",
    })
  })

  it("still refuses a PDF whose text pages carry personal data beside image pages", async () => {
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("mixed.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText: async () => ({
        pages: [
          { page: 1, text: "Roster: 2240393 Garcia" },
          { page: 2, text: "" },
        ],
        needsOcrPages: [2],
      }),
    })
    expect(result).toEqual({ refused: true, kinds: ["psd-student-id"] })
  })

  it("refuses, rather than partly reads, a file past the scan budget", async () => {
    // Publish admission refuses these first; this is the fail-closed backstop
    // if that is ever bypassed. Padding a roster past the read window must
    // not get it a public link.
    const readBytes = jest.fn(async () => new TextEncoder().encode("id\n1\n"))
    for (const [fileName, contentType] of [
      ["huge.pdf", "application/pdf"],
      ["big.csv", "text/csv"],
    ] as const) {
      await expect(
        scanPublicArtifactForPersonalData({
          fileName,
          contentType,
          byteLength: MAX_PERSONAL_DATA_SCAN_BYTES + 1,
          readBytes,
        })
      ).rejects.toThrow(/scan budget/)
    }
    expect(readBytes).not.toHaveBeenCalled()
  })
})

describe("publish-time size limit for scanned types", () => {
  it("refuses a text-extractable file the check could not read in full", () => {
    for (const [fileName, contentType] of [
      ["roster.csv", "text/csv"],
      ["notes.txt", "text/plain"],
      ["brochure.pdf", "application/pdf"],
      ["chart.svg", "image/svg+xml"],
    ] as const) {
      expect(() =>
        assertPublicArtifactScannable(
          fileName,
          contentType,
          MAX_PERSONAL_DATA_SCAN_BYTES + 1
        )
      ).toThrow(/^Invalid public artifact size: .*without --to public/)
    }
  })

  it("allows a scanned type at the budget, and an unscanned type past it", () => {
    expect(() =>
      assertPublicArtifactScannable(
        "roster.csv",
        "text/csv",
        MAX_PERSONAL_DATA_SCAN_BYTES
      )
    ).not.toThrow()
    // Video is not read at all, so the broker's ordinary 100 MB limit applies.
    expect(() =>
      assertPublicArtifactScannable(
        "clip.mp4",
        "video/mp4",
        MAX_PERSONAL_DATA_SCAN_BYTES + 1
      )
    ).not.toThrow()
  })
})

describe("which uploads are text-extractable", () => {
  it("covers the five types #1886 names, plus SVG", () => {
    for (const [fileName, contentType, expected] of [
      ["a.csv", "text/csv", "utf8"],
      ["a.json", "application/json", "utf8"],
      ["a.md", "text/markdown", "utf8"],
      ["a.txt", "text/plain", "utf8"],
      ["a.pdf", "application/pdf", "pdf"],
      // Plain XML on disk, whatever it renders as.
      ["a.svg", "image/svg+xml", "utf8"],
      // Out of scope: raster images, video, audio.
      ["a.png", "image/png", null],
      ["a.mp3", "audio/mpeg", null],
      ["a.mp4", "video/mp4", null],
      ["noextension", "text/plain", null],
    ] as const) {
      expect(textExtractionFor(fileName, contentType)).toBe(expected)
    }
  })

  it("accepts a charset parameter but not a disagreeing type", () => {
    expect(textExtractionFor("a.csv", "text/csv; charset=utf-8")).toBe("utf8")
    // The broker already enforces that extension and type agree. A pair that
    // disagrees means something changed, and the scan must not guess.
    expect(textExtractionFor("a.csv", "application/pdf")).toBeNull()
  })
})

describe("public-file rule on the cases shared with the agent image", () => {
  it.each(SHARED_CASES.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(detectPersonalDataKinds(entry.text)).toEqual(entry.publicFile)
    }
  )
})

describe("the psd-publish-file skill tells the agent what is read", () => {
  it("names every text-extractable type the check reads", () => {
    // SKILL.md restates TEXT_EXTRACTABLE in prose for the agent; this is what
    // keeps that sentence from going stale when a type is added or removed.
    const skill = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "infra",
        "agent-image",
        "skills",
        "psd-publish-file",
        "SKILL.md"
      ),
      "utf8"
    )
    const sentence = skill.match(/<!-- scanned-types -->([\s\S]*?)<!-- \/scanned-types -->/)
    expect(sentence).not.toBeNull()
    const named = [...sentence![1]!.matchAll(/`(\.[a-z0-9]+)`/g)]
      .map((match) => match[1])
      .sort()
    expect(named).toEqual([...TEXT_EXTRACTABLE_EXTENSIONS])
  })
})
