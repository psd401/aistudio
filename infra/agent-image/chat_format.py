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

import json
import re
from typing import List, Optional, Tuple

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

# A "URL-only" line: optional surrounding asterisks, then either a Chat
# hyperlink <url|label> or a bare http(s) URL, then optional surrounding
# asterisks and trailing punctuation. Captured groups isolate the link content
# so we can strip the asterisks the LLM sometimes wraps around it. Used to
# defuse fragile cases like `**<url|label>**` or `**https://…token=…**`,
# which can confuse Google Chat's auto-link / bold heuristics and corrupt
# JWT signature characters in transit (incident 2026-04-27).
_URL_LINE_RE = re.compile(
    r"^\s*"
    r"\*{1,3}?"                              # leading * or **
    r"(<https?://[^>\s]+\|[^>]+>|https?://\S+?)"  # the link itself
    r"\*{1,3}?"                              # trailing * or **
    r"[.,;:!?]?"                             # optional trailing punctuation
    r"\s*$"
)


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

        # URL-only lines: emit just the link, no surrounding asterisks. This
        # is critical for the workspace consent flow — a JWT in the query
        # string can contain `_` runs that pair into Chat-italic, or sit
        # adjacent to `**` markers that confuse Chat's URL auto-detection.
        # Stripping the wrappers and emitting `<url|label>` (preferred) or
        # the bare URL on its own line gives Chat a single unambiguous token.
        url_match = _URL_LINE_RE.match(line)
        if url_match:
            out.append(url_match.group(1))
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


# ---------------------------------------------------------------------------
# Rich-output envelope (PSD_AGENT_RICH_V1)
#
# Skills like chat-card / chat-chart emit a structured payload that the Router
# Lambda lifts into the Chat `messages.create` request alongside (or in place
# of) the plain `text` field. The envelope sits inside the agent's final
# response, wrapped by deterministic sentinels so it's robust to the model
# accidentally regenerating prose around it. Last envelope wins if the model
# emits more than one (defensive — should not happen with a single skill
# call, but cheap to handle).
# ---------------------------------------------------------------------------

RICH_ENVELOPE_OPEN = "<<<PSD_AGENT_RICH_V1>>>"
RICH_ENVELOPE_CLOSE = "<<<END_PSD_AGENT_RICH_V1>>>"


def extract_rich_envelope(text: str) -> Tuple[Optional[dict], str]:
    """Pull a rich-output envelope out of an agent reply.

    Returns (envelope_or_None, remaining_text). When no envelope is present
    or the JSON inside the sentinels is malformed, the envelope slot is None
    and the original text is returned unchanged. On malformed JSON we leave
    the sentinels in the returned text so the upstream caller can log it —
    silently dropping a broken envelope would mask agent bugs.

    If the agent emits multiple envelopes, the LAST one wins (latest model
    intent) and all sentinel blocks are stripped from the returned text.
    """
    if not text or RICH_ENVELOPE_OPEN not in text:
        return None, text

    remaining = text
    last_envelope: Optional[dict] = None
    malformed = False

    while True:
        open_idx = remaining.find(RICH_ENVELOPE_OPEN)
        if open_idx == -1:
            break
        close_idx = remaining.find(RICH_ENVELOPE_CLOSE, open_idx + len(RICH_ENVELOPE_OPEN))
        if close_idx == -1:
            # Missing close marker — bail without further mutation so the
            # caller sees the dangling open token and can log it.
            malformed = True
            break

        payload_start = open_idx + len(RICH_ENVELOPE_OPEN)
        payload = remaining[payload_start:close_idx].strip()
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                last_envelope = parsed
            else:
                malformed = True
        except (json.JSONDecodeError, ValueError):
            malformed = True

        # Strip this envelope block (including sentinels) from the working
        # text. Drop a single neighbouring newline on each side so we don't
        # leave a blank gap where the block was.
        before = remaining[:open_idx].rstrip("\n")
        after = remaining[close_idx + len(RICH_ENVELOPE_CLOSE):].lstrip("\n")
        joiner = "\n" if before and after else ""
        remaining = before + joiner + after

    if malformed and last_envelope is None:
        # Couldn't parse anything — return original text untouched so the
        # caller can log + fall back to plain-text send.
        return None, text

    return last_envelope, remaining.strip()
