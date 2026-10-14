import { expandGmailDraftHelper } from "@/lib/agent-workspace/command-executor"

const MARKER = "— Drafted by your agent. Review before sending."

function payload(argv: string[]) {
  return JSON.parse(argv[argv.indexOf("--json") + 1])
}

function params(argv: string[]) {
  return JSON.parse(argv[argv.indexOf("--params") + 1])
}

function decode(argv: string[]) {
  const raw = payload(argv).message.raw
  return Buffer.from(raw, "base64url").toString("utf8")
}

/** Headers + decoded body, mirroring what a mail client renders. */
function decodeBody(argv: string[]) {
  const mime = decode(argv)
  const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n")
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")
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
    expect(mime).toContain("Content-Transfer-Encoding: base64")
    expect(decodeBody(out)).toBe(`Hi Bill,\nthanks.\n\n${MARKER}`)
  })

  it("round-trips a non-ASCII body through the declared encoding", () => {
    // Raw UTF-8 under an implied 7bit is off-spec; an em dash, an accented
    // name or an emoji is routine in district mail.
    const body = "Budget — Renée ✅\nsecond line"
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--subject", "s", "--body", body,
    ])
    expect(decode(out)).toContain("Content-Transfer-Encoding: base64")
    expect(decodeBody(out)).toBe(`${body}\n\n${MARKER}`)
  })

  it("wraps a long encoded body at 76 chars per RFC 2045", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--body", "x".repeat(500),
    ])
    const mime = decode(out)
    const bodyLines = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n").split("\r\n")
    expect(bodyLines.length).toBeGreaterThan(1)
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76)
    expect(decodeBody(out)).toBe(`${"x".repeat(500)}\n\n${MARKER}`)
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
    // --cc and --bcc share the guard with --to, but "shares the code path" is
    // an inference until it is asserted — and this is the check standing
    // between model-authored text and a forged header.
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c", "--cc", "c@d.e\r\nBcc: evil@x.y",
      ])
    ).toThrow(/line break/)
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c", "--bcc", "f@g.h\nTo: evil@x.y",
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

  it("rejects a repeated flag instead of dropping every value but the first", () => {
    // `--to a --to b` is a plausible model habit, and the old first-match
    // lookup silently addressed one recipient and lost the rest.
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c", "--to", "d@e.f", "--body", "x",
      ])
    ).toThrow(/--to was given more than once/)
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c",
        "--subject", "one", "--subject", "two",
      ])
    ).toThrow(/--subject was given more than once/)
  })

  it("does not mistake body text for a flag", () => {
    // Scanning flag-by-flag, not searching the whole argv: a body that talks
    // about `--to` is body text, not a second recipient flag.
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--body", "--to",
    ])
    expect(decode(out)).toContain("To: a@b.c")
    expect(decodeBody(out)).toBe(`--to\n\n${MARKER}`)
  })

  it("encodes only the display name of a non-ASCII address", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "José Ruiz <jose@psd401.net>", "--body", "x",
    ])
    const mime = decode(out)
    // The addr-spec has to stay machine-readable — encoding the whole header
    // would leave Gmail nothing to deliver to.
    expect(mime).toContain("<jose@psd401.net>")
    expect(mime).toContain("To: =?UTF-8?B?")
    expect(mime).not.toContain("José")
  })

})

// #1894 — revising a draft created a SECOND draft, and `drafts delete` is
// Phase-1 forbidden, so the stale one could neither be replaced nor removed.
describe("expandGmailDraftHelper revision, threading and strict flags", () => {
  it("expands --draft-id into a drafts update of that draft", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--draft-id", "r-8812_x",
      "--to", "a@b.c", "--subject", "Revised", "--body", "second pass",
    ])
    expect(out.slice(0, 4)).toEqual(["gmail", "users", "drafts", "update"])
    // The id is the `{id}` path segment, so it has to ride in --params.
    expect(params(out)).toEqual({ userId: "me", id: "r-8812_x" })
    expect(payload(out).id).toBe("r-8812_x")
    expect(decode(out)).toContain("Subject: Revised")
    expect(decodeBody(out)).toBe(`second pass\n\n${MARKER}`)
  })

  it("still creates when no --draft-id is given", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--body", "x",
    ])
    expect(out.slice(0, 4)).toEqual(["gmail", "users", "drafts", "create"])
    expect(params(out)).toEqual({ userId: "me" })
    expect(payload(out).message.threadId).toBeUndefined()
  })

  it("refuses a draft id that could redirect the request path", () => {
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--draft-id", "../../messages/send",
        "--to", "a@b.c", "--body", "x",
      ])
    ).toThrow(/--draft-id must be a Gmail id/)
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--thread-id", "a/b", "--to", "a@b.c", "--body", "x",
      ])
    ).toThrow(/--thread-id must be a Gmail id/)
  })

  it("files the draft into a thread with --thread-id and reply headers", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--thread-id", "thread_42",
      "--in-reply-to", "CAF=abc@mail.gmail.com",
      "--to", "a@b.c", "--subject", "Re: Budget", "--body", "answering",
    ])
    // threadId on the message resource is what actually files it in the thread.
    expect(payload(out).message.threadId).toBe("thread_42")
    const mime = decode(out)
    // Angle brackets added so the header is a valid RFC 5322 msg-id.
    expect(mime).toContain("In-Reply-To: <CAF=abc@mail.gmail.com>")
    expect(mime).toContain("References: <CAF=abc@mail.gmail.com>")
  })

  it("keeps an already-bracketed message id as written", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--in-reply-to", "<x@y.z>",
      "--to", "a@b.c", "--body", "x",
    ])
    expect(decode(out)).toContain("In-Reply-To: <x@y.z>")
    expect(decode(out)).not.toContain("<<x@y.z>>")
  })

  it("refuses an unknown flag instead of silently ignoring it", () => {
    // Attachments are out of scope for a draft, and the old parser dropped the
    // flag and returned a successful-looking draft without the file.
    expect(() =>
      expandGmailDraftHelper([
        "gmail", "+draft", "--to", "a@b.c", "--body", "x",
        "--attach", "/tmp/report.pdf",
      ])
    ).toThrow(/does not accept --attach/)
    // A stray positional is just as wrong as a stray flag.
    expect(() =>
      expandGmailDraftHelper(["gmail", "+draft", "--to", "a@b.c", "oops"])
    ).toThrow(/does not accept oops/)
  })

  it("expands a mixed-case +draft, matching the lowercased allowlist key", () => {
    // `operationTokens` lowercases every positional, so `gmail +Draft` passes
    // validation as `gmail +draft`; an exact-match expansion left it to reach
    // gws as an unrecognized subcommand.
    const out = expandGmailDraftHelper([
      "Gmail", "+Draft", "--to", "a@b.c", "--body", "x",
    ])
    expect(out.slice(0, 4)).toEqual(["gmail", "users", "drafts", "create"])
    expect(decodeBody(out)).toBe(`x\n\n${MARKER}`)
  })

  it("appends the agent marker exactly once across a revise cycle", () => {
    const first = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--body", "draft one",
    ])
    const carried = decodeBody(first)
    expect(carried).toBe(`draft one\n\n${MARKER}`)
    // Reading the draft back, editing it and resubmitting must not stack the
    // footer the way an unguarded append would.
    const revised = expandGmailDraftHelper([
      "gmail", "+draft", "--draft-id", "D1", "--to", "a@b.c",
      "--body", `${carried}`,
    ])
    expect(decodeBody(revised)).toBe(`draft one\n\n${MARKER}`)
  })

  it("separates the marker with a line break HTML actually renders", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft", "--to", "a@b.c", "--body", "<p>hi</p>", "--html",
    ])
    expect(decodeBody(out)).toBe(`<p>hi</p><br><br>${MARKER}`)
  })

  it("leaves an all-ASCII address header byte-for-byte alone", () => {
    const out = expandGmailDraftHelper([
      "gmail", "+draft",
      "--to", '"Doe, John" <john@psd401.net>, jane@psd401.net',
      "--body", "x",
    ])
    expect(decode(out)).toContain(
      'To: "Doe, John" <john@psd401.net>, jane@psd401.net'
    )
  })
})
