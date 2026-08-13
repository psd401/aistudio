import { expandGmailDraftHelper } from "@/lib/agent-workspace/command-executor"

function decode(argv: string[]) {
  const raw = JSON.parse(argv[argv.indexOf("--json") + 1]).message.raw
  return Buffer.from(raw, "base64url").toString("utf8")
}

describe("expandGmailDraftHelper", () => {
  it("expands +draft into the canonical drafts create call", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "bill@psd401.net",
      "--subject", "Follow up", "--body", "Hi Bill,\nthanks.",
    ])
    expect(out.slice(0, 4)).toEqual(["gmail", "users", "drafts", "create"])
    expect(JSON.parse(out[out.indexOf("--params") + 1])).toEqual({ userId: "me" })
    const mime = decode(out)
    expect(mime).toContain("To: bill@psd401.net")
    expect(mime).toContain("Subject: Follow up")
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(mime.endsWith("Hi Bill,\nthanks.")).toBe(true)
  })

  it("leaves every non-draft command untouched", () => {
    const argv = ["gmail", "users", "messages", "list", "--params", "{}"]
    expect(expandGmailDraftHelper(argv)).toEqual(argv)
    const send = ["gmail", "+send", "--to", "x@y.z"]
    expect(expandGmailDraftHelper(send)).toEqual(send)
  })

  it("refuses header injection via CRLF", () => {
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c\r\nBcc: evil@x.y", "--body", "x",
      ])
    ).toThrow(/line break/)
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c", "--subject", "hi\nBcc: evil@x.y",
      ])
    ).toThrow(/line break/)
  })

  it("requires --to", () => {
    expect(() =>
      expandGmailDraftHelper(["gmail", "+draft", "--body", "x"])
    ).toThrow(/requires --to/)
  })

  it("RFC 2047-encodes a non-ASCII subject and supports cc/bcc + html", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--cc", "c@d.e", "--bcc", "f@g.h",
      "--subject", "Budget — Q4", "--body", "<b>hi</b>", "--html",
    ])
    const mime = decode(out)
    expect(mime).toContain("=?UTF-8?B?")
    expect(mime).not.toContain("Subject: Budget — Q4")
    expect(mime).toContain("Cc: c@d.e")
    expect(mime).toContain("Bcc: f@g.h")
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"')
  })
})
