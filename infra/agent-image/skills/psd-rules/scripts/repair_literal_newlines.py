#!/usr/bin/env python3
r"""Repair a script file whose newlines arrived as literal backslash-n.

Rule 9a's remedy for this was "rewrite it as a file" — but the file IS what
failed. `write` is what produced the literal `\n`, so rewriting runs the same
tool that just broke it and the loop repeats. It has killed the quartile report
four times, hit three separate users in one day on 2026-08-10 costing one of
them about 50 minutes, and in a read of 375 staff members' agent use it was the
single most common defect: about 37 people hit it between 2026-09-25 and
2026-10-11 alone.

This is the missing third option: repair what was written, in one CLI call,
authoring nothing.

    /opt/agentcore-venv/bin/python3 \
      /opt/psd-skills/psd-rules/scripts/repair_literal_newlines.py broken.py

Exit 0 and "repaired"  -> the file was broken and is now fixed; run it.
Exit 0 and "clean"     -> nothing to do; the problem is elsewhere.
Exit 2                 -> ambiguous, left untouched (see below).

SAFETY — why this will not corrupt a healthy script

A Python or JS file legitimately contains `\n` inside string literals
(`print("a\nb")`). Rewriting those would break working code, so the repair
fires on the SIGNATURE of the bug rather than on the sequence itself, and it
tests that signature LINE BY LINE:

  * a line is a *collapse candidate* when it carries at least
    MIN_ESCAPES_PER_LINE literal `\n` escapes and is longer than
    MIN_COLLAPSED_LINE_LENGTH characters;
  * it is repaired only when those escapes sit OUTSIDE string literals for the
    file's language (Python, JavaScript/TypeScript or JSON, by extension);
  * escapes inside string literals are never touched, even on a line that is
    repaired for its other escapes.

Line-by-line matters because the real-world shape is usually PARTIAL collapse:
a few correct header lines followed by a body collapsed onto one line. The
previous whole-file test ("2 or fewer real lines") declared that file ambiguous
and left it broken, which is the bug this script exists to end.

A candidate line whose escapes all sit inside strings is reported ambiguous
(exit 2) and left alone, because a broken-looking file that is actually fine is
a worse outcome than no repair — unless the file still parses as valid source
for its language, in which case it is simply clean: working code needs no
repair, and that is what protects a healthy file whose strings contain `\n`.

Parsing is NOT used as a short-circuit on the way in. A collapsed file that
starts with `#!/usr/bin/env python3` is one enormous COMMENT, so it parses
perfectly while being completely broken — and that is the single most common
shape of this bug. Parsing is only allowed to VETO a repair, and only when it
proves the repair would make things worse: the file parses now and would stop
parsing afterwards (`x = 1  # see \n\n\n in the docs` is a working line whose
escapes really are just prose).
"""

import argparse
import io
import json
import os
import sys
import tokenize

# A collapsed line is long and carries several literal escapes where the line
# breaks belonged. Both thresholds exist to keep short, legitimate lines such
# as `print("a\nb\nc")` out of reach of the repair.
MIN_ESCAPES_PER_LINE = 3
MIN_COLLAPSED_LINE_LENGTH = 60

# Which characters open a string literal, per language. Comments are
# deliberately NOT modelled: on a collapsed line the real newline that ended a
# comment is itself one of the mangled escapes, so `#` does not run to the end
# of the line and treating it that way would hide the shebang-first case that
# is the most common shape of this bug.
_QUOTE_CHARS = {
    "python": "\"'",
    "javascript": "\"'`",
    "json": "\"",
    "generic": "\"'",
}

_EXTENSIONS = {
    ".py": "python",
    ".pyw": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "javascript",
    ".tsx": "javascript",
    ".mts": "javascript",
    ".cts": "javascript",
    ".json": "json",
}

# The escape sequences a collapsed write mangles, and what they should be.
# `\"` and `\'` come from double-escaping: the payload arrives with its quotes
# escaped as well as its line breaks, so a line repaired for its newlines has
# to lose those backslashes too or it still will not parse.
_UNESCAPE = {
    "n": "\n",
    "t": "\t",
    '"': '"',
    "'": "'",
}


def language_for(path):
    """Language name from the file extension; 'generic' when unrecognised."""
    if not path:
        return "generic"
    return _EXTENSIONS.get(os.path.splitext(path)[1].lower(), "generic")


def _find_escapes(line, language):
    """Locate every backslash escape on one line.

    Returns a list of ``[index, char_after, inside_string]``. A `\\\\` pair is
    skipped entirely: that is a deliberate literal backslash in the source, not
    a mangled line break.
    """
    quotes = _QUOTE_CHARS.get(language, _QUOTE_CHARS["generic"])
    escapes = []
    quote = None
    quote_opened_at = -1
    index = 0
    length = len(line)

    while index < length:
        char = line[index]
        if char == "\\" and index + 1 < length:
            nxt = line[index + 1]
            if nxt == "\\":
                index += 2
                continue
            escapes.append([index, nxt, quote is not None])
            index += 2
            continue
        if quote is None:
            if char in quotes:
                quote = char
                quote_opened_at = index
        elif char == quote:
            quote = None
            quote_opened_at = -1
        index += 1

    if quote is not None:
        # The line ends with an unterminated quote, so the "string" we were
        # tracking is not a valid literal and our pairing cannot be trusted
        # (one apostrophe in a collapsed comment would otherwise swallow the
        # whole body). Treat everything from that quote on as outside a string.
        for escape in escapes:
            if escape[0] >= quote_opened_at:
                escape[2] = False

    return escapes


def repair(text, language="generic"):
    r"""Un-escape the mangled sequences that sit outside string literals.

    `\n` and `\t` become real whitespace; `\"` and `\'` lose their backslash.
    Escapes inside a string literal are left exactly as they were, as is
    `\\n` — an escaped backslash is a deliberate literal, not a broken break.
    """
    out = []
    for line in text.splitlines(keepends=True):
        position = 0
        for index, char, inside in _find_escapes(line, language):
            if inside or char not in _UNESCAPE:
                continue
            out.append(line[position:index])
            out.append(_UNESCAPE[char])
            position = index + 2
        out.append(line[position:])
    return "".join(out)


def parses_cleanly(text, language):
    """True when the text is valid source for its language.

    JavaScript/TypeScript has no stdlib parser, so those always return False
    and rely on the line-by-line test alone.
    """
    if language == "python":
        try:
            compile(text, "<diagnose>", "exec")
        except Exception:  # SyntaxError, ValueError (null bytes), ...
            return False
        return True
    if language == "json":
        try:
            json.loads(text)
        except Exception:
            return False
        return True
    return False


def python_string_spans(text):
    """Authoritative string-literal regions of a PARSING Python file.

    ``{line_number: [(start_col, end_col), ...]}``, or None when the text
    cannot be tokenised. Only the real tokeniser can see that a line sits
    inside a triple-quoted string — the per-line scan cannot, because the
    opening quote is on an earlier line, and a `\\n`-rich line inside a
    docstring would otherwise look exactly like a collapsed body.

    Comments are deliberately excluded: a collapsed file that starts with a
    shebang is ONE comment, so trusting comments would call it healthy.
    """
    lines = text.splitlines(keepends=True)
    spans = {}
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except Exception:  # SyntaxError, TokenizeError, ...
        return None
    for token in tokens:
        name = tokenize.tok_name.get(token.type, "")
        if name != "STRING" and not name.startswith("FSTRING"):
            continue
        (start_row, start_col), (end_row, end_col) = token.start, token.end
        for row in range(start_row, end_row + 1):
            line_length = len(lines[row - 1]) if row - 1 < len(lines) else 0
            spans.setdefault(row, []).append((
                start_col if row == start_row else 0,
                end_col if row == end_row else line_length,
            ))
    return spans


def _all_within_spans(escapes_by_line, spans):
    """True when every given escape sits inside a string-literal span."""
    for number, escapes in escapes_by_line.items():
        line_spans = spans.get(number, [])
        for index, _char, _inside in escapes:
            if not any(start <= index < end for start, end in line_spans):
                return False
    return True


def _vetoed(text, language, broken_lines, escapes_per_line):
    """True when repairing these lines would damage a file that works today.

    A file that does not parse cannot be damaged by this repair, so the veto
    only applies to one that does, and only on the two proofs that the escapes
    are legitimate:

    1. every escape sits inside a real string literal (the tokeniser's answer,
       which is the only one that sees triple-quoted strings); or
    2. the file would STOP parsing once repaired — the escapes are prose in a
       comment and the repair is what would break it.

    A collapsed file that begins with a shebang parses as one big comment, so
    neither proof holds for it and it is repaired, which is the whole point.
    """
    if not parses_cleanly(text, language):
        return False
    if language == "json":
        # Valid JSON has no escapes outside strings at all.
        return True
    if language == "python":
        spans = python_string_spans(text)
        if spans is not None:
            escapes = {
                number: [e for e in escapes_per_line[number - 1] if e[1] == "n"]
                for number in broken_lines
            }
            if _all_within_spans(escapes, spans):
                return True
    return not parses_cleanly(
        apply_repair(text, broken_lines, language), language
    )


def diagnose(text, path=None):
    """(verdict, real_lines, literal_escapes, lines_to_change).

    verdict is clean / broken / ambiguous. ``lines_to_change`` holds the
    1-based numbers of the collapsed lines that would be repaired.
    """
    language = language_for(path)
    real_lines = text.count("\n")
    lines = text.splitlines(keepends=True)

    escapes_per_line = [_find_escapes(line, language) for line in lines]
    literal = sum(
        1
        for escapes in escapes_per_line
        for _index, char, _inside in escapes
        if char == "n"
    )

    if literal == 0:
        return "clean", real_lines, literal, []

    broken_lines = []
    unsure_lines = []
    for number, (line, escapes) in enumerate(zip(lines, escapes_per_line), 1):
        newlines = [e for e in escapes if e[1] == "n"]
        if len(newlines) < MIN_ESCAPES_PER_LINE:
            continue
        if len(line.rstrip("\r\n")) <= MIN_COLLAPSED_LINE_LENGTH:
            continue
        outside = [e for e in newlines if not e[2]]
        if len(outside) >= MIN_ESCAPES_PER_LINE:
            broken_lines.append(number)
        else:
            unsure_lines.append(number)

    if broken_lines:
        if _vetoed(text, language, broken_lines, escapes_per_line):
            return "clean", real_lines, literal, []
        return "broken", real_lines, literal, broken_lines
    if unsure_lines:
        if parses_cleanly(text, language):
            return "clean", real_lines, literal, []
        return "ambiguous", real_lines, literal, unsure_lines
    return "clean", real_lines, literal, []


def apply_repair(text, lines_to_change, language):
    """Repair only the given 1-based lines, leaving every other byte alone."""
    targets = set(lines_to_change)
    out = []
    for number, line in enumerate(text.splitlines(keepends=True), 1):
        out.append(repair(line, language) if number in targets else line)
    return "".join(out)


def _describe(numbers):
    return ", ".join(str(number) for number in numbers)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report only; do not modify the file",
    )
    args = parser.parse_args()

    with open(args.path, encoding="utf-8") as handle:
        text = handle.read()

    verdict, real_lines, literal, lines_to_change = diagnose(text, args.path)

    if verdict == "clean":
        if literal:
            print(
                f"clean: {args.path} has {literal} literal newline escapes, "
                "but none of them is a collapsed line break — repairing them "
                "would break working code, so nothing was changed. The "
                "problem is elsewhere."
            )
        else:
            print(f"clean: {args.path} has no literal newline escapes")
        return 0

    if verdict == "ambiguous":
        print(
            f"ambiguous: {args.path} has {real_lines} real lines and {literal} "
            f"literal escapes; line(s) {_describe(lines_to_change)} look "
            "collapsed but every escape there sits inside a string literal, so "
            "the file was NOT modified. If it really is broken, the escapes "
            "are not the reason.",
            file=sys.stderr,
        )
        return 2

    language = language_for(args.path)
    if args.check:
        print(
            f"broken: {args.path} would be repaired on line(s) "
            f"{_describe(lines_to_change)} ({literal} escapes)"
        )
        return 0

    fixed = apply_repair(text, lines_to_change, language)
    with open(args.path, "w", encoding="utf-8") as handle:
        handle.write(fixed)
    print(
        f"repaired: {args.path} — line(s) {_describe(lines_to_change)} were "
        f"collapsed; their literal escapes became real newlines "
        f"({fixed.count(chr(10))} lines total). Run it now; do not rewrite it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
