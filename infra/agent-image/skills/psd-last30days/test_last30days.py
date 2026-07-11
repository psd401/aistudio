"""Tests for psd-last30days. Plain pytest — no fixtures beyond unittest.mock,
matching the existing test_*.py style under infra/agent-image/.

Run: cd infra/agent-image/skills/psd-last30days && python3 -m pytest test_last30days.py -q
"""

import json
import os
import subprocess
import sys
import time
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


def test_valid_email_rejects_oversized_input_quickly():
    # A crafted near-miss (no closing dot) forces the naive regex to backtrack
    # across the whole string before failing — the length cap must reject it
    # before the regex ever runs, bounding the cost regardless of input size.
    adversarial = "a@" + ("b" * 50_000)
    start = time.monotonic()
    result = last30days._valid_email(adversarial)
    elapsed = time.monotonic() - start
    assert result is False
    assert elapsed < 1.0


def test_safe_href_neutralizes_dangerous_schemes():
    assert last30days._safe_href("javascript:alert(1)") == "#"
    assert last30days._safe_href("data:text/html,<script>1</script>") == "#"
    assert last30days._safe_href("https://example.com/x") == "https://example.com/x"
    assert last30days._safe_href("http://example.com/x") == "http://example.com/x"


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


def test_build_html_neutralizes_javascript_href():
    grouped = {
        "reddit": [
            {"title": "click me", "url": "javascript:alert(document.cookie)", "published": "2026-07-01", "snippet": ""}
        ]
    }
    out = last30days.build_html("t", 30, grouped, [])
    assert "javascript:" not in out
    assert 'href="#"' in out


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def read(self, amt=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patched_opener(payload):
    return patch.object(sources._OPENER, "open", return_value=_FakeResponse(payload))


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
    with _patched_opener(payload):
        items = sources.fetch_hackernews("thing", 30, 10)
    assert len(items) == 1
    assert items[0]["source"] == "hackernews"
    assert items[0]["title"] == "Show HN: thing"
    assert "42 points" in items[0]["snippet"]


def test_fetch_hackernews_skips_hit_without_object_id():
    payload = json.dumps({"hits": [{"title": "no id", "created_at": "2026-07-05T12:00:00.000Z"}]}).encode("utf-8")
    with _patched_opener(payload):
        items = sources.fetch_hackernews("thing", 30, 10)
    assert items == []


def test_fetch_reddit_accepts_naive_timestamp_as_utc():
    # Some feeds may omit an explicit offset; _parse_iso must treat it as UTC
    # rather than raising (a prior bug compared naive vs. aware datetimes).
    body = (
        b'<feed xmlns="http://www.w3.org/2005/Atom">'
        b'<entry><title>naive ts</title>'
        b'<link href="https://reddit.com/r/x/1" rel="alternate"/>'
        b'<updated>2026-07-05T00:00:00</updated>'
        b'<content>hello world</content></entry>'
        b'</feed>'
    )
    with _patched_opener(body):
        items = sources.fetch_reddit("thing", 365, 10)
    assert len(items) == 1
    assert items[0]["url"] == "https://reddit.com/r/x/1"


def test_fetch_arxiv_uses_https():
    captured = {}

    def fake_open(req, timeout=None):
        captured["url"] = req.full_url
        return _FakeResponse(b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>')

    with patch.object(sources._OPENER, "open", side_effect=fake_open):
        sources.fetch_arxiv("thing", 30, 10)
    assert captured["url"].startswith("https://export.arxiv.org/")


def test_fetch_github_raises_source_error_on_api_error_payload():
    payload = json.dumps({"message": "API rate limit exceeded"}).encode("utf-8")
    with _patched_opener(payload):
        try:
            sources.fetch_github("thing", 30, 10)
            raise AssertionError("expected SourceError")
        except sources.SourceError as exc:
            assert "rate limit" in str(exc)


def test_fetch_raises_source_error_on_malformed_json():
    with _patched_opener(b"not json{{"):
        try:
            sources.fetch_hackernews("thing", 30, 10)
            raise AssertionError("expected SourceError")
        except sources.SourceError:
            pass


def test_cli_rejects_missing_topic():
    result = subprocess.run(
        [sys.executable, SCRIPT, "--user", "hagelk@psd401.net"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout.strip())
    assert out["status"] == "error"
    assert out["error"] == "bad_args"


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


def test_cli_rejects_empty_sources():
    result = subprocess.run(
        [sys.executable, SCRIPT, "--topic", "x", "--user", "hagelk@psd401.net", "--sources", " , ,"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout.strip())
    assert out["error"] == "bad_args"


def test_cli_rejects_html_format_without_bucket():
    env = {k: v for k, v in os.environ.items() if k != "WORKSPACE_BUCKET"}
    result = subprocess.run(
        [sys.executable, SCRIPT, "--topic", "x", "--user", "hagelk@psd401.net", "--format", "html", "--sources", "github"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 1
    out = json.loads(result.stdout.strip())
    assert out["error"] == "misconfigured"
