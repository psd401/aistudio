#!/usr/bin/env python3
"""Repair a script file whose newlines arrived as literal backslash-n.

Rule 9a's remedy for this was "rewrite it as a file" — but the file IS what
failed. `write` is what produced the literal `\\n`, so rewriting runs the same
tool that just broke it and the loop repeats. It has killed the quartile report
four times and hit three separate users in one day on 2026-08-10, costing one
of them about 50 minutes.

This is the missing third option: repair what was written, in one CLI call,
authoring nothing.

    /opt/agentcore-venv/bin/python3 \\
      /opt/psd-skills/psd-rules/scripts/repair_literal_newlines.py broken.py

Exit 0 and "repaired"  -> the file was broken and is now fixed; run it.
Exit 0 and "clean"     -> nothing to do; the problem is elsewhere.
Exit 2                 -> ambiguous, left untouched (see below).

SAFETY — why this will not corrupt a healthy script

A Python or JS file legitimately contains `\\n` inside string literals
(`print("a\\nb")`). Rewriting those would break working code, so the repair
only fires on the SIGNATURE of the bug rather than on the sequence itself:
the whole file arrived as essentially one line, with many literal `\\n` where
the line breaks belonged.

A file with real line structure is left alone even if it contains `\\n`, and
says so, because a broken-looking file that is actually fine is a worse
outcome than no repair.
"""

import argparse
import sys

# A healthy multi-line script has real newlines. The bug produces a file that
# is one enormous line. Two or fewer real lines carrying several literal
# escapes is the signature; anything more structured is treated as healthy.
MAX_REAL_LINES_FOR_REPAIR = 2
MIN_LITERAL_ESCAPES = 2


def diagnose(text):
    """(verdict, real_lines, literal_escapes) — verdict in clean/broken/ambiguous."""
    real_lines = text.count("\n")
    literal = text.count("\\n")

    if literal == 0:
        return "clean", real_lines, literal
    if real_lines <= MAX_REAL_LINES_FOR_REPAIR and literal >= MIN_LITERAL_ESCAPES:
        return "broken", real_lines, literal
    # Real line structure AND literal escapes: almost certainly `\n` inside
    # string literals in a working file. Touching it would corrupt it.
    return "ambiguous", real_lines, literal


def repair(text):
    r"""Turn the literal two-character sequence \n into real newlines.

    `\\n` (an escaped backslash followed by n) is left alone — that is a
    deliberate literal in the source, not a mangled line break.
    """
    out = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            nxt = text[index + 1]
            if nxt == "\\":
                out.append("\\\\")
                index += 2
                continue
            if nxt == "n":
                out.append("\n")
                index += 2
                continue
            if nxt == "t":
                out.append("\t")
                index += 2
                continue
        out.append(char)
        index += 1
    return "".join(out)


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

    verdict, real_lines, literal = diagnose(text)

    if verdict == "clean":
        print(f"clean: {args.path} has no literal newline escapes")
        return 0

    if verdict == "ambiguous":
        print(
            f"ambiguous: {args.path} has {real_lines} real lines and {literal} "
            "literal escapes — it looks like working code whose strings contain "
            "\\n, so it was NOT modified. If it really is broken, the escapes "
            "are not the reason.",
            file=sys.stderr,
        )
        return 2

    if args.check:
        print(f"broken: {args.path} would be repaired ({literal} escapes)")
        return 0

    fixed = repair(text)
    with open(args.path, "w", encoding="utf-8") as handle:
        handle.write(fixed)
    print(
        f"repaired: {args.path} — {literal} literal escapes became real "
        f"newlines ({fixed.count(chr(10))} lines). Run it now; do not rewrite it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
