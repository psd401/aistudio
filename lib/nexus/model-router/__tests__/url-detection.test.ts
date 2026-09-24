/** @jest-environment node */

import { containsExplicitUrl, stripExplicitUrls } from "../url-detection"

describe("explicit URL detection (#1696)", () => {
  it.each([
    "Open https://example.com and quote the heading",
    "Summarize http://example.org/article",
    "Read https://[2606:4700:4700::1111]/",
    "Check https://[2001:db8::1]:8443/status please",
  ])("detects a URL in %s", (text) => {
    expect(containsExplicitUrl(text)).toBe(true)
  })

  it.each(["No link here", "https:// alone", "see example.com"])(
    "finds no URL in %s",
    (text) => {
      expect(containsExplicitUrl(text)).toBe(false)
    }
  )

  it("strips bracketed IPv6 URLs along with ordinary ones", () => {
    expect(
      stripExplicitUrls("Read https://[2606:4700::1111]/latest and https://example.com/news").trim()
    ).toBe("Read   and")
  })
})
