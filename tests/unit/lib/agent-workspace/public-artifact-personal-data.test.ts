/** @jest-environment node */

/**
 * The contents rule for public links (#1886).
 *
 * The cases here are the ones the issue was written from: a roster CSV and a
 * staff phone list must be refused, a flyer whose only contact detail is the
 * school's own phone number must NOT be, and a binary image must pass without
 * being read at all.
 */

import { describe, expect, it, jest } from "@jest/globals"

import {
  MAX_PERSONAL_DATA_SCAN_BYTES,
  scanPublicArtifactForPersonalData,
} from "@/lib/agent-workspace/public-artifact-personal-data"
import {
  countDistinctPersonalData,
  detectPersonalDataKinds,
  textExtractionFor,
} from "@/lib/safety/personal-data-scan"

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
          text:
            "Harbor Ridge Middle School Open House\n" +
            "Thursday 6:00pm in the commons. Families welcome.\n" +
            "Questions? Call the front office at 253-530-1000.",
        },
      ],
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
          { text: "Call 253-530-1000" },
          { text: "or Mrs Hall directly on 253-555-0147" },
        ],
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

  it("allows a PDF the parser cannot read, and says it was not scanned", async () => {
    // Deliberate: a parser error is not evidence of personal data, and the
    // risk #1886 names is false positives blocking legitimate public flyers.
    const result = await scanPublicArtifactForPersonalData({
      ...utf8Upload("encrypted.pdf", "application/pdf", "%PDF-1.7 ..."),
      readPdfText: async () => {
        throw new Error("encrypted")
      },
    })
    expect(result).toEqual({
      refused: false,
      scanned: false,
      reason: "unreadable",
    })
  })

  it("does not read a PDF larger than the scan budget", async () => {
    const readBytes = jest.fn(async () => new Uint8Array())
    const result = await scanPublicArtifactForPersonalData({
      fileName: "huge.pdf",
      contentType: "application/pdf",
      byteLength: MAX_PERSONAL_DATA_SCAN_BYTES + 1,
      readBytes,
    })
    expect(result).toEqual({
      refused: false,
      scanned: false,
      reason: "over-scan-budget",
    })
    expect(readBytes).not.toHaveBeenCalled()
  })

  it("asks for no more than the scan budget on a large text file", async () => {
    const readBytes = jest.fn<(maxBytes: number) => Promise<Uint8Array>>(
      async () => new TextEncoder().encode("clean")
    )
    await scanPublicArtifactForPersonalData({
      fileName: "big.csv",
      contentType: "text/csv",
      byteLength: 90 * 1024 * 1024,
      readBytes,
    })
    expect(readBytes).toHaveBeenCalledWith(MAX_PERSONAL_DATA_SCAN_BYTES)
  })
})

describe("which uploads are text-extractable", () => {
  it("covers exactly the five types #1886 names", () => {
    for (const [fileName, contentType, expected] of [
      ["a.csv", "text/csv", "utf8"],
      ["a.json", "application/json", "utf8"],
      ["a.md", "text/markdown", "utf8"],
      ["a.txt", "text/plain", "utf8"],
      ["a.pdf", "application/pdf", "pdf"],
      // Out of scope: images, video, audio.
      ["a.png", "image/png", null],
      ["a.mp3", "audio/mpeg", null],
      ["a.mp4", "video/mp4", null],
      ["a.svg", "image/svg+xml", null],
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

describe("narration rule", () => {
  it("refuses the first match of anything, unlike the public-file rule", () => {
    const oneStaffNumber = "Reach Mrs Hall on 253-555-0147 before Friday."
    expect(detectPersonalDataKinds(oneStaffNumber, "public-file")).toEqual([])
    expect(detectPersonalDataKinds(oneStaffNumber, "narration")).toEqual([
      "us-phone",
    ])
  })

  it("finds nothing in ordinary prose", () => {
    const brief = "Three meetings today. The board packet is ready. Bus 12 is late."
    expect(detectPersonalDataKinds(brief, "narration")).toEqual([])
    expect(countDistinctPersonalData(brief).size).toBe(0)
  })
})
