import { describe, expect, test } from "bun:test";
import { extractSection } from "./memory";

describe("extractSection", () => {
  test("finds 'Email Triage → Life OS Task Creation' under any heading depth", () => {
    const md = [
      "## Other Section",
      "Some content.",
      "",
      "### Email Triage → Life OS Task Creation",
      "Run gh issue create --repo krishagel/life-os --label status:inbox",
      "",
      "## Next Section",
      "Other stuff.",
    ].join("\n");
    const section = extractSection(md);
    expect(section).toContain("gh issue create");
    expect(section).not.toContain("Other Section");
    expect(section).not.toContain("Next Section");
  });

  test("returns null when no matching heading", () => {
    const md = "## Random\nNothing relevant here.";
    expect(extractSection(md)).toBeNull();
  });

  test("includes nested deeper subsections", () => {
    const md = [
      "## Email Triage → Task Creation",
      "Body line 1.",
      "",
      "### Sub-detail",
      "Sub body.",
      "",
      "## Next Top-Level",
      "Other.",
    ].join("\n");
    const section = extractSection(md);
    expect(section).toContain("Body line 1");
    expect(section).toContain("Sub-detail");
    expect(section).toContain("Sub body");
    expect(section).not.toContain("Next Top-Level");
  });

  test("matches arrow variants and case-insensitive", () => {
    const md = "### EMAIL TRIAGE -> TASK CREATION\nDo stuff.";
    expect(extractSection(md)).toContain("Do stuff");
  });
});
