"""
Markdown → Google Chat formatter.

Google Chat supports a *subset* of Markdown that overlaps with — but doesn't
match — what LLMs produce by default. The model emits standard CommonMark and
we transform it once at the harness adapter boundary so the user sees clean
output.

What renders in Google Chat:
  *bold*           → bold (single asterisk only)
  _italic_         → italic
  ~strike~         → strikethrough
  `inline`         → monospace
  ```fenced```     → code block
  <url|label>      → hyperlink with custom label
  bare URL         → auto-linked
  • bullet         → renders as a literal bullet glyph

What does NOT render (shows as literal characters):
  **double-asterisk bold**
  # / ## headers
  - / * bullet list markers
  [label](url) link syntax
  | pipe tables |
  --- horizontal rules

This module converts a Markdown payload into the rendering subset above.
Inline `code` and ```fenced``` blocks are passed through unchanged so we
don't mangle examples the agent might be quoting.
"""

from __future__ import annotations

import re
from typing import List

# Patterns compiled once at import.
_HEADER_RE = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*#*\s*$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.+)$")
_NUMBERED_RE = re.compile(r"^(\s*)(\d+)\.\s+(.+)$")
_HRULE_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|[\s|:\-]+\|\s*$")
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
# Bold: **x** but not ***x*** (which is bold+italic). Non-greedy.
_BOLD_RE = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*")
# Markdown link [text](url) → Chat <url|text>. Avoid matching image syntax ![..](..).
_LINK_RE = re.compile(r"(?<!!)\[([^\]]+?)\]\(([^)\s]+)\)")
# Reference-style links [text][ref] are uncommon in LLM output; ignored.

# Fenced code block delimiter (``` or ~~~), with optional language tag.
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def markdown_to_chat(text: str) -> str:
    """Transform Markdown into Google Chat rendering format.

    Idempotent on already-Chat-formatted text. Returns the input unchanged if
    it contains no Markdown markers.
    """
    if not text:
        return text

    lines: List[str] = text.split("\n")
    out: List[str] = []
    in_fence = False

    for line in lines:
        # Fenced code blocks: pass through unchanged. Track open/close so we
        # don't transform Markdown inside code samples.
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue

        # Horizontal rules: drop entirely (would render as literal dashes).
        if _HRULE_RE.match(line):
            continue

        # Table separator rows (| --- | --- |): drop.
        if _TABLE_SEP_RE.match(line):
            continue

        # Table data rows: strip outer pipes, leave " | " separators in place.
        # The result reads like "Col1 | Col2 | Col3" which Chat renders fine.
        if _TABLE_ROW_RE.match(line):
            stripped = line.strip().strip("|").strip()
            # Collapse runs of whitespace around inner pipes for readability.
            stripped = re.sub(r"\s*\|\s*", " | ", stripped)
            out.append(stripped)
            continue

        # Headers: # X → *X* on its own line. Drop trailing #'s if present.
        header_match = _HEADER_RE.match(line)
        if header_match:
            heading_text = header_match.group(2).strip()
            # Apply inline transforms to header text too (bold/links inside headers).
            heading_text = _apply_inline(heading_text)
            out.append(f"*{heading_text}*")
            continue

        # Unordered list bullets: -, *, + → •
        bullet_match = _BULLET_RE.match(line)
        if bullet_match:
            indent, content = bullet_match.group(1), bullet_match.group(2)
            out.append(f"{indent}• {_apply_inline(content)}")
            continue

        # Numbered lists: keep the number but apply inline transforms.
        # Chat renders "1. text" fine.
        numbered_match = _NUMBERED_RE.match(line)
        if numbered_match:
            indent, num, content = (
                numbered_match.group(1),
                numbered_match.group(2),
                numbered_match.group(3),
            )
            out.append(f"{indent}{num}. {_apply_inline(content)}")
            continue

        # Plain line — apply inline transforms.
        out.append(_apply_inline(line))

    return "\n".join(out)


def _apply_inline(text: str) -> str:
    """Apply inline-only transforms: bold, links. Inline code is preserved."""
    # Protect inline `code` spans so we don't transform their contents.
    code_spans: List[str] = []

    def stash_code(match: re.Match) -> str:
        code_spans.append(match.group(0))
        return f"\x00{len(code_spans) - 1}\x00"

    # Single-backtick inline code, non-greedy.
    text = re.sub(r"`[^`\n]+?`", stash_code, text)

    # **bold** → *bold*
    text = _BOLD_RE.sub(r"*\1*", text)

    # [text](url) → <url|text>
    text = _LINK_RE.sub(lambda m: f"<{m.group(2)}|{m.group(1)}>", text)

    # Restore stashed code spans.
    def restore(match: re.Match) -> str:
        idx = int(match.group(1))
        return code_spans[idx]

    text = re.sub(r"\x00(\d+)\x00", restore, text)
    return text
