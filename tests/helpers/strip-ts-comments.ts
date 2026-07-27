/**
 * Quote-aware TypeScript comment stripper for source-reading tests.
 *
 * Several tests assert against CDK source because CI does not run the infra
 * jest suite. Those assertions are only meaningful on COMMENT-STRIPPED source:
 * a commented-out policy statement still contains the literal text, so a raw
 * substring check stays green while the deployed role denies everything.
 *
 * Regexes cannot do this job, and both naive forms fail on real files here:
 *
 *   /\/\/.*$/            mangles the ARNs and URLs inside string literals.
 *
 *   /\/\*[\s\S]*?\*\//   is worse, and silently catastrophic: a string literal
 *                        containing "/*" opens a comment that never
 *                        legitimately closes, so the regex deletes everything
 *                        up to the next "*\/" elsewhere in the file. Measured
 *                        on agent-platform-stack.ts, that removed 100,907 of
 *                        203,156 characters — half the source, including the
 *                        code under test — and the assertions then reported a
 *                        missing grant that was present.
 *
 * So this walks the source once, tracking whether it is inside a string, a
 * template literal, or a comment, and only treats a marker found in code as a
 * comment. Escapes are honored so "\'" does not end a string.
 *
 * Lives here rather than inline in each spec because it has been reimplemented
 * (and gotten wrong) more than once. Its behaviour is pinned by
 * tests/unit/strip-ts-comments.test.ts.
 */
export function stripComments(src: string): string {
  let out = ""
  let quote: string | null = null
  let inLine = false
  let inBlock = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]

    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}
