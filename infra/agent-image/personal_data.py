"""
The agent image's Python reader for the canonical personal-data patterns.
Issue #1886.

The regexes are NOT written here. They live in
`lib/safety/personal-data-patterns.json`, which the Next.js storage broker
imports directly and which `build-and-push.sh` stages into the image at
`/opt/psd-skills/_shared/personal-data-patterns.json`. Same arrangement as
`workspace_policy.json`: one committed file, three runtimes reading it, no
regex written twice.

Only the narration rule is here, because only psd-tts uses this loader. The
public-file thresholds are the broker's (lib/safety/personal-data-scan.ts).

`source` strings in that file are constrained to syntax that is valid in both
JavaScript and Python `re` — no named groups, no lookbehind, no \\p{...}.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Set


def _pattern_file_path(module_path: Path) -> Path:
    module_directory = module_path.resolve().parent
    # In the repo (unit tests, local runs): the canonical committed copy.
    repository_candidate = (
        module_directory.parent.parent / "lib" / "safety" / "personal-data-patterns.json"
    )
    if repository_candidate.is_file():
        return repository_candidate
    # In the image: staged alongside the shared skill helpers.
    return Path("/opt/psd-skills/_shared/personal-data-patterns.json")


_PATTERN_PATH = _pattern_file_path(Path(__file__))
with _PATTERN_PATH.open(encoding="utf-8") as _pattern_file:
    _PATTERN_FILE = json.load(_pattern_file)
if _PATTERN_FILE.get("version") != 1:
    raise RuntimeError("unsupported personal-data pattern file version")

# (kind, compiled) in file order. Case-insensitive to match the JS loaders.
_PATTERNS = [
    (entry["kind"], re.compile(entry["source"], re.IGNORECASE))
    for entry in _PATTERN_FILE["patterns"]
]

_NARRATION_MIN_DISTINCT: Dict[str, int] = _PATTERN_FILE["narrationMinDistinct"]


def _distinct_value(kind: str, matched: str) -> str:
    # A phone number is its ten digits: the country-code pattern and the bare
    # one both match `1-253-530-1000`, and that is one number, not two. Same
    # rule as lib/safety/personal-data-scan.ts.
    if kind != "us-phone":
        return matched.lower()
    digits = re.sub(r"\D", "", matched)
    return digits[1:] if len(digits) == 11 else digits


def _distinct_counts(text: str) -> Dict[str, int]:
    """
    How many DISTINCT values of each kind the text contains.

    Distinct rather than total: a header and a footer repeating the same
    number are one phone number, while a call list of ten numbers is ten.
    """
    values: Dict[str, Set[str]] = {}
    for kind, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            values.setdefault(kind, set()).add(_distinct_value(kind, match.group(0)))
    return {kind: len(found) for kind, found in values.items()}


def personal_data_kinds(text: str) -> List[str]:
    """
    The kinds of personal data that make `text` unfit for narration, sorted.

    Returns the KINDS and never the matched values: a refusal must not carry
    the personal data into a log line, an error message or a CloudWatch event.
    """
    counts = _distinct_counts(text)
    return sorted(
        kind
        for kind, distinct in counts.items()
        if kind in _NARRATION_MIN_DISTINCT and distinct >= _NARRATION_MIN_DISTINCT[kind]
    )
