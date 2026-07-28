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
interface CommentScanState {
  out: string
  quote: string | null
  inLine: boolean
  inBlock: boolean
}

function consumeLineComment(state: CommentScanState, ch: string): void {
  if (ch === "\n") {
    state.inLine = false
    state.out += ch
  }
}

function consumeBlockComment(
  state: CommentScanState,
  ch: string,
  next: string | undefined
): boolean {
  if (ch !== "*" || next !== "/") return false
  state.inBlock = false
  return true
}

function consumeQuotedCharacter(
  state: CommentScanState,
  ch: string
): boolean {
  if (ch === "\\") return true
  if (ch === state.quote) state.quote = null
  state.out += ch
  return false
}

function startCommentOrQuote(
  state: CommentScanState,
  ch: string,
  next: string | undefined
): boolean {
  if (ch === "'" || ch === '"' || ch === "`") {
    state.quote = ch
    state.out += ch
    return true
  }
  if (ch === "/" && next === "/") {
    state.inLine = true
    return true
  }
  if (ch === "/" && next === "*") {
    state.inBlock = true
    return true
  }
  return false
}

export function stripComments(src: string): string {
  const state: CommentScanState = {
    out: "",
    quote: null,
    inLine: false,
    inBlock: false,
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (state.inLine) {
      consumeLineComment(state, ch)
      continue
    }
    if (state.inBlock) {
      if (consumeBlockComment(state, ch, next)) i++
      continue
    }
    if (state.quote) {
      if (consumeQuotedCharacter(state, ch)) i++
      continue
    }
    if (startCommentOrQuote(state, ch, next)) {
      if (state.inBlock) i++
      continue
    }
    state.out += ch
  }
  return state.out
}
