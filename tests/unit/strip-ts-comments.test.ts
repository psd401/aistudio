/**
 * Behaviour pin for the shared comment stripper.
 *
 * Every source-reading test depends on this being correct in BOTH directions:
 * a no-op stripper passes on commented-out code, and an over-eager one deletes
 * the code under test and fails on correct source. Both failure modes have
 * actually occurred, so they are pinned here once instead of re-derived in each
 * spec.
 */

import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../helpers/strip-ts-comments"

describe("stripComments", () => {
  it("removes line and block comments", () => {
    const src = [
      "const live = KEEP_ME",
      "// const dead = DEAD_LINE",
      "/* const dead2 = DEAD_BLOCK */",
      "const after = ALSO_KEPT",
    ].join("\n")
    const out = stripComments(src)

    expect(out).toContain("KEEP_ME")
    expect(out).toContain("ALSO_KEPT")
    expect(out).not.toContain("DEAD_LINE")
    expect(out).not.toContain("DEAD_BLOCK")
  })

  it("preserves comment markers inside string literals", () => {
    // The exact shapes that broke earlier regex versions: URLs contain "//",
    // and a glob literal contains "/*" which opens a fake block comment.
    const src = [
      'const url = "https://psd401.ai/api/agent/directory-lookup"',
      "const glob = '/*.ts'",
      "const tpl = `arn:aws:bedrock:us-east-1::foundation-model/x`",
    ].join("\n")
    const out = stripComments(src)

    expect(out).toContain("https://psd401.ai/api/agent/directory-lookup")
    expect(out).toContain("/*.ts")
    expect(out).toContain("foundation-model/x")
  })

  it("does not let a string-literal comment marker swallow later code", () => {
    // The catastrophic case. With the regex version everything between the
    // literal "/*" and the next "*/" vanished.
    const src = [
      "const glob = '/*.ts'",
      "const survivor = MUST_SURVIVE",
      "/* a real comment */",
      "const tail = ALSO_SURVIVES",
    ].join("\n")
    const out = stripComments(src)

    expect(out).toContain("MUST_SURVIVE")
    expect(out).toContain("ALSO_SURVIVES")
  })

  it("honors escapes so an escaped quote does not end a string", () => {
    const out = stripComments(`const s = 'it\\'s // not a comment'`)
    expect(out).toContain("not a comment")
  })

  it("keeps most of a real 200KB source file", () => {
    // Guards the regression by magnitude on the actual file that exposed it.
    const raw = fs.readFileSync(
      path.join(process.cwd(), "infra/lib/agent-platform-stack.ts"),
      "utf8",
    )
    expect(stripComments(raw).length).toBeGreaterThan(raw.length * 0.3)
  })
})
