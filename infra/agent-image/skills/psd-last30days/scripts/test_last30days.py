"""Tests for last30days.py — psd-last30days engine.

Covers: CLI arg parsing + normalization (including --format selection and its
--user requirement, day/limit clamping, source selection), one source adapter
(Hacker News) with fully mocked HTTP I/O, the host/scheme allowlist on _fetch,
and the stored-XSS escaping guarantee of the HTML renderer.

No network is touched: _fetch is monkeypatched. Run:
    uv run --python 3.12 --no-project python3 -m unittest \
        infra/agent-image/skills/psd-last30days/scripts/test_last30days.py
or simply:
    python3 -m unittest test_last30days   (from this directory)
"""

import datetime as dt
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import last30days  # noqa: E402


def _cfg(argv):
    return last30days.normalize_config(last30days.build_parser().parse_args(argv))


class ConfigTests(unittest.TestCase):
    def test_topic_required(self):
        with self.assertRaises(last30days.ConfigError) as ctx:
            _cfg([])
        self.assertEqual(ctx.exception.code, "bad_args")

    def test_topic_accepts_query_alias(self):
        cfg = _cfg(["--query", "gpt-5"])
        self.assertEqual(cfg["topic"], "gpt-5")

    def test_default_format_is_md_and_needs_no_user(self):
        cfg = _cfg(["--topic", "chromebooks"])
        self.assertEqual(cfg["fmt"], "md")
        self.assertEqual(cfg["days"], 30)
        self.assertEqual(cfg["sources"], list(last30days.ALL_SOURCES))

    def test_invalid_format_rejected_by_argparse(self):
        # argparse `choices` exits(2) on an invalid value.
        with self.assertRaises(SystemExit):
            last30days.build_parser().parse_args(["--topic", "x", "--format", "pdf"])

    def test_html_requires_user(self):
        with self.assertRaises(last30days.ConfigError) as ctx:
            _cfg(["--topic", "x", "--format", "html"])
        self.assertEqual(ctx.exception.code, "bad_args")

    def test_both_requires_valid_user_email(self):
        with self.assertRaises(last30days.ConfigError):
            _cfg(["--topic", "x", "--format", "both", "--user", "not-an-email"])
        cfg = _cfg(["--topic", "x", "--format", "both", "--user", "a@psd401.net"])
        self.assertEqual(cfg["fmt"], "both")
        self.assertEqual(cfg["user"], "a@psd401.net")

    def test_days_and_limit_are_clamped(self):
        cfg = _cfg(["--topic", "x", "--days", "999", "--limit", "999"])
        self.assertEqual(cfg["days"], last30days.MAX_DAYS)
        self.assertEqual(cfg["limit"], last30days.MAX_LIMIT)
        cfg2 = _cfg(["--topic", "x", "--days", "0", "--limit", "-5"])
        self.assertEqual(cfg2["days"], 1)
        self.assertEqual(cfg2["limit"], 1)

    def test_source_subset_selection_dedupes_and_orders(self):
        cfg = _cfg(["--topic", "x", "--sources", "web,hackernews,web"])
        # Canonical order preserved (hackernews before web), duplicates removed.
        self.assertEqual(cfg["sources"], ["hackernews", "web"])

    def test_unknown_source_rejected(self):
        with self.assertRaises(last30days.ConfigError) as ctx:
            _cfg(["--topic", "x", "--sources", "twitter"])
        self.assertIn("unknown source", ctx.exception.message)

    def test_topic_length_capped(self):
        with self.assertRaises(last30days.ConfigError):
            _cfg(["--topic", "z" * (last30days.MAX_TOPIC_CHARS + 1)])


class FetchGuardTests(unittest.TestCase):
    def test_rejects_non_https(self):
        with self.assertRaises(ValueError):
            last30days._fetch("http://hn.algolia.com/api/v1/search")

    def test_rejects_non_allowlisted_host(self):
        with self.assertRaises(ValueError):
            last30days._fetch("https://evil.example.com/api")

    def test_allowlist_covers_every_adapter_host(self):
        for host in ("hn.algolia.com", "www.reddit.com", "export.arxiv.org",
                     "api.github.com", "news.google.com"):
            self.assertIn(host, last30days.ALLOWED_HOSTS)


_HN_PAYLOAD = json.dumps({
    "hits": [
        {"objectID": "1", "title": "Alpha ships thing", "url": "https://a.example/x",
         "points": 5, "num_comments": 2, "created_at": "2026-07-09T10:00:00.000Z"},
        {"objectID": "2", "title": "Beta bigger news", "url": "https://b.example/y",
         "points": 120, "num_comments": 44, "created_at": "2026-07-08T10:00:00.000Z"},
        {"objectID": "3", "story_title": "Gamma via story_title", "url": None,
         "points": 30, "num_comments": 1, "created_at": "2026-07-07T10:00:00.000Z"},
        {"objectID": "4", "title": "", "points": 9},  # skipped: no title
    ]
}).encode("utf-8")


class HackerNewsAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cutoff = dt.datetime(2026, 6, 15, tzinfo=dt.timezone.utc)

    def test_parses_ranks_and_backfills_urls(self):
        with mock.patch.object(last30days, "_fetch", return_value=_HN_PAYLOAD) as fetched:
            items = last30days.source_hackernews("thing", self.cutoff, limit=10)
        # The single HTTP call must target the allowlisted HN endpoint.
        self.assertTrue(fetched.call_args[0][0].startswith("https://hn.algolia.com/"))
        # Empty-title hit dropped; three remain.
        self.assertEqual(len(items), 3)
        # Sorted by points desc: Beta (120) first.
        self.assertEqual(items[0]["title"], "Beta bigger news")
        self.assertEqual(items[0]["score"], 120)
        self.assertIn("120 pts, 44 comments", items[0]["score_label"])
        # story_title fallback used, and a null url backfills to the HN item page.
        gamma = next(i for i in items if i["title"] == "Gamma via story_title")
        self.assertEqual(gamma["url"], "https://news.ycombinator.com/item?id=3")

    def test_limit_is_respected(self):
        with mock.patch.object(last30days, "_fetch", return_value=_HN_PAYLOAD):
            items = last30days.source_hackernews("thing", self.cutoff, limit=1)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Beta bigger news")

    def test_run_source_converts_adapter_failure_to_warning(self):
        with mock.patch.object(last30days, "_fetch", side_effect=ValueError("boom")):
            name, items, warning = last30days.run_source(
                "hackernews", "thing", self.cutoff, 10, 30)
        self.assertEqual(name, "hackernews")
        self.assertEqual(items, [])
        self.assertIn("Hacker News", warning)


def _item(source, title, url="https://ok.example/p", score=None, label="", published=None, snippet=""):
    return {"source": source, "title": title, "url": url, "score": score,
            "score_label": label, "published": published, "snippet": snippet}


class RenderTests(unittest.TestCase):
    def _results(self):
        return {
            "hackernews": [_item("hackernews", "HN top", score=100, label="100 pts, 5 comments",
                                 published=dt.datetime(2026, 7, 9, tzinfo=dt.timezone.utc))],
            "web": [_item("web", "Press headline", label="Some Paper")],
            "reddit": [], "arxiv": [], "github": [],
        }

    def test_markdown_is_cited_and_structured(self):
        md = last30days.render_markdown("gpt-5", 30, "2026-06-10", "2026-07-10 12:00Z",
                                        self._results(), warnings=[])
        self.assertIn("# Last-30-days brief: gpt-5", md)
        self.assertIn("## Hacker News", md)
        self.assertIn("https://ok.example/p", md)          # citation present
        self.assertIn("What's surfacing", md)
        self.assertIn("Returned nothing in this window", md)  # reddit/arxiv/github empty

    def test_html_escapes_hostile_source_content(self):
        evil = {
            "hackernews": [_item("hackernews", "<script>alert(1)</script>",
                                 url="javascript:alert(2)", score=1, label="<b>x</b>")],
            "reddit": [], "arxiv": [], "github": [], "web": [],
        }
        page = last30days.render_html("<img src=x onerror=alert(3)>", 30,
                                      "2026-06-10", "2026-07-10 12:00Z", evil, warnings=[])
        # Topic and title are escaped, not live markup.
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn("<img src=x onerror=alert(3)>", page)
        # A javascript: URL is never emitted as an href.
        self.assertNotIn("javascript:alert(2)", page)
        # Self-contained: no external resource references.
        self.assertNotIn("http://", page.replace("http://www.w3.org", ""))

    def test_safe_url_filters_non_http_schemes(self):
        self.assertEqual(last30days._safe_url("https://a.example/x"), "https://a.example/x")
        self.assertEqual(last30days._safe_url("javascript:alert(1)"), "")
        self.assertEqual(last30days._safe_url("data:text/html,x"), "")
        self.assertEqual(last30days._safe_url(""), "")

    def test_recurring_terms_excludes_topic_and_stopwords(self):
        results = {
            "hackernews": [_item("hackernews", "Model release benchmark benchmark"),
                           _item("hackernews", "Benchmark of the model")],
            "reddit": [], "arxiv": [], "github": [], "web": [],
        }
        terms = dict(last30days.recurring_terms(results, "model"))
        self.assertIn("benchmark", terms)   # appears 3x across titles
        self.assertNotIn("model", terms)    # topic word excluded
        self.assertNotIn("the", terms)      # stopword excluded


if __name__ == "__main__":
    unittest.main()
