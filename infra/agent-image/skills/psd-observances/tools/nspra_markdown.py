#!/usr/bin/env python3
"""Generate retrieval-oriented Markdown from an authorized NSPRA calendar PDF.

The source PDF and generated Markdown are copyrighted operational inputs. They
must remain outside every Git worktree. Only this extractor and its fact-only
tests belong in the repository.

Run with PyMuPDF through the repository-standard uv workflow:

    uv run --python 3.12 --no-project --with pymupdf python \
      infra/agent-image/skills/psd-observances/tools/nspra_markdown.py \
      --pdf /approved/operator-storage/calendar.pdf \
      --out /tmp/nspra-calendar-markdown \
      --report /tmp/nspra-calendar-verification.json
"""

from __future__ import annotations

import argparse
import calendar
import dataclasses
import datetime as dt
import difflib
import json
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Sequence
from itertools import pairwise
from pathlib import Path

COVERAGE_START = dt.date(2026, 1, 1)
COVERAGE_END = dt.date(2027, 6, 30)
SUMMARY_YEARS = tuple(range(2026, 2032))
CONFERENCE_YEARS = SUMMARY_YEARS
PDF_PAGE_COUNT_MINIMUM = 92
PART_I_PAGES = range(11, 58)
DIRECTORY_PAGES = range(5, 10)
SUMMARY_PAGE = 59
STATE_PAGES = range(61, 86)
CONFERENCE_PAGES = range(88, 93)
GENERATED_REPOSITORY_PATH = "infra/agent-image/skills/psd-observances/generated"
ALLOWED_TRACKED_PDFS = {
    ("infra/agent-image/skills/psd-brand-guidelines/assets/PSD_Branding_Guide.pdf")
}

STATE_NAMES = (
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Kentucky",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
    "District of Columbia",
)

MONTH_PATTERN = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
    r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|"
    r"Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?"
)
DATE_PATTERN = re.compile(
    rf"^(?P<start_month>{MONTH_PATTERN})\s+(?P<start_day>\d{{1,2}})"
    rf"(?:\s*[-–—]\s*(?:(?P<end_month>{MONTH_PATTERN})\s+)?"
    rf"(?P<end_day>\d{{1,2}}))?$",
    re.IGNORECASE,
)
DATE_SUFFIX_PATTERN = re.compile(
    rf"(?P<date>{MONTH_PATTERN}\s+\d{{1,2}}"
    rf"(?:\s*[-–—]\s*(?:{MONTH_PATTERN}\s+)?\d{{1,2}})?)\s*$",
    re.IGNORECASE,
)
WEEKDAY_PATTERN = r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
SUMMARY_SUFFIX_PATTERN = re.compile(
    rf"(?P<weekday>{WEEKDAY_PATTERN}),?\s+"
    rf"(?P<month>{MONTH_PATTERN})\s+(?P<day>\d{{1,2}})\s*$",
    re.IGNORECASE,
)
YEAR_HEADING_PATTERN = re.compile(r"^(202[6-9]|203[01])(?:\s+\([^)]*\))?$")
STATE_SECTION_PATTERN = re.compile(
    r"^(State legal holiday|School holidays?)(?:\s*[-—]\s*continued)?$",
    re.IGNORECASE,
)
STATUTE_PATTERN = re.compile(
    r"\b(?:code|constitution|law|laws|statute|statutes|section|"
    r"revised|compiled|annotated|acts?)\b|§",
    re.IGNORECASE,
)
CONTACT_PATTERN = re.compile(
    r"@|\b(?:www\.)?[a-z0-9][a-z0-9.-]*\."
    r"(?:org|com|net|edu|gov|us)\b",
    re.IGNORECASE,
)


@dataclasses.dataclass(frozen=True)
class Word:
    """A PDF word and its coordinate box."""

    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    block: int = 0
    line: int = 0
    order: int = 0

    @property
    def center_x(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def center_y(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclasses.dataclass(frozen=True)
class DateSpan:
    """One parsed date or inclusive date range."""

    start: dt.date
    end: dt.date
    raw: str

    def iso_text(self) -> str:
        if self.start == self.end:
            return self.start.isoformat()
        return f"{self.start.isoformat()}/{self.end.isoformat()}"


@dataclasses.dataclass
class Observance:
    raw_date: str
    date: DateSpan | None
    name: str
    comments: str
    pdf_page: int


@dataclasses.dataclass
class DirectoryEntry:
    raw_date: str
    date: DateSpan | None
    name: str
    pdf_page: int


@dataclasses.dataclass
class StateDocument:
    name: str
    sections: dict[str, list[str]] = dataclasses.field(
        default_factory=lambda: defaultdict(list)
    )
    pages: set[int] = dataclasses.field(default_factory=set)


@dataclasses.dataclass
class SummaryHoliday:
    year: int
    name: str
    date: dt.date
    stated_weekday: str
    pdf_page: int


@dataclasses.dataclass
class Conference:
    year: int
    raw_date: str
    date: DateSpan | None
    organization: str
    location: str
    address_web: str
    contact: str
    pdf_page: int

    @property
    def has_contact_route(self) -> bool:
        return bool(CONTACT_PATTERN.search(f"{self.address_web} {self.contact}"))


@dataclasses.dataclass
class Extraction:
    observances: list[Observance]
    directory_entries: list[DirectoryEntry]
    states: dict[str, StateDocument]
    summary: dict[int, list[SummaryHoliday]]
    conferences: list[Conference]
    malformed_conference_rows: list[dict[str, object]]
    metadata: dict[str, object]


def normalize_space(value: str) -> str:
    """Collapse PDF whitespace while retaining source punctuation."""

    value = value.replace("\u00a0", " ").replace("\u2007", " ")
    return re.sub(r"\s+", " ", value).strip()


def join_fragments(existing: str, fragment: str) -> str:
    """Join wrapped PDF fragments without preserving layout-only newlines."""

    existing = normalize_space(existing)
    fragment = normalize_space(fragment)
    if not existing:
        return fragment
    if not fragment:
        return existing
    if existing.endswith("-") and fragment[:1].islower():
        return f"{existing}{fragment}"
    return f"{existing} {fragment}"


def words_to_text(words: Sequence[Word]) -> str:
    """Join words ordered by their horizontal coordinate."""

    text = " ".join(word.text for word in sorted(words, key=lambda item: item.x0))
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return normalize_space(text)


def cluster_lines(words: Iterable[Word], *, tolerance: float = 3.2) -> list[list[Word]]:
    """Cluster words into visual lines using y-coordinates, not PDF text order."""

    rows: list[tuple[float, list[Word]]] = []
    for word in sorted(words, key=lambda item: (item.center_y, item.x0)):
        selected_index: int | None = None
        selected_distance = tolerance + 1
        for index in range(max(0, len(rows) - 4), len(rows)):
            distance = abs(rows[index][0] - word.center_y)
            if distance <= tolerance and distance < selected_distance:
                selected_index = index
                selected_distance = distance
        if selected_index is None:
            rows.append((word.center_y, [word]))
            continue
        center, row_words = rows[selected_index]
        row_words.append(word)
        rows[selected_index] = (
            ((center * (len(row_words) - 1)) + word.center_y) / len(row_words),
            row_words,
        )
    rows.sort(key=lambda item: item[0])
    return [sorted(row_words, key=lambda item: item.x0) for _, row_words in rows]


def partition_line(line: Sequence[Word], anchors: Sequence[float]) -> list[str]:
    """Partition one line using detected header anchors.

    Boundaries sit just before the next header anchor. This preserves long
    values in the preceding column and tolerates the observed page-to-page
    anchor drift.
    """

    if len(anchors) < 2:
        raise ValueError("At least two column anchors are required")
    boundaries: list[float] = []
    for current, following in pairwise(anchors):
        gap = following - current
        gutter = min(14.0, max(6.0, gap * 0.1))
        boundaries.append(following - gutter)
    columns: list[list[Word]] = [[] for _ in anchors]
    for word in line:
        column = 0
        while column < len(boundaries) and word.x0 >= boundaries[column]:
            column += 1
        columns[column].append(word)
    return [words_to_text(column) for column in columns]


def month_number(value: str) -> int:
    """Resolve full or abbreviated English month names."""

    cleaned = re.sub(r"[^A-Za-z]", "", value).lower()
    for number in range(1, 13):
        full = calendar.month_name[number].lower()
        abbreviation = calendar.month_abbr[number].lower()
        if cleaned in {full, abbreviation}:
            return number
        if number == 9 and cleaned == "sept":
            return number
    raise ValueError(f"Unknown month token: {value!r}")


def parse_date_text(raw: str, year: int) -> DateSpan | None:
    """Parse the publication's month/day and inclusive range formats."""

    cleaned = normalize_space(raw)
    cleaned = cleaned.replace("\u2011", "-").replace("\u2212", "-")
    cleaned = cleaned.strip("*†‡ ")
    match = DATE_PATTERN.fullmatch(cleaned)
    if not match:
        return None
    try:
        start_month = month_number(match.group("start_month"))
        start_day = int(match.group("start_day"))
        end_month_raw = match.group("end_month")
        end_day_raw = match.group("end_day")
        start = dt.date(year, start_month, start_day)
        if end_day_raw is None:
            end = start
        else:
            end_month = month_number(end_month_raw) if end_month_raw else start_month
            end_year = year + 1 if end_month < start_month else year
            end = dt.date(end_year, end_month, int(end_day_raw))
        return DateSpan(start=start, end=end, raw=cleaned)
    except ValueError:
        return None


def looks_like_date(value: str) -> bool:
    """Return whether a cell begins with an English month token."""

    cleaned = normalize_space(value).strip("*†‡ ")
    return bool(re.match(rf"^{MONTH_PATTERN}\s+\d", cleaned, re.IGNORECASE))


def extract_date_suffix(value: str) -> tuple[str, str] | None:
    """Split a directory line into name and trailing date text."""

    cleaned = normalize_space(value)
    searchable = re.sub(r"\.{2,}", " ", cleaned)
    match = DATE_SUFFIX_PATTERN.search(searchable)
    if not match:
        return None
    name = searchable[: match.start()].strip(" .,:;-")
    return normalize_space(name), normalize_space(match.group("date"))


def _header_anchor(line: Sequence[Word], value: str) -> float | None:
    for word in line:
        if word.text == value:
            return word.x0
    return None


def parse_observances(
    pages: dict[int, list[Word]],
) -> tuple[list[Observance], dict[str, object]]:
    """Parse Part I using each page's own detected table headers."""

    records: list[Observance] = []
    pages_with_headers: list[int] = []
    missing_headers: list[int] = []
    for page_number in PART_I_PAGES:
        lines = cluster_lines(pages[page_number])
        header: tuple[float, int, list[float]] | None = None
        for line in lines:
            name_anchor = _header_anchor(line, "NAME")
            comments_anchor = _header_anchor(line, "COMMENTS")
            year_words = [word for word in line if word.text in {"2026", "2027"}]
            if name_anchor is None or comments_anchor is None or not year_words:
                continue
            year_word = min(year_words, key=lambda item: item.x0)
            header = (
                max(word.y1 for word in line),
                int(year_word.text),
                [year_word.x0, name_anchor, comments_anchor],
            )
            break
        if header is None:
            missing_headers.append(page_number)
            continue
        pages_with_headers.append(page_number)
        header_bottom, year, anchors = header
        current: Observance | None = None
        for line in lines:
            if min(word.y0 for word in line) <= header_bottom + 2:
                continue
            if min(word.y0 for word in line) >= 735:
                continue
            date_cell, name_cell, comments_cell = partition_line(line, anchors)
            if looks_like_date(date_cell):
                if (
                    current is not None
                    and current.raw_date.rstrip().endswith(("-", "–", "—"))
                    and not name_cell
                ):
                    combined_date = f"{current.raw_date.rstrip()}{date_cell.lstrip()}"
                    current.raw_date = combined_date
                    current.date = parse_date_text(combined_date, year)
                    current.comments = join_fragments(current.comments, comments_cell)
                    continue
                if current is not None:
                    records.append(current)
                current = Observance(
                    raw_date=date_cell,
                    date=parse_date_text(date_cell, year),
                    name=name_cell,
                    comments=comments_cell,
                    pdf_page=page_number,
                )
                continue
            if current is None:
                continue
            current.name = join_fragments(current.name, name_cell)
            current.comments = join_fragments(current.comments, comments_cell)
        if current is not None:
            records.append(current)
    return records, {
        "part_i_pages_with_headers": pages_with_headers,
        "part_i_pages_missing_headers": missing_headers,
    }


def parse_directory(pages: dict[int, list[Word]]) -> list[DirectoryEntry]:
    """Parse the independently typeset alphabetical directory by columns."""

    entries: list[DirectoryEntry] = []
    current_year = 2026
    for page_number in DIRECTORY_PAGES:
        page_words = pages[page_number]
        page_width = max(612.0, max((word.x1 for word in page_words), default=0))
        # The directory has narrow whitespace gutters immediately before the
        # second and third column starts. Assign by each word's x-origin so a
        # long date token remains in the column where it begins.
        boundaries = (
            0.0,
            page_width * 0.356,
            page_width * 0.640,
            page_width + 1,
        )
        minimum_y = 140.0 if page_number == 5 else 38.0
        for column in range(3):
            column_words = [
                word
                for word in page_words
                if boundaries[column] <= word.x0 < boundaries[column + 1]
                and minimum_y <= word.y0 < 730
            ]
            pending = ""
            pending_x: float | None = None
            parent_heading = ""
            parent_x: float | None = None
            for line in cluster_lines(column_words):
                text = words_to_text(line)
                line_x = min(word.x0 for word in line)
                if not text:
                    continue
                year_match = YEAR_HEADING_PATTERN.fullmatch(text)
                if year_match:
                    current_year = int(year_match.group(1))
                    pending = ""
                    pending_x = None
                    parent_heading = ""
                    parent_x = None
                    continue
                if re.fullmatch(r"[ivx]+", text, re.IGNORECASE):
                    continue
                had_pending = bool(pending)
                candidate = join_fragments(pending, text)
                extracted = extract_date_suffix(candidate)
                if extracted is None:
                    pending = candidate
                    if pending_x is None:
                        pending_x = line_x
                    continue
                name, raw_date = extracted
                if had_pending and pending_x is not None and line_x > pending_x + 3:
                    parent_heading = pending
                    parent_x = pending_x
                elif (
                    not had_pending
                    and parent_heading
                    and parent_x is not None
                    and line_x > parent_x + 3
                ):
                    name = join_fragments(parent_heading, name)
                elif (
                    not had_pending and parent_x is not None and line_x <= parent_x + 3
                ):
                    parent_heading = ""
                    parent_x = None
                pending = ""
                pending_x = None
                entries.append(
                    DirectoryEntry(
                        raw_date=raw_date,
                        date=parse_date_text(raw_date, current_year),
                        name=name,
                        pdf_page=page_number,
                    )
                )
    return entries


def parse_states(pages: dict[int, list[Word]]) -> dict[str, StateDocument]:
    """Parse Part II's state and section hierarchy."""

    normalized_states = {normalize_space(name).casefold(): name for name in STATE_NAMES}
    states: dict[str, StateDocument] = {}
    current_state: StateDocument | None = None
    current_section: str | None = None
    for page_number in STATE_PAGES:
        footer_started = False
        for line in cluster_lines(pages[page_number]):
            if min(word.y0 for word in line) < 30:
                continue
            if min(word.y0 for word in line) >= 745:
                continue
            text = words_to_text(line)
            if not text:
                continue
            if text.startswith("*For each state"):
                footer_started = True
            if footer_started:
                continue
            if text.isdigit() and min(word.y0 for word in line) > 700:
                continue
            state_key = text.rstrip("*").strip().casefold()
            if state_key in normalized_states:
                state_name = normalized_states[state_key]
                current_state = states.setdefault(
                    state_name, StateDocument(name=state_name)
                )
                current_state.pages.add(page_number)
                current_section = None
                continue
            section_match = STATE_SECTION_PATTERN.fullmatch(text)
            if section_match and current_state is not None:
                section_label = section_match.group(1).casefold()
                current_section = (
                    "State legal holiday"
                    if section_label.startswith("state legal")
                    else "School holidays"
                )
                current_state.sections.setdefault(current_section, [])
                current_state.pages.add(page_number)
                continue
            if current_state is None or current_section is None:
                continue
            current_state.sections[current_section].append(text)
            current_state.pages.add(page_number)
    return states


def parse_summary(pages: dict[int, list[Word]]) -> dict[int, list[SummaryHoliday]]:
    """Parse the two-column six-year summary independently by column."""

    page_words = pages[SUMMARY_PAGE]
    width = max(612.0, max((word.x1 for word in page_words), default=0))
    summary: dict[int, list[SummaryHoliday]] = defaultdict(list)
    for lower, upper in ((0.0, width / 2), (width / 2, width + 1)):
        column_words = [
            word
            for word in page_words
            if lower <= word.x0 < upper and 75 <= word.y0 < 700
        ]
        current_year: int | None = None
        pending = ""
        for line in cluster_lines(column_words):
            text = words_to_text(line)
            year_match = YEAR_HEADING_PATTERN.fullmatch(text)
            if year_match:
                current_year = int(year_match.group(1))
                pending = ""
                continue
            if current_year is None:
                continue
            searchable = re.sub(r"\.{2,}", " ", text)
            candidate = join_fragments(pending, searchable)
            suffix = SUMMARY_SUFFIX_PATTERN.search(candidate)
            if suffix is None:
                pending = candidate
                continue
            name = candidate[: suffix.start()].strip(" .*†‡")
            pending = ""
            month = month_number(suffix.group("month"))
            day = int(suffix.group("day"))
            try:
                holiday_date = dt.date(current_year, month, day)
            except ValueError:
                continue
            summary[current_year].append(
                SummaryHoliday(
                    year=current_year,
                    name=name,
                    date=holiday_date,
                    stated_weekday=suffix.group("weekday").title(),
                    pdf_page=SUMMARY_PAGE,
                )
            )
    return dict(summary)


def parse_conferences(
    pages: dict[int, list[Word]],
) -> tuple[list[Conference], list[dict[str, object]]]:
    """Parse Part III with per-page four-column header anchors."""

    conferences: list[Conference] = []
    malformed: list[dict[str, object]] = []
    for page_number in CONFERENCE_PAGES:
        lines = cluster_lines(pages[page_number])
        header: tuple[float, int, list[float]] | None = None
        for line in lines:
            name_anchor = _header_anchor(line, "NAME")
            address_anchor = _header_anchor(line, "ADDRESS/WEB")
            contact_anchor = _header_anchor(line, "TEL/FAX/EMAIL")
            years = [
                word for word in line if word.text in {str(y) for y in SUMMARY_YEARS}
            ]
            if (
                name_anchor is None
                or address_anchor is None
                or contact_anchor is None
                or not years
            ):
                continue
            year_word = min(years, key=lambda item: item.x0)
            header = (
                max(word.y1 for word in line),
                int(year_word.text),
                [year_word.x0, name_anchor, address_anchor, contact_anchor],
            )
            break
        if header is None:
            malformed.append({"pdf_page": page_number, "reason": "missing_header"})
            continue
        header_bottom, year, anchors = header
        current: Conference | None = None
        for line in lines:
            if min(word.y0 for word in line) <= header_bottom + 2:
                continue
            if min(word.y0 for word in line) >= 735:
                continue
            date_cell, name_cell, address_cell, contact_cell = partition_line(
                line, anchors
            )
            if looks_like_date(date_cell):
                if current is not None:
                    conferences.append(current)
                parsed = parse_date_text(date_cell, year)
                if parsed is None:
                    malformed.append(
                        {
                            "pdf_page": page_number,
                            "raw_date": date_cell,
                            "reason": "invalid_date",
                        }
                    )
                current = Conference(
                    year=year,
                    raw_date=date_cell,
                    date=parsed,
                    organization=name_cell,
                    location="",
                    address_web=address_cell,
                    contact=contact_cell,
                    pdf_page=page_number,
                )
                continue
            if current is None:
                continue
            current.location = join_fragments(current.location, date_cell)
            current.organization = join_fragments(current.organization, name_cell)
            current.address_web = join_fragments(current.address_web, address_cell)
            current.contact = join_fragments(current.contact, contact_cell)
        if current is not None:
            conferences.append(current)
    return conferences, malformed


def normalize_name_tokens(value: str) -> set[str]:
    """Normalize a fact-only title for directory-to-table reconciliation."""

    ascii_value = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    )
    tokens = re.findall(r"[a-z0-9]+", ascii_value.casefold())
    stopwords = {
        "a",
        "an",
        "and",
        "day",
        "days",
        "international",
        "month",
        "national",
        "observance",
        "observances",
        "of",
        "the",
        "week",
        "weeks",
        "world",
    }
    return {token for token in tokens if token not in stopwords}


def name_match_score(left: str, right: str) -> float:
    """Score reordered directory titles without relying on source prose."""

    left_tokens = normalize_name_tokens(left)
    right_tokens = normalize_name_tokens(right)
    if left_tokens == right_tokens and left_tokens:
        return 1.0
    if left_tokens and right_tokens:
        intersection = len(left_tokens & right_tokens)
        union = len(left_tokens | right_tokens)
        jaccard = intersection / union
        containment = intersection / min(len(left_tokens), len(right_tokens))
    else:
        jaccard = 0.0
        containment = 0.0
    sequence = difflib.SequenceMatcher(
        None,
        " ".join(sorted(left_tokens)),
        " ".join(sorted(right_tokens)),
    ).ratio()
    return max(jaccard, containment * 0.9, sequence * 0.8)


def reconcile_directory(
    directory_entries: Sequence[DirectoryEntry],
    observances: Sequence[Observance],
) -> tuple[int, list[dict[str, object]]]:
    """Match independently parsed directory entries to Part I records."""

    valid_observances = [item for item in observances if item.date is not None]
    matched = 0
    mismatches: list[dict[str, object]] = []
    for entry in directory_entries:
        if entry.date is None:
            mismatches.append(
                {
                    "name": entry.name,
                    "raw_date": entry.raw_date,
                    "pdf_page": entry.pdf_page,
                    "reason": "invalid_directory_date",
                }
            )
            continue
        candidates = [
            item
            for item in valid_observances
            if item.date is not None
            and item.date.start == entry.date.start
            and item.date.end == entry.date.end
        ]
        scored = [
            (name_match_score(entry.name, candidate.name), candidate)
            for candidate in candidates
        ]
        best_score = max((score for score, _ in scored), default=0.0)
        meaningful_tokens = normalize_name_tokens(entry.name)
        unique_fact_match = len(candidates) == 1 and (
            not meaningful_tokens or best_score >= 0.25
        )
        # Reordered personal-name entries (for example "Surname, Given") can
        # score just below 0.5 after possessives and title words are removed.
        # The date must still be identical, so 0.45 remains a conservative
        # name corroboration threshold.
        if best_score >= 0.45 or unique_fact_match:
            matched += 1
            continue
        mismatches.append(
            {
                "name": entry.name,
                "date": entry.date.iso_text(),
                "pdf_page": entry.pdf_page,
                "candidate_count": len(candidates),
                "best_name_score": round(best_score, 3),
                "reason": "no_identical_date_and_name_match",
            }
        )
    return matched, mismatches


def _run_git(repo_root: Path, arguments: Sequence[str]) -> list[str]:
    completed = subprocess.run(
        ["git", "-C", str(repo_root), *arguments],
        check=True,
        capture_output=True,
        text=False,
    )
    return [item.decode("utf-8") for item in completed.stdout.split(b"\0") if item]


def copyright_guard_violations(repo_root: Path) -> list[str]:
    """Return tracked-output or unapproved-PDF violations."""

    tracked = _run_git(repo_root, ["ls-files", "-z"])
    generated_prefix = f"{GENERATED_REPOSITORY_PATH}/"
    violations = [path for path in tracked if path.startswith(generated_prefix)]
    violations.extend(
        path
        for path in tracked
        if path.casefold().endswith(".pdf") and path not in ALLOWED_TRACKED_PDFS
    )
    return sorted(set(violations))


def verify(extraction: Extraction, repo_root: Path) -> list[dict[str, object]]:
    """Evaluate all six issue gates and retain fact-only failure evidence."""

    matched, directory_mismatches = reconcile_directory(
        extraction.directory_entries, extraction.observances
    )
    directory_total = len(extraction.directory_entries)
    directory_ratio = matched / directory_total if directory_total else 0.0
    gate_1 = {
        "gate": 1,
        "name": "directory_cross_check",
        "passed": directory_total >= 500 and directory_ratio >= 0.99,
        "directory_entries": directory_total,
        "matched_entries": matched,
        "match_ratio": round(directory_ratio, 5),
        "mismatches": directory_mismatches,
    }

    state_failures: list[dict[str, object]] = []
    for state_name in STATE_NAMES:
        state = extraction.states.get(state_name)
        if state is None:
            state_failures.append({"state": state_name, "reason": "missing_document"})
            continue
        content = " ".join(
            fragment for fragments in state.sections.values() for fragment in fragments
        )
        if not state.sections:
            state_failures.append({"state": state_name, "reason": "missing_section"})
        if not STATUTE_PATTERN.search(content):
            state_failures.append(
                {"state": state_name, "reason": "missing_statute_citation"}
            )
    gate_2 = {
        "gate": 2,
        "name": "state_documents",
        "passed": len(extraction.states) == 51 and not state_failures,
        "document_count": len(extraction.states),
        "failures": state_failures,
    }

    invalid_observances: list[dict[str, object]] = []
    for item in extraction.observances:
        if item.date is None:
            invalid_observances.append(
                {
                    "name": item.name,
                    "raw_date": item.raw_date,
                    "pdf_page": item.pdf_page,
                    "reason": "unparsed_date",
                }
            )
            continue
        if (
            item.date.start < COVERAGE_START
            or item.date.end > COVERAGE_END
            or item.date.end < item.date.start
        ):
            invalid_observances.append(
                {
                    "name": item.name,
                    "date": item.date.iso_text(),
                    "pdf_page": item.pdf_page,
                    "reason": "out_of_range",
                }
            )
    gate_3 = {
        "gate": 3,
        "name": "observance_dates",
        "passed": bool(extraction.observances) and not invalid_observances,
        "observance_count": len(extraction.observances),
        "failures": invalid_observances,
    }

    summary_failures: list[dict[str, object]] = []
    summary_counts: dict[str, int] = {}
    for year in SUMMARY_YEARS:
        records = extraction.summary.get(year, [])
        summary_counts[str(year)] = len(records)
        if not 15 <= len(records) <= 18:
            summary_failures.append(
                {
                    "year": year,
                    "count": len(records),
                    "reason": "expected_15_to_18_records",
                }
            )
        for record in records:
            computed = record.date.strftime("%A")
            if computed != record.stated_weekday:
                summary_failures.append(
                    {
                        "year": year,
                        "name": record.name,
                        "date": record.date.isoformat(),
                        "stated_weekday": record.stated_weekday,
                        "computed_weekday": computed,
                        "reason": "weekday_mismatch",
                    }
                )
    gate_4 = {
        "gate": 4,
        "name": "six_year_summary",
        "passed": not summary_failures,
        "counts": summary_counts,
        "failures": summary_failures,
    }

    conference_failures: list[dict[str, object]] = list(
        extraction.malformed_conference_rows
    )
    missing_contact: list[dict[str, object]] = []
    valid_conferences = 0
    for item in extraction.conferences:
        if item.date is None or not item.organization:
            conference_failures.append(
                {
                    "pdf_page": item.pdf_page,
                    "raw_date": item.raw_date,
                    "organization": item.organization,
                    "reason": "missing_organization_or_start_date",
                }
            )
            continue
        valid_conferences += 1
        if not item.has_contact_route:
            missing_contact.append(
                {
                    "organization": item.organization,
                    "date": item.date.iso_text(),
                    "pdf_page": item.pdf_page,
                }
            )
    contact_ratio = (
        (valid_conferences - len(missing_contact)) / valid_conferences
        if valid_conferences
        else 0.0
    )
    gate_5 = {
        "gate": 5,
        "name": "conference_records",
        "passed": (
            valid_conferences >= 40
            and not conference_failures
            and contact_ratio >= 0.95
        ),
        "conference_count": valid_conferences,
        "contact_ratio": round(contact_ratio, 5),
        "failures": conference_failures,
        "missing_contact": missing_contact,
    }

    copyright_violations = copyright_guard_violations(repo_root)
    gate_6 = {
        "gate": 6,
        "name": "copyright_guard",
        "passed": not copyright_violations,
        "violations": copyright_violations,
    }
    return [gate_1, gate_2, gate_3, gate_4, gate_5, gate_6]


def _printed_pages(pdf_pages: Iterable[int]) -> str:
    return ", ".join(str(page - 10) for page in sorted(set(pdf_pages)))


def _safe_heading(value: str) -> str:
    cleaned = normalize_space(value).lstrip("#").strip()
    return cleaned or "Untitled record"


def month_keys() -> list[tuple[int, int]]:
    keys: list[tuple[int, int]] = []
    cursor = COVERAGE_START.replace(day=1)
    while cursor <= COVERAGE_END:
        keys.append((cursor.year, cursor.month))
        if cursor.month == 12:
            cursor = dt.date(cursor.year + 1, 1, 1)
        else:
            cursor = dt.date(cursor.year, cursor.month + 1, 1)
    return keys


def render_documents(extraction: Extraction) -> dict[str, str]:
    """Render exactly 76 retrieval items without writing them yet."""

    documents: dict[str, str] = {}
    grouped_observances: dict[tuple[int, int], list[Observance]] = defaultdict(list)
    for item in extraction.observances:
        if item.date is not None:
            grouped_observances[(item.date.start.year, item.date.start.month)].append(
                item
            )
    for year, month in month_keys():
        title = f"Observances {year:04d}-{month:02d}"
        lines = [f"# {title}", ""]
        for item in sorted(
            grouped_observances[(year, month)],
            key=lambda value: (
                value.date.start if value.date else dt.date.max,
                value.name.casefold(),
            ),
        ):
            lines.extend(
                [
                    f"## {_safe_heading(item.name)}",
                    "",
                    (
                        f"{item.date.iso_text()} — {normalize_space(item.comments)}"
                        if item.date
                        else normalize_space(item.comments)
                    ).rstrip(" —"),
                    "",
                    f"Printed page: {item.pdf_page - 10}.",
                    "",
                ]
            )
        documents[f"{title}.md"] = "\n".join(lines).rstrip() + "\n"

    for state_name in STATE_NAMES:
        state = extraction.states.get(state_name, StateDocument(name=state_name))
        title = f"State Holidays — {state_name}"
        lines = [
            f"# {title}",
            "",
            f"Printed pages: {_printed_pages(state.pages) or 'not found'}.",
            "",
        ]
        for section_name in ("State legal holiday", "School holidays"):
            fragments = state.sections.get(section_name)
            if not fragments:
                continue
            lines.extend(
                [
                    f"## {section_name}",
                    "",
                    normalize_space(" ".join(fragments)),
                    "",
                ]
            )
        documents[f"{title}.md"] = "\n".join(lines).rstrip() + "\n"

    grouped_conferences: dict[int, list[Conference]] = defaultdict(list)
    for item in extraction.conferences:
        if item.date is not None:
            grouped_conferences[item.year].append(item)
    for year in CONFERENCE_YEARS:
        title = f"Education Conferences {year}"
        lines = [f"# {title}", ""]
        records = sorted(
            grouped_conferences[year],
            key=lambda item: (
                item.date.start if item.date else dt.date.max,
                item.organization.casefold(),
            ),
        )
        if not records:
            lines.extend(
                [
                    "No dated meetings are listed for this year in this edition.",
                    "",
                ]
            )
        for item in records:
            details = "; ".join(
                fragment
                for fragment in (
                    normalize_space(item.location),
                    normalize_space(item.address_web),
                    normalize_space(item.contact),
                )
                if fragment
            )
            lines.extend(
                [
                    f"## {_safe_heading(item.organization)}",
                    "",
                    f"{item.date.iso_text()} — {details}".rstrip(" —"),
                    "",
                    f"Printed page: {item.pdf_page - 10}.",
                    "",
                ]
            )
        documents[f"{title}.md"] = "\n".join(lines).rstrip() + "\n"

    summary_title = "Six-Year Holiday Summary 2026-2031"
    summary_lines = [f"# {summary_title}", ""]
    for year in SUMMARY_YEARS:
        summary_lines.extend([f"## {year}", ""])
        for item in extraction.summary.get(year, []):
            summary_lines.append(
                f"{item.date.isoformat()} — {_safe_heading(item.name)} "
                f"({item.stated_weekday}); printed page {item.pdf_page - 10}."
            )
        summary_lines.append("")
    documents[f"{summary_title}.md"] = "\n".join(summary_lines).rstrip() + "\n"
    return documents


def write_documents(output_directory: Path, documents: dict[str, str]) -> None:
    """Write a new output directory without overwriting prior evidence."""

    if output_directory.exists() and any(output_directory.iterdir()):
        raise ValueError(
            f"Output directory must be absent or empty: {output_directory}"
        )
    output_directory.mkdir(parents=True, exist_ok=True)
    for filename, body in sorted(documents.items()):
        (output_directory / filename).write_text(body, encoding="utf-8")


def load_pdf_pages(pdf_path: Path) -> dict[int, list[Word]]:
    """Load only the pages needed by the extractor through lazy PyMuPDF import."""

    try:
        import pymupdf  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError(
            "PyMuPDF is required. Run through uv with --with pymupdf."
        ) from error

    pages: dict[int, list[Word]] = {}
    with pymupdf.open(str(pdf_path)) as document:
        if document.page_count < PDF_PAGE_COUNT_MINIMUM:
            raise ValueError(
                f"Expected at least {PDF_PAGE_COUNT_MINIMUM} PDF pages; "
                f"found {document.page_count}"
            )
        required_pages = sorted(
            set(DIRECTORY_PAGES)
            | set(PART_I_PAGES)
            | {SUMMARY_PAGE}
            | set(STATE_PAGES)
            | set(CONFERENCE_PAGES)
        )
        for page_number in required_pages:
            raw_words = document[page_number - 1].get_text("words", sort=False)
            pages[page_number] = [
                Word(
                    x0=float(raw[0]),
                    y0=float(raw[1]),
                    x1=float(raw[2]),
                    y1=float(raw[3]),
                    text=str(raw[4]),
                    block=int(raw[5]),
                    line=int(raw[6]),
                    order=int(raw[7]),
                )
                for raw in raw_words
            ]
    return pages


def extract_pdf(pdf_path: Path) -> Extraction:
    """Run all independent coordinate parsers."""

    pages = load_pdf_pages(pdf_path)
    observances, metadata = parse_observances(pages)
    conferences, malformed_conferences = parse_conferences(pages)
    return Extraction(
        observances=observances,
        directory_entries=parse_directory(pages),
        states=parse_states(pages),
        summary=parse_summary(pages),
        conferences=conferences,
        malformed_conference_rows=malformed_conferences,
        metadata=metadata,
    )


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate and verify retrieval-oriented Markdown from an authorized "
            "NSPRA planning calendar."
        )
    )
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[5],
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.resolve()
    pdf_path = args.pdf.resolve()
    output_directory = args.out.resolve()
    report_path = args.report.resolve()

    if not pdf_path.is_file() or pdf_path.suffix.casefold() != ".pdf":
        raise ValueError("--pdf must name an existing PDF file")
    for label, path in (
        ("source PDF", pdf_path),
        ("output directory", output_directory),
        ("verification report", report_path),
    ):
        if _is_within(path, repo_root):
            raise ValueError(f"{label} must remain outside the Git worktree")
    if _is_within(report_path, output_directory):
        raise ValueError("Verification report must be outside the item directory")
    if output_directory.exists() and any(output_directory.iterdir()):
        raise ValueError(
            f"Output directory must be absent or empty: {output_directory}"
        )

    extraction = extract_pdf(pdf_path)
    documents = render_documents(extraction)
    gates = verify(extraction, repo_root)
    report = {
        "schema_version": 1,
        "source": {
            "page_count_minimum": PDF_PAGE_COUNT_MINIMUM,
            "coverage_start": COVERAGE_START.isoformat(),
            "coverage_end": COVERAGE_END.isoformat(),
        },
        "generated": {
            "markdown_item_count": len(documents),
            "observance_items": 18,
            "state_items": 51,
            "conference_items": 6,
            "summary_items": 1,
        },
        "parser": extraction.metadata,
        "gates": gates,
        "passed": len(documents) == 76 and all(bool(gate["passed"]) for gate in gates),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    write_documents(output_directory, documents)

    summary = {
        "passed": report["passed"],
        "markdown_item_count": len(documents),
        "observance_count": len(extraction.observances),
        "directory_entry_count": len(extraction.directory_entries),
        "state_document_count": len(extraction.states),
        "conference_count": len(extraction.conferences),
        "report": str(report_path),
        "gate_status": {str(gate["gate"]): bool(gate["passed"]) for gate in gates},
    }
    print(json.dumps(summary, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"passed": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2) from error
