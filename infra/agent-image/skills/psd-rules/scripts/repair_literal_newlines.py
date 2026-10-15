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
    EVIDENCE — in code position, outside every string literal and comment,
    where a backslash cannot appear in working code;
  * an escape that is not evidence is never touched, even on a line that is
    repaired for its other escapes, so `SEP = "a\nb"` survives the repair of
    the line it shares;
  * a candidate line that mixes evidence with escapes inside a `//` comment is
    refused outright, because a line comment can only be read as running to
    the end of the line: repairing the breaks before it would leave every
    statement after it commented out.

Double-escaping escapes the delimiters as well as the breaks, so a line may
arrive as `SEP = \"alpha\nbravo\"`. When a Python line carries no bare quote at
all those escaped quotes are the real delimiters: they move the string state,
both ends are un-escaped, and the escapes between them are the string's data.
In JavaScript an escaped quote in code position ends the scan instead — the
shape is the same, but there is no parser to catch a wrong guess.

Where no proof can exist the script says so rather than choosing. A Python
comment holding `\n`-separated example code is indistinguishable from a
collapsed body — both are one comment token — so a candidate line whose every
escape sits inside a comment is reported ambiguous. The exception is a
single-line file: a collapsed script opening with a shebang IS one comment
token and cannot have been meant that way, which is why that case is still
repaired. A partial collapse whose body happens to begin with a comment in an
otherwise correct file is refused along with the prose, since no signal
separates them; the message says to split the comment off by hand.

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
    whole file (see _javascript_records), and if that scan cannot be trusted
    — it ends unbalanced, or meets a slash that may open a regex literal, or
    an escaped quote — the file is reported ambiguous rather than guessed at.

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


def _uses_escaped_delimiters(line, quotes):
    """True when this line's strings are delimited by `\\"` rather than `"`.

    Double-escaping escapes the delimiters as well as the line breaks, so the
    line arrives as `SEP = \\"alpha\\nbravo\\"`. Those escaped quotes are the
    string's real delimiters and the `\\n` between them is its data — reading
    them as ordinary escapes turned the whole run into "evidence" and produced
    an unterminated string. The tell is that the line has no bare quote at
    all, which separates it from a newline-only collapse whose strings keep
    their real delimiters and may legitimately contain `\\"` inside.
    """
    bare = 0
    escaped = 0
    index = 0
    while index < len(line):
        char = line[index]
        if char == "\\" and index + 1 < len(line):
            if line[index + 1] in quotes:
                escaped += 1
            index += 2
            continue
        if char in quotes:
            bare += 1
        index += 1
    return bare == 0 and escaped >= 2


def _line_records(line, language):
    """Escapes on one line: ``[[index, char_after, is_evidence, in_comment]]``.

    Evidence means the escape sits outside every string literal, which is
    where a backslash cannot appear in working code. A `\\\\` pair is skipped
    entirely: that is a deliberate literal backslash, not a mangled break.
    ``in_comment`` is only tracked for JavaScript (see _javascript_records).
    """
    quotes = _QUOTE_CHARS[language]
    escaped_delimiters = _uses_escaped_delimiters(line, quotes)
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
            if escaped_delimiters and nxt in quotes:
                # This escaped quote IS a delimiter. Mark it evidence so the
                # repair un-escapes it — both ends, or the string it opens
                # would be left unterminated — and move the quote state with
                # it so the escapes inside count as string data.
                records.append([index, nxt, True, False])
                if quote is None:
                    quote, quote_opened_at = nxt, index
                elif quote == nxt:
                    quote, quote_opened_at = None, -1
                index += 2
                continue
            records.append([index, nxt, quote is None, False])
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
    legitimate span lines: template literals and `/* */` blocks. A line inside
    one of those carries no quote of its own, so a line-at-a-time scan would
    read it as a collapsed body.

    Templates nest, so the scan carries a stack: a `${...}` interpolation is
    code again (a collapsed body can hide in there), it ends at the `}` that
    matches its own brace depth, and a backtick inside it opens a further
    template rather than closing the outer one. A flat toggle read that inner
    backtick as the end of the outer template and rewrote the working text
    that followed.

    Returns None — meaning "do not repair this file" — when the stream cannot
    be trusted: it ends unbalanced, or it meets a `/` in code position that is
    neither `//` nor `/*`. That slash may open a regex literal, where a
    backslash is ordinary, and telling a regex from a division needs a real JS
    lexer: `/[/\\n]/` closes its character class with the very character that
    would end the literal, and `return /\\n/.test(s)` is a regex straight
    after an identifier character. Guessing got a valid file rewritten, so an
    unclassifiable slash ends the scan instead.
    """
    records = {}
    row = 1
    column = 0
    state = "code"
    quote = ""
    depth = 0       # brace depth of the code frame we are in
    stack = []      # what to return to: ("code", depth) or ("template", 0)
    index = 0
    length = len(text)

    if text.startswith("#!"):
        # Step over a hashbang before the scan begins. Its slashes are not
        # code and would otherwise hit the bare-slash refusal below, which
        # turned away `#!/usr/bin/env node\nconst …` — the JS form of the most
        # common shape of this bug. It ends at the first line break, real or
        # mangled; the mangled one is left to be recorded as evidence.
        while index < length and text[index] not in "\r\n":
            if text[index] == "\\" and text[index + 1:index + 2] == "n":
                break
            index += 1
        column = index

    while index < length:
        char = text[index]

        if char == "\\" and text[index + 1:index + 2] in ("\n", "\r"):
            # A backslash immediately before a real newline continues a STRING
            # across the line break, which is legal in JS, and ending the
            # string there marked the next line's escapes as code and rewrote
            # a valid file. `\r\n` counts: a CRLF file's continuation is the
            # same construct. It continues nothing else — a backslash does not
            # extend a `//` comment past the line terminator — so every other
            # state ends at the newline as usual.
            index += 2
            if text[index - 1] == "\r" and text[index:index + 1] == "\n":
                index += 1
            if state == "line-comment":
                state = "code"
            row += 1
            column = 0
            continue

        if char == "\n":
            if state in ("string", "line-comment"):
                # Neither may span a real line break, so a newline ends them
                # whatever happened on the way.
                state = "code"
            row += 1
            column = 0
            index += 1
            continue

        if char == "\\" and index + 1 < length:
            nxt = text[index + 1]
            if state == "code" and nxt in "\"'`":
                # An escaped quote cannot appear in code position in valid JS,
                # so this file is double-escaped: its delimiters arrived as
                # `\"` too. This scan tracks strings by their quotes and
                # cannot follow that, and it converted a string's `\n` data
                # into raw newlines — illegal in a JS string — while
                # reporting success. `_line_records` handles the shape for the
                # languages that have a verifier; JS has none, so it refuses.
                return None
            records.setdefault(row, []).append(
                [column, nxt, state == "code", state == "line-comment"])
            index += 2
            column += 2
            continue

        if state == "code":
            if char in "\"'":
                state, quote = "string", char
            elif char == "`":
                stack.append(("code", depth))
                state, depth = "template", 0
            elif char == "{":
                depth += 1
            elif char == "}":
                if depth == 0 and stack and stack[-1][0] == "template":
                    stack.pop()
                    state = "template"
                else:
                    depth = max(depth - 1, 0)
            elif char == "/":
                nxt = text[index + 1] if index + 1 < length else ""
                if nxt == "/":
                    state = "line-comment"
                elif nxt == "*":
                    state = "block-comment"
                else:
                    return None
        elif state == "template":
            if char == "`":
                frame = stack.pop() if stack else ("code", 0)
                state, depth = frame
            elif char == "$" and index + 1 < length and text[index + 1] == "{":
                stack.append(("template", 0))
                state, depth = "code", 0
                index += 2
                column += 2
                continue
        elif state == "string":
            if char == quote:
                state = "code"
        elif state == "block-comment":
            if char == "*" and index + 1 < length and text[index + 1] == "/":
                state = "code"
                index += 2
                column += 2
                continue

        index += 1
        column += 1

    if state in ("template", "block-comment") or stack:
        return None
    return records


def escape_records(text, language):
    """``{line_number: [[index, char, is_evidence, in_line_comment]]}``.

    None when the file cannot be scanned reliably (JS/TS only).
    """
    if language == JAVASCRIPT:
        return _javascript_records(text)
    return {
        number: _line_records(line, language)
        for number, line in enumerate(split_lines(text), 1)
    }


def records_for(text, language):
    """Escape records for a whole file, with every known correction applied.

    The one place records are built, so the diagnosis and the repair cannot
    disagree about which escapes are evidence.
    """
    records = escape_records(text, language or PYTHON)
    if records is None:
        return None
    if language == PYTHON:
        # The tokeniser outranks the per-line quote pairing: it is the only
        # thing that sees a line sitting inside a triple-quoted string.
        apply_string_spans(records, python_string_spans(text))
    return records


def repair(text, language):
    r"""Un-escape the mangled sequences that are evidence of a collapse.

    `\n` and `\t` become real whitespace; `\"` and `\'` lose their backslash.
    An escape inside a string literal or a comment is left exactly as it was,
    as is `\\n`.
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
        for index, char, evidence, _comment in records.get(number, []):
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


def _tokenize_prefix(lines, start):
    """(tokens, failed_row) — tokens from ``lines[start:]`` up to the first
    error, with ``failed_row`` its 1-based row within that slice, or None when
    the rest tokenised.

    Reads through an index rather than a joined string so that resuming after
    many failures stays linear in the file: the tokeniser stops AT the failure
    rather than scanning past it, so each line is handed over once.
    """
    position = [start]

    def readline():
        if position[0] >= len(lines):
            return ""
        line = lines[position[0]]
        position[0] += 1
        return line

    tokens = []
    try:
        for token in tokenize.generate_tokens(readline):
            tokens.append(token)
    except Exception as error:  # TokenError, SyntaxError, IndentationError
        row = None
        args = getattr(error, "args", ())
        if len(args) > 1 and isinstance(args[1], tuple) and args[1]:
            row = args[1][0]
        if not isinstance(row, int):
            row = getattr(error, "lineno", None)
        if not isinstance(row, int) or row < 1:
            row = tokens[-1].end[0] if tokens else 1
        return tokens, max(row, 1)
    return tokens, None


def _python_spans(text, wanted):
    """``{line_number: [(start_col, end_col)]}`` for the wanted token kinds.

    A collapsed line is untokenisable — a backslash in code position is a
    TokenError — and it would otherwise take every literal in the file down
    with it. So tokenising RESUMES past each failure instead of stopping:
    tokens before the error were being kept already, and a literal after it is
    just as real. A triple-quoted string sitting after a collapsed line had its
    data rewritten because the scan never reached it.

    Resuming is not capped. The tokeniser stops at each failure instead of
    scanning past it, and each resume starts after the line that failed, so
    every line is handed over once and the whole walk is linear however many
    collapsed lines a file holds. A capped version left everything after the
    last allowed restart unprotected, which is the gap resuming exists to
    close.

    Resuming can also mis-pair quotes in the fragment it restarts on, which
    can only ever mark more escapes as legitimate — fewer repairs, never a
    wrong one.
    """
    lines = split_lines(text)
    spans = {}
    tokens = []
    offset = 0
    while offset < len(lines):
        found, failed_row = _tokenize_prefix(lines, offset)
        tokens.extend(
            token._replace(
                start=(token.start[0] + offset, token.start[1]),
                end=(token.end[0] + offset, token.end[1]),
            )
            for token in found
        )
        if failed_row is None:
            break
        # failed_row is at least 1, so this always advances.
        offset += failed_row
    for token in tokens:
        name = tokenize.tok_name.get(token.type, "")
        if not any(name == kind or name.startswith(kind) for kind in wanted):
            continue
        (start_row, start_col), (end_row, end_col) = token.start, token.end
        for row in range(start_row, end_row + 1):
            line_length = len(lines[row - 1]) if row - 1 < len(lines) else 0
            spans.setdefault(row, []).append((
                start_col if row == start_row else 0,
                end_col if row == end_row else line_length,
            ))
    return spans


def python_string_spans(text):
    """String-literal regions of a Python file, per the tokeniser.

    Only the tokeniser can see that a line sits inside a triple-quoted
    string, because the opening quote is on an earlier line. Comments are
    excluded here on purpose: a collapsed file beginning with a shebang is one
    big comment, so demoting comment escapes would call it healthy.
    """
    return _python_spans(text, ("STRING", "FSTRING"))


def python_comment_spans(text):
    """Comment regions of a Python file, per the tokeniser (see _vetoed)."""
    return _python_spans(text, ("COMMENT",))


def _within_spans(escapes, spans, number):
    """True when every one of a line's escapes sits inside a span."""
    line_spans = spans.get(number, [])
    if not line_spans:
        return False
    return all(
        any(start <= record[0] < end for start, end in line_spans)
        for record in escapes
    )


def apply_string_spans(records, spans):
    """Demote every escape the tokeniser places inside a string literal.

    Applied to the records themselves rather than used as a whole-file veto,
    so one genuinely collapsed line cannot drag a protected docstring line
    into the repair with it.
    """
    for number, line_records in records.items():
        line_spans = spans.get(number, [])
        if not line_spans:
            continue
        for record in line_records:
            if any(start <= record[0] < end for start, end in line_spans):
                record[2] = False


def _stays_all_comments(text, broken_lines, language, records):
    """True when repairing a line only ever produces more comment lines.

    `# first \\n# second \\n# third` is prose about escapes: every piece the
    repair would create is still a comment, so nothing was a collapsed line
    break. A collapsed file that opens with a shebang looks the same to the
    tokeniser — one comment — but its pieces include real code (`import
    sys`), which is what tells the two apart.
    """
    lines = split_lines(text)
    for number in broken_lines:
        if number > len(lines):
            continue
        repaired = apply_repair(
            lines[number - 1], [1], language,
            {1: records.get(number, [])})
        pieces = split_lines(repaired)[1:]
        if not pieces:
            return False
        for piece in pieces:
            stripped = piece.strip()
            if stripped and not stripped.startswith("#"):
                return False
    return True


def _vetoed(text, language, broken_lines, records):
    """True when repairing these lines would damage a file that works today.

    A file that does not parse cannot be damaged further by this repair, so
    the veto applies to one that does, on either proof that the escapes are
    legitimate:

    1. JSON that parses has no escape outside a string at all;
    2. the repair would only deepen a comment — it would stop the file
       parsing, or every piece it creates is still a comment — so the escapes
       are prose and the repair is what would break it.

    String literals are not handled here: the tokeniser's spans are applied
    to the records themselves in `diagnose`, which protects them line by line
    instead of all-or-nothing.
    """
    if _stays_all_comments(text, broken_lines, language, records):
        # Asked without regard to whether the file parses. Comment prose is
        # still comment prose in a file that has an unrelated syntax error
        # elsewhere, and rewriting it there is just as wrong — a warning after
        # the fact does not put the comment back.
        return True
    if not parses_cleanly(text, language):
        return False
    if language == JSON:
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

    # An unsupported extension is still scanned — it gets reported, never
    # rewritten — and Python's mode is the broadest of the line-at-a-time
    # ones, treating both quote characters as opening a string.
    records = records_for(text, language)
    if records is None:
        # JS/TS whose stream scan ended mid-template or mid-comment.
        return "ambiguous", real_lines, 0, []

    literal = sum(
        1
        for line_records in records.values()
        for _index, char, _evidence, _comment in line_records
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

    # A candidate whose every escape is inside a comment is set aside LINE BY
    # LINE, never as a group: a comment holding `\n`-separated example code is
    # indistinguishable from a collapsed body — both are one comment token —
    # and repairing the wrong one turned a working file's comment into live
    # statements. Judged as a group, one real collapse elsewhere in the file
    # dragged such a comment into the repair with it.
    #
    # Asked whether or not the rest of the file parses: prose next to a syntax
    # error is still prose, and the proof that a repair stops the file parsing
    # is no help in a file that never parsed.
    #
    # A collapsed script opening with a SHEBANG is exempt, and that exemption
    # is what keeps the main case working: such a file IS one comment token
    # and cannot have been meant that way. The exemption is no wider than
    # that — a one-line file that is any other comment may well be prose, and
    # as a plain `#` comment holding example statements it was rewritten into
    # live code. The cost is a partial collapse whose body happens to begin
    # with a comment in an otherwise correct file: the same shape as prose, so
    # it is set aside too, and the message says to split the comment off.
    comment_held = []
    collapsed_shebang = real_lines == 1 and text.startswith("#!")
    if broken_lines and language == PYTHON and not collapsed_shebang:
        comments = python_comment_spans(text)
        remaining = []
        for number in broken_lines:
            escapes = [r for r in records.get(number, []) if r[1] == "n"]
            if _within_spans(escapes, comments, number):
                comment_held.append(number)
            else:
                remaining.append(number)
        broken_lines = remaining

    if broken_lines:
        if any(
            record[3]
            for number in broken_lines
            for record in records.get(number, [])
        ):
            # A JS line that mixes collapsed breaks with escapes inside a `//`
            # comment cannot be repaired a piece at a time: a line comment can
            # only be read as running to the end of the physical line, so the
            # breaks after it would be left escaped and every statement past
            # that point would stay commented out — reported as a success.
            return "comment-mixed", real_lines, literal, broken_lines
        if _vetoed(text, language, broken_lines, records):
            return "clean", real_lines, literal, []
        # Any comment-held candidate stays exactly as it is while these are
        # repaired, which is why they were separated above.
        return "broken", real_lines, literal, broken_lines

    if comment_held:
        if _vetoed(text, language, comment_held, records):
            return "clean", real_lines, literal, []
        return "comment-ambiguous", real_lines, literal, comment_held
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

    if verdict == "comment-ambiguous":
        print(
            f"ambiguous: {args.path} line(s) {_describe(lines)} look "
            "collapsed, but every escape there is inside a comment — prose "
            "holding example code and a collapsed body look the same there, "
            "and repairing the wrong one would turn a comment into live "
            "statements. The file was NOT modified. If that line really is "
            "collapsed, split the comment off it by hand and run this again.",
            file=sys.stderr,
        )
        return 2

    if verdict == "comment-mixed":
        print(
            f"ambiguous: {args.path} line(s) {_describe(lines)} are collapsed "
            "but also carry a `//` comment, and a line comment can only be "
            "read as running to the end of the line — repairing the breaks "
            "before it would leave every statement after it commented out. "
            "The file was NOT modified; split that comment onto its own line "
            "by hand and run it again.",
            file=sys.stderr,
        )
        return 2

    if verdict == "ambiguous":
        if lines:
            print(
                f"ambiguous: {args.path} has {real_lines} real lines and "
                f"{literal} literal escapes; line(s) {_describe(lines)} look "
                f"collapsed but fewer than {MIN_ESCAPES_PER_LINE} of their "
                "escapes sit outside a string literal, so the file was NOT "
                "modified. Look elsewhere for the cause.",
                file=sys.stderr,
            )
        else:
            print(
                f"ambiguous: {args.path} could not be scanned reliably, so "
                "the file was NOT modified. It ends inside a template literal "
                "or a /* */ comment, or it uses a slash that may open a regex "
                "literal, or its quotes arrived escaped as well (`\\\"`) — "
                "none of which can be told apart from a collapse without a "
                "real JS parser.",
                file=sys.stderr,
            )
        return 2

    language = language_for(args.path)
    records = records_for(text, language)
    changing = sum(
        1
        for number in lines
        for _index, char, evidence, _comment in records.get(number, [])
        if char == "n" and evidence
    )

    if args.check:
        print(
            f"broken: {args.path} would be repaired on line(s) "
            f"{_describe(lines)} ({changing} of {literal} escapes)"
        )
        return 0

    fixed = apply_repair(text, lines, language, records)
    # Say so when the repair is an improvement but not a cure, rather than
    # ending on "Run it now" for a file that still will not parse.
    still_broken = language in (PYTHON, JSON) and not parses_cleanly(
        fixed, language)
    try:
        write_source(args.path, fixed, had_bom)
    except OSError as error:
        # The original is still intact — write_source replaces atomically and
        # cleans up its temp file — so report it on the documented channel
        # instead of raising off-contract.
        print(
            f"unwritable: {args.path}: {error.strerror}. The file was NOT "
            "modified.",
            file=sys.stderr,
        )
        return 2
    closing = (
        "It still does not parse, so the escapes were not its only problem — "
        "debug the error you get now. Do not rewrite the file."
        if still_broken
        else "Run it now; do not rewrite it."
    )
    print(
        f"repaired: {args.path} — line(s) {_describe(lines)} were collapsed; "
        f"{changing} literal escapes there became real newlines "
        f"({len(split_lines(fixed))} lines total). {closing}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
