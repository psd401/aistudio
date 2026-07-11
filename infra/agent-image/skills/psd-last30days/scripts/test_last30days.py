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

import contextlib
import datetime as dt
import io
import json
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import last30days  # noqa: E402


def _run_main(argv):
    """Run main(argv) with gather() stubbed (no network) and capture stdout JSON."""
    empty = {name: [] for name in last30days.ALL_SOURCES}
    buf = io.StringIO()
    with mock.patch.object(last30days, "gather", return_value=(empty, [])):
        with contextlib.redirect_stdout(buf):
            last30days.main(argv)
    return json.loads(buf.getvalue())


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
        # argparse-level failures exit via _fail, honoring the JSON contract.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            with self.assertRaises(SystemExit):
                last30days.build_parser().parse_args(["--topic", "x", "--format", "pdf"])
        out = json.loads(buf.getvalue())
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["error"], "bad_args")

    def test_non_integer_days_honors_json_error_contract(self):
        # `--days "last week"` fails inside argparse's type=int, which must
        # still emit the JSON error envelope, not a plain-text usage dump.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            with self.assertRaises(SystemExit):
                last30days.build_parser().parse_args(["--topic", "x", "--days", "last week"])
        out = json.loads(buf.getvalue())
        self.assertEqual(out["error"], "bad_args")
        self.assertIn("days", out["message"])

    def test_overlong_user_email_rejected(self):
        long_email = "a" * 250 + "@x.example"  # > 254 chars
        self.assertFalse(last30days.valid_email(long_email))
        with self.assertRaises(last30days.ConfigError):
            _cfg(["--topic", "x", "--format", "html", "--user", long_email])

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

    def test_check_url_reused_by_guard(self):
        # _check_url is the single gate used by both _fetch and the redirect handler.
        last30days._check_url("https://api.github.com/search/repositories")  # no raise
        with self.assertRaises(ValueError):
            last30days._check_url("https://internal.evil/x")

    def test_redirect_off_allowlist_is_refused(self):
        handler = last30days._GuardedRedirectHandler()
        with self.assertRaises(ValueError):
            handler.redirect_request(
                mock.Mock(), mock.Mock(), 302, "Found", {},
                "https://169.254.169.254/latest/meta-data/")

    def test_cross_host_redirect_strips_authorization(self):
        handler = last30days._GuardedRedirectHandler()
        req = last30days.urllib.request.Request(
            "https://api.github.com/search/repositories?q=x",
            headers={"Authorization": "Bearer secret", "User-Agent": "t"})
        new_req = handler.redirect_request(
            req, None, 302, "Found", {}, "https://news.google.com/rss/search?q=x")
        self.assertIsNotNone(new_req)
        self.assertFalse(new_req.has_header("Authorization"))

    def test_same_host_redirect_keeps_authorization(self):
        handler = last30days._GuardedRedirectHandler()
        req = last30days.urllib.request.Request(
            "https://api.github.com/search/repositories?q=x",
            headers={"Authorization": "Bearer secret"})
        new_req = handler.redirect_request(
            req, None, 302, "Found", {}, "https://api.github.com/search/repositories?q=x&page=2")
        self.assertIsNotNone(new_req)
        self.assertTrue(new_req.has_header("Authorization"))

    def test_oversized_response_is_rejected(self):
        big = b"x" * (last30days.MAX_RESPONSE_BYTES + 10)

        class _Resp:
            def read(self, n=-1):
                return big[:n] if n and n > 0 else big
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        class _Opener:
            def open(self, *a, **k):
                return _Resp()

        with mock.patch.object(last30days.urllib.request, "build_opener", return_value=_Opener()):
            with self.assertRaises(ValueError):
                last30days._fetch("https://hn.algolia.com/api/v1/search")


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
                                        self._results(), warnings=[],
                                        sources=list(last30days.ALL_SOURCES))
        self.assertIn("# Last-30-days brief: gpt-5", md)
        self.assertIn("## Hacker News", md)
        self.assertIn("https://ok.example/p", md)          # citation present
        self.assertIn("What's surfacing", md)
        self.assertIn("Returned nothing in this window", md)  # reddit/arxiv/github empty

    def test_renderers_never_mention_unqueried_sources(self):
        # --sources hackernews: results carries ONLY that key. The brief must not
        # claim Reddit/arXiv/GitHub/Web "returned nothing" — they were never queried.
        results = {"hackernews": [_item("hackernews", "HN top", score=3, label="3 pts")]}
        md = last30days.render_markdown("x", 30, "2026-06-10", "2026-07-10 12:00Z",
                                        results, warnings=[], sources=["hackernews"])
        self.assertNotIn("Returned nothing in this window", md)
        self.assertNotIn("Reddit (0)", md)  # header counts only the queried source
        self.assertIn("Hacker News (1)", md)
        page = last30days.render_html("x", 30, "2026-06-10", "2026-07-10 12:00Z",
                                      results, warnings=[], sources=["hackernews"])
        self.assertNotIn("Returned nothing in this window", page)
        self.assertNotIn("Reddit (0)", page)

    def test_html_escapes_hostile_source_content(self):
        evil = {
            "hackernews": [_item("hackernews", "<script>alert(1)</script>",
                                 url="javascript:alert(2)", score=1, label="<b>x</b>")],
            "reddit": [], "arxiv": [], "github": [], "web": [],
        }
        page = last30days.render_html("<img src=x onerror=alert(3)>", 30,
                                      "2026-06-10", "2026-07-10 12:00Z", evil, warnings=[],
                                      sources=list(last30days.ALL_SOURCES))
        # Topic and title are escaped, not live markup.
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn("<img src=x onerror=alert(3)>", page)
        # A javascript: URL is never emitted as an href.
        self.assertNotIn("javascript:alert(2)", page)
        # Self-contained: no external resource references.
        self.assertNotIn("http://", page.replace("http://www.w3.org", ""))

    def test_failed_source_not_listed_as_returned_nothing(self):
        # A source that FAILED (warning present) must not also be reported as
        # "returned nothing" — that would misread an outage as absence of chatter.
        results = {"hackernews": [_item("hackernews", "HN top", score=3, label="3 pts")],
                   "reddit": []}
        warnings = ["Reddit: HTTPError: HTTP Error 429: Too Many Requests"]
        md = last30days.render_markdown("x", 30, "2026-06-10", "2026-07-10 12:00Z",
                                        results, warnings=warnings,
                                        sources=["hackernews", "reddit"])
        self.assertIn("Source unavailable — Reddit", md)
        self.assertNotIn("Returned nothing in this window", md)
        page = last30days.render_html("x", 30, "2026-06-10", "2026-07-10 12:00Z",
                                      results, warnings=warnings,
                                      sources=["hackernews", "reddit"])
        self.assertNotIn("Returned nothing in this window", page)

    def test_genuinely_empty_source_still_listed(self):
        results = {"hackernews": [_item("hackernews", "HN top", score=3, label="3 pts")],
                   "reddit": []}
        md = last30days.render_markdown("x", 30, "2026-06-10", "2026-07-10 12:00Z",
                                        results, warnings=[],
                                        sources=["hackernews", "reddit"])
        self.assertIn("Returned nothing in this window: Reddit.", md)

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


class MainOutputTests(unittest.TestCase):
    def test_md_mode_emits_brief_and_no_url(self):
        out = _run_main(["--topic", "kubernetes"])
        self.assertEqual(out["status"], "ok")
        self.assertIn("brief_markdown", out)
        self.assertNotIn("url", out)
        self.assertEqual(out["total_items"], 0)

    def test_both_degrades_to_md_when_upload_fails(self):
        err = last30days.UploadError("misconfigured", "no bucket")
        with mock.patch.object(last30days, "upload_html", side_effect=err):
            out = _run_main(["--topic", "x", "--format", "both", "--user", "a@psd401.net"])
        # The already-computed Markdown is still delivered; the failure is a warning.
        self.assertEqual(out["status"], "ok")
        self.assertIn("brief_markdown", out)
        self.assertNotIn("url", out)
        self.assertTrue(any("HTML artifact upload failed" in w for w in out["warnings"]))

    def test_html_only_fails_hard_when_upload_fails(self):
        err = last30days.UploadError("misconfigured", "no bucket")
        empty = {name: [] for name in last30days.ALL_SOURCES}
        with mock.patch.object(last30days, "gather", return_value=(empty, [])):
            with mock.patch.object(last30days, "upload_html", side_effect=err):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        last30days.main(["--topic", "x", "--format", "html", "--user", "a@psd401.net"])

    def test_html_mode_emits_url_from_successful_upload(self):
        with mock.patch.object(last30days, "upload_html",
                               return_value=("https://b.s3.us-east-1.amazonaws.com/public-images/a@psd401.net/u.html",
                                             "public-images/a@psd401.net/u.html")):
            out = _run_main(["--topic", "x", "--format", "html", "--user", "a@psd401.net"])
        self.assertEqual(out["sharing"], "public-by-link")
        self.assertTrue(out["url"].endswith("u.html"))
        self.assertNotIn("brief_markdown", out)


_REDDIT_ATOM = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <!-- a feed comment: its non-string tag must not crash the parser -->
  <entry>
    <title>Cool post about thing</title>
    <link rel="self" href="https://www.reddit.com/api/self-link"/>
    <link rel="alternate" href="https://www.reddit.com/r/foo/comments/1/cool_post/"/>
    <updated>2026-07-09T10:00:00+00:00</updated>
    <category term="foo" label="r/foo"/>
  </entry>
  <entry>
    <title>Ancient post</title>
    <link href="https://www.reddit.com/r/foo/comments/2/old/"/>
    <updated>2020-01-01T00:00:00+00:00</updated>
  </entry>
</feed>
"""


class RedditAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cutoff = dt.datetime(2026, 6, 15, tzinfo=dt.timezone.utc)

    def test_picks_alternate_link_and_filters_old_entries(self):
        with mock.patch.object(last30days, "_fetch", return_value=_REDDIT_ATOM) as fetched:
            items = last30days.source_reddit("thing", self.cutoff, limit=10, days=90)
        # 90 days needs the year window (Reddit's t= steps are week/month/year).
        self.assertIn("t=year", fetched.call_args[0][0])
        # Ancient entry dropped by the cutoff filter; rel="self" link skipped.
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["url"], "https://www.reddit.com/r/foo/comments/1/cool_post/")
        self.assertEqual(items[0]["score_label"], "r/foo")

    def test_window_param_tracks_days(self):
        for days, expected in ((7, "t=week"), (30, "t=month"), (60, "t=year")):
            with mock.patch.object(last30days, "_fetch", return_value=_REDDIT_ATOM) as fetched:
                last30days.source_reddit("x", self.cutoff, limit=5, days=days)
            self.assertIn(expected, fetched.call_args[0][0])


class CleanTests(unittest.TestCase):
    def test_entity_encoded_tags_are_stripped_not_revealed(self):
        # Unescape-then-strip: '&lt;script&gt;' must not survive as a literal tag
        # in the (unescaped) Markdown brief.
        self.assertEqual(
            last30days._clean("Cool &lt;script&gt;alert(1)&lt;/script&gt; product"),
            "Cool alert(1) product")

    def test_literal_tags_still_stripped(self):
        self.assertEqual(last30days._clean("<b>Bold</b> move"), "Bold move")

    def test_local_normalizes_non_string_tags(self):
        # XML comments/PIs expose a callable tag; _local must not crash on them.
        self.assertEqual(last30days._local(last30days.ET.Comment), "")
        self.assertEqual(last30days._local("{ns}entry"), "entry")


class DedupeTests(unittest.TestCase):
    def test_folds_duplicates_by_normalized_title_and_url(self):
        results = {
            "hackernews": [_item("hackernews", "Big Model Released!", url="https://a.example/story")],
            "web": [
                _item("web", "big model released", url="https://news.example/other"),  # dup title
                _item("web", "Fresh headline", url="https://a.example/story/"),        # dup url
                _item("web", "Unique story", url="https://unique.example/x"),
            ],
        }
        deduped = last30days.dedupe(results, ["hackernews", "web"])
        self.assertEqual(len(deduped["hackernews"]), 1)  # first occurrence kept
        self.assertEqual([i["title"] for i in deduped["web"]], ["Unique story"])


class GatherTests(unittest.TestCase):
    def test_deadline_converts_stalled_source_to_warning(self):
        cutoff = dt.datetime(2026, 6, 15, tzinfo=dt.timezone.utc)

        def slow_run_source(name, query, cutoff, limit, days):
            if name == "reddit":
                time.sleep(5)
            return name, [], None

        with mock.patch.object(last30days, "run_source", side_effect=slow_run_source):
            results, warnings = last30days.gather(
                ["hackernews", "reddit"], "x", cutoff, 5, 30, deadline=0.2)
        # The fast source's result survives; the stalled one becomes a warning.
        self.assertEqual(results["hackernews"], [])
        self.assertEqual(results["reddit"], [])
        self.assertTrue(any("no response within" in w for w in warnings))


class UploadTests(unittest.TestCase):
    def test_missing_bucket_raises_misconfigured(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(last30days.UploadError) as ctx:
                last30days.upload_html("<html></html>", "a@psd401.net")
        self.assertEqual(ctx.exception.code, "misconfigured")


if __name__ == "__main__":
    unittest.main()
