"""Tests for psd-last30days. Plain pytest — no fixtures beyond unittest.mock,
matching the existing test_*.py style under infra/agent-image/.

Run: cd infra/agent-image/skills/psd-last30days && python3 -m pytest test_last30days.py -q
"""

import json
import os
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))

import last30days  # noqa: E402
import sources  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(__file__), "scripts", "last30days.py")


def test_valid_email():
    assert last30days._valid_email("hagelk@psd401.net")
    assert not last30days._valid_email("not-an-email")
    assert not last30days._valid_email("a/b@psd401.net")
    assert not last30days._valid_email("")


def test_build_markdown_groups_by_source_and_sorts_alphabetically():
    grouped = {
        "reddit": [
            {"title": "R1", "url": "https://reddit.com/r1", "published": "2026-07-01T00:00:00+00:00", "snippet": "hello"}
        ],
        "arxiv": [
            {"title": "A1", "url": "https://arxiv.org/a1", "published": "2026-07-02T00:00:00+00:00", "snippet": ""}
        ],
    }
    md = last30days.build_markdown("test topic", 30, grouped, [])
    assert "# Last 30 Days: test topic" in md
    assert md.index("## Arxiv") < md.index("## Reddit")
    assert "[R1](https://reddit.com/r1)" in md
    assert "hello" in md


def test_build_markdown_empty_results():
    md = last30days.build_markdown("nothing", 30, {}, [{"source": "reddit", "error": "timed out"}])
    assert "No results found" in md
    assert "reddit (timed out)" in md


def test_build_html_escapes_and_includes_sections():
    grouped = {
        "web": [
            {"title": "<script>alert(1)</script>", "url": "https://example.com", "published": "2026-07-01", "snippet": "x"}
        ]
    }
    out = last30days.build_html("t", 30, grouped, [])
    assert "<script>alert(1)</script>" not in out
    assert "&lt;script&gt;" in out


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_fetch_hackernews_parses_response():
    payload = json.dumps(
        {
            "hits": [
                {
                    "title": "Show HN: thing",
                    "url": "https://example.com/thing",
                    "created_at": "2026-07-05T12:00:00.000Z",
                    "points": 42,
                    "num_comments": 3,
                    "objectID": "123",
                }
            ]
        }
    ).encode("utf-8")
    with patch("urllib.request.urlopen", return_value=_FakeResponse(payload)):
        items = sources.fetch_hackernews("thing", 30, 10)
    assert len(items) == 1
    assert items[0]["source"] == "hackernews"
    assert items[0]["title"] == "Show HN: thing"
    assert "42 points" in items[0]["snippet"]


def test_fetch_github_raises_source_error_on_api_error_payload():
    payload = json.dumps({"message": "API rate limit exceeded"}).encode("utf-8")
    with patch("urllib.request.urlopen", return_value=_FakeResponse(payload)):
        try:
            sources.fetch_github("thing", 30, 10)
            raise AssertionError("expected SourceError")
        except sources.SourceError as exc:
            assert "rate limit" in str(exc)


def test_cli_rejects_missing_topic():
    result = subprocess.run(
        [sys.executable, SCRIPT, "--user", "hagelk@psd401.net"],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0


def test_cli_rejects_invalid_email():
    result = subprocess.run(
        [sys.executable, SCRIPT, "--topic", "x", "--user", "not-an-email"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout.strip())
    assert out["status"] == "error"
    assert out["error"] == "bad_args"


def test_cli_rejects_unknown_source():
    result = subprocess.run(
        [sys.executable, SCRIPT, "--topic", "x", "--user", "hagelk@psd401.net", "--sources", "tiktok"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout.strip())
    assert out["error"] == "bad_args"
