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
Exit 2                 -> not repaired: unsure, unsupported or unreadable.

SAFETY — why this will not corrupt a healthy script

A Python or JS file legitimately contains `\n` inside string literals
(`print("a\nb")`) and in comment prose ("records are separated by \n"), so the
repair fires on the SIGNATURE of the bug rather than on the sequence itself,
and it tests that signature LINE BY LINE:

  * a line is a *collapse candidate* when it carries at least
    MIN_ESCAPES_PER_LINE literal `\n` escapes and is longer than
    MIN_COLLAPSED_LINE_LENGTH characters;
  * it is repaired only when at least that many of those escapes are
    EVIDENCE — outside every string literal, comment and regex literal, where
    a backslash cannot appear in working code;
  * an escape that is not evidence is never touched, even on a line that is
    repaired for its other escapes, so `SEP = "a\nb"` survives the repair of
    the line it shares.

Line-by-line matters because the real-world shape is usually PARTIAL collapse:
a few correct header lines followed by a body collapsed onto one line. The
previous whole-file test ("2 or fewer real lines") declared that file ambiguous
and left it broken, which is the bug this script exists to end.

Only Python, JavaScript/TypeScript and JSON are repaired, by extension. Any
other extension is diagnosed and reported but never rewritten: `\n` in a
`.sh`, `.sql` or `.md` line cannot be told apart from prose without that
language's comment and string rules, and a corrupted working file is a worse
outcome than no repair. Rule 9a tells you to write a `.py` or `.js` file, so
that is what this repairs.

Each language earns its own evidence test, because only some can be verified:

  * Python keeps a per-line scan, then has to clear a VETO (see _vetoed).
    Parsing is deliberately not a short-circuit on the way in: a collapsed
    file that starts with `#!/usr/bin/env python3` is one enormous COMMENT, so
    it parses perfectly while being completely broken — and that is the single
    most common shape of this bug.
  * JSON keeps a per-line scan (it has no comments, and a JSON string cannot
    contain a raw newline) plus a `json.loads` veto.
  * JavaScript/TypeScript has no stdlib parser, so it gets no veto and must
    not be judged a line at a time: a line inside a template literal or a
    `/* */` block opened earlier carries no quote of its own and would look
    exactly like a collapsed body. It is scanned as ONE STREAM across the
    whole file (see _javascript_records), and if that scan ends mid-template
    or mid-comment the file is reported ambiguous rather than guessed at.

A candidate line without enough evidence is reported ambiguous (exit 2) and
left byte-identical.
"""

import argparse
import codecs
import io
import json
import os
import shutil
import sys
import tempfile
import tokenize

# A collapsed line is long and carries several literal escapes where the line
# breaks belonged. Both thresholds exist to keep short, legitimate lines such
# as `print("a\nb\nc")` out of reach of the repair.
MIN_ESCAPES_PER_LINE = 3
MIN_COLLAPSED_LINE_LENGTH = 60

PYTHON = "python"
JAVASCRIPT = "javascript"
JSON = "json"

_EXTENSIONS = {
    ".py": PYTHON,
    ".pyw": PYTHON,
    ".js": JAVASCRIPT,
    ".jsx": JAVASCRIPT,
    ".mjs": JAVASCRIPT,
    ".cjs": JAVASCRIPT,
    ".ts": JAVASCRIPT,
    ".tsx": JAVASCRIPT,
    ".mts": JAVASCRIPT,
    ".cts": JAVASCRIPT,
    ".json": JSON,
}

# Which characters open a string literal, for the languages scanned a line at
# a time. Python comments are deliberately NOT modelled here — see the module
# docstring on the shebang case — and JSON has none.
_QUOTE_CHARS = {
    PYTHON: "\"'",
    JSON: "\"",
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

# A `/` that follows one of these is division, not the start of a regex.
_NOT_BEFORE_REGEX = ")]}"


def language_for(path):
    """Language name from the file extension, or None when unsupported."""
    if not path:
        return None
    return _EXTENSIONS.get(os.path.splitext(path)[1].lower())


def split_lines(text):
    """Split on `\\n` only, keeping the ends.

    `str.splitlines` also breaks on `\\r`, form feed and several Unicode
    separators, which the Python tokeniser does not, so using it here would
    misalign line numbers against `python_string_spans` on a file containing
    any of those inside a string.
    """
    if not text:
        return []
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _line_records(line, language):
    """Escapes on one line: ``[[index, char_after, is_evidence]]``.

    Evidence means the escape sits outside every string literal, which is
    where a backslash cannot appear in working code. A `\\\\` pair is skipped
    entirely: that is a deliberate literal backslash, not a mangled break.
    """
    quotes = _QUOTE_CHARS[language]
    records = []
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
            records.append([index, nxt, quote is None])
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
        # whole body). Treat everything from that quote on as evidence.
        for record in records:
            if record[0] >= quote_opened_at:
                record[2] = True

    return records


def _javascript_records(text):
    """Escapes in a whole JS/TS file, keyed by 1-based line number, or None.

    One stream over the file, because the constructs that make a `\\n`
    legitimate span lines: template literals and `/* */` blocks. Returns None
    when the stream ends inside one of those, since the classification cannot
    then be trusted.
    """
    records = {}
    row = 1
    column = 0
    state = "code"
    index = 0
    length = len(text)
    previous = ""

    while index < length:
        char = text[index]

        if char == "\n":
            if state in ("string", "regex", "line-comment"):
                # None of these may span a real line break, so a newline ends
                # them whatever happened on the way.
                state = "code"
            row += 1
            column = 0
            index += 1
            previous = ""
            continue

        if char == "\\" and index + 1 < length and text[index + 1] != "\n":
            nxt = text[index + 1]
            if nxt == "\\":
                index += 2
                column += 2
                previous = "\\"
                continue
            records.setdefault(row, []).append([column, nxt, state == "code"])
            index += 2
            column += 2
            previous = nxt
            continue

        if state == "code":
            if char in "\"'":
                state, quote = "string", char
            elif char == "`":
                state, quote = "template", char
            elif char == "/" and index + 1 < length and text[index + 1] == "/":
                state = "line-comment"
            elif char == "/" and index + 1 < length and text[index + 1] == "*":
                state = "block-comment"
            elif char == "/" and not (
                previous.isalnum() or previous in "_$" + _NOT_BEFORE_REGEX
            ):
                state, quote = "regex", "/"
        elif state in ("string", "template", "regex"):
            if char == quote:
                state = "code"
        elif state == "block-comment":
            if char == "*" and index + 1 < length and text[index + 1] == "/":
                state = "code"
                index += 2
                column += 2
                previous = "/"
                continue

        if not char.isspace():
            previous = char
        index += 1
        column += 1

    if state in ("template", "block-comment"):
        return None
    return records


def escape_records(text, language):
    """``{line_number: [[index, char_after, is_evidence]]}``, or None."""
    if language == JAVASCRIPT:
        return _javascript_records(text)
    return {
        number: _line_records(line, language)
        for number, line in enumerate(split_lines(text), 1)
    }


def repair(text, language=PYTHON):
    r"""Un-escape the mangled sequences that are evidence of a collapse.

    `\n` and `\t` become real whitespace; `\"` and `\'` lose their backslash.
    An escape inside a string, comment or regex literal is left exactly as it
    was, as is `\\n`.
    """
    records = escape_records(text, language)
    if records is None:
        return text
    return apply_repair(text, records.keys(), language, records)


def apply_repair(text, lines_to_change, language, records=None):
    """Repair only the given 1-based lines, leaving every other byte alone."""
    if records is None:
        records = escape_records(text, language)
        if records is None:
            return text
    targets = set(lines_to_change)
    out = []
    for number, line in enumerate(split_lines(text), 1):
        if number not in targets:
            out.append(line)
            continue
        position = 0
        for index, char, evidence in records.get(number, []):
            if not evidence or char not in _UNESCAPE:
                continue
            out.append(line[position:index])
            out.append(_UNESCAPE[char])
            position = index + 2
        out.append(line[position:])
    return "".join(out)


def parses_cleanly(text, language):
    """True when the text is valid source for its language.

    JavaScript/TypeScript has no stdlib parser, so it always returns False.
    """
    if language == PYTHON:
        try:
            compile(text, "<diagnose>", "exec")
        except Exception:  # SyntaxError, ValueError (null bytes), ...
            return False
        return True
    if language == JSON:
        try:
            json.loads(text)
        except Exception:
            return False
        return True
    return False


def python_string_spans(text):
    """String-literal regions of a parsing Python file, per the tokeniser.

    ``{line_number: [(start_col, end_col)]}``, or None when the text cannot be
    tokenised. Only the tokeniser can see that a line sits inside a
    triple-quoted string, because the opening quote is on an earlier line.
    Comments are excluded on purpose (see _vetoed).
    """
    lines = split_lines(text)
    spans = {}
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except Exception:  # SyntaxError, TokenError, ...
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
        for index, _char, _evidence in escapes:
            if not any(start <= index < end for start, end in line_spans):
                return False
    return True


def _vetoed(text, language, broken_lines, records):
    """True when repairing these lines would damage a file that works today.

    A file that does not parse cannot be damaged by this repair, so the veto
    only applies to one that does, and only on a proof that the escapes are
    legitimate:

    1. JSON that parses has no escape outside a string at all;
    2. every escape sits inside a real string literal, per the tokeniser,
       which is the only thing that sees triple-quoted strings; or
    3. the file would STOP parsing once repaired — the escapes are prose in a
       comment and the repair is what would break it.

    Comments cannot themselves be a proof, because a collapsed file beginning
    with a shebang is one big comment; proof 3 is what separates it (parses
    before AND after) from `x = 1  # see \\n\\n\\n` (parses only before).
    """
    if not parses_cleanly(text, language):
        return False
    if language == JSON:
        return True
    if language == PYTHON:
        spans = python_string_spans(text)
        if spans is not None:
            escapes = {
                number: [r for r in records.get(number, []) if r[1] == "n"]
                for number in broken_lines
            }
            if _all_within_spans(escapes, spans):
                return True
    return not parses_cleanly(
        apply_repair(text, broken_lines, language, records), language
    )


def diagnose(text, path):
    """(verdict, real_lines, literal_escapes, lines).

    verdict is clean / broken / ambiguous / unsupported. ``lines`` holds the
    1-based numbers of the collapsed lines that would be repaired, or for the
    other verdicts the ones it declined to touch.
    """
    language = language_for(path)
    lines = split_lines(text)
    real_lines = len(lines)

    records = escape_records(text, language or PYTHON)
    if records is None:
        # JS/TS whose stream scan ended mid-template or mid-comment.
        return "ambiguous", real_lines, 0, []

    literal = sum(
        1
        for line_records in records.values()
        for _index, char, _evidence in line_records
        if char == "n"
    )
    if literal == 0:
        return "clean", real_lines, literal, []

    broken_lines = []
    unsure_lines = []
    for number, line in enumerate(lines, 1):
        newlines = [r for r in records.get(number, []) if r[1] == "n"]
        if len(newlines) < MIN_ESCAPES_PER_LINE:
            continue
        if len(line.rstrip("\r\n")) <= MIN_COLLAPSED_LINE_LENGTH:
            continue
        if len([r for r in newlines if r[2]]) >= MIN_ESCAPES_PER_LINE:
            broken_lines.append(number)
        else:
            unsure_lines.append(number)

    if language is None:
        if broken_lines or unsure_lines:
            return ("unsupported", real_lines, literal,
                    sorted(broken_lines + unsure_lines))
        return "clean", real_lines, literal, []

    if broken_lines:
        if _vetoed(text, language, broken_lines, records):
            return "clean", real_lines, literal, []
        return "broken", real_lines, literal, broken_lines
    if unsure_lines:
        # The candidate's escapes were not evidence. For JS/TS that is the
        # stream scan's positive answer — they are string, comment or regex
        # content — and the unreliable case already returned None above, so
        # there is no "maybe" left to report. For the languages scanned a line
        # at a time the quote pairing is only a heuristic, so it takes a
        # successful parse to upgrade "unsure" to "clean".
        if language == JAVASCRIPT or parses_cleanly(text, language):
            return "clean", real_lines, literal, []
        return "ambiguous", real_lines, literal, unsure_lines
    return "clean", real_lines, literal, []


def read_source(path):
    """(text, had_bom). Raises OSError or UnicodeDecodeError."""
    with open(path, "rb") as handle:
        raw = handle.read()
    had_bom = raw.startswith(codecs.BOM_UTF8)
    # A leading BOM must come off before the text reaches `compile()`: the
    # interpreter strips it from a file's bytes when running it, but compiling
    # a str that still contains U+FEFF is a SyntaxError, which would make a
    # working file look broken and disable the Python veto entirely.
    return raw.decode("utf-8-sig" if had_bom else "utf-8"), had_bom


def write_source(path, text, had_bom):
    """Replace the file atomically, preserving its mode and any BOM.

    `open(path, "w")` truncates before the new bytes land, so a process killed
    mid-write would leave the user with a half-file and no original. The
    contract here is that a file is never left worse than it arrived.
    """
    target = os.path.realpath(path)
    directory = os.path.dirname(target) or "."
    raw = text.encode("utf-8")
    if had_bom:
        raw = codecs.BOM_UTF8 + raw
    handle, temporary = tempfile.mkstemp(
        dir=directory, prefix=".repair-literal-newlines-")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        shutil.copymode(target, temporary)
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


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

    try:
        text, had_bom = read_source(args.path)
    except UnicodeDecodeError:
        print(
            f"unreadable: {args.path} is not UTF-8 text, so it was NOT "
            "modified. This tool only repairs text files.",
            file=sys.stderr,
        )
        return 2
    except OSError as error:
        print(f"unreadable: {args.path}: {error.strerror}", file=sys.stderr)
        return 2

    verdict, real_lines, literal, lines = diagnose(text, args.path)

    if verdict == "clean":
        if literal:
            print(
                f"clean: {args.path} has {literal} literal newline escapes, "
                "but none of them is a collapsed line break — repairing them "
                "would break working code, so nothing was changed. Look "
                "elsewhere for the cause."
            )
        else:
            print(f"clean: {args.path} has no literal newline escapes")
        return 0

    if verdict == "unsupported":
        print(
            f"unsupported: {args.path} has {literal} literal escapes and "
            f"line(s) {_describe(lines)} look collapsed, but this tool only "
            "repairs .py, .js/.ts and .json files — in any other language a "
            "literal \\n cannot be told apart from comment prose, so the "
            "file was NOT modified.",
            file=sys.stderr,
        )
        return 2

    if verdict == "ambiguous":
        if lines:
            print(
                f"ambiguous: {args.path} has {real_lines} real lines and "
                f"{literal} literal escapes; line(s) {_describe(lines)} look "
                f"collapsed but fewer than {MIN_ESCAPES_PER_LINE} of their "
                "escapes sit outside a string, comment or regex literal, so "
                "the file was NOT modified. Look elsewhere for the cause.",
                file=sys.stderr,
            )
        else:
            print(
                f"ambiguous: {args.path} could not be scanned reliably — it "
                "ends inside a template literal or a /* */ comment, so the "
                "file was NOT modified.",
                file=sys.stderr,
            )
        return 2

    language = language_for(args.path)
    records = escape_records(text, language)
    changing = sum(
        1
        for number in lines
        for _index, char, evidence in records.get(number, [])
        if char == "n" and evidence
    )

    if args.check:
        print(
            f"broken: {args.path} would be repaired on line(s) "
            f"{_describe(lines)} ({changing} of {literal} escapes)"
        )
        return 0

    fixed = apply_repair(text, lines, language, records)
    write_source(args.path, fixed, had_bom)
    print(
        f"repaired: {args.path} — line(s) {_describe(lines)} were collapsed; "
        f"{changing} literal escapes there became real newlines "
        f"({len(split_lines(fixed))} lines total). Run it now; do not "
        "rewrite it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
