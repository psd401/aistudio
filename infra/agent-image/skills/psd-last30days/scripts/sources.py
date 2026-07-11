"""Keyless source adapters for psd-last30days.

Each adapter takes (topic, days, limit) and returns a list of item dicts:
{"title", "url", "source", "published" (ISO 8601 UTC or ""), "snippet"}.
Adapters raise SourceError on a hard failure (network error, or a response
that fails to parse as the expected JSON/XML shape); the caller degrades
gracefully per-source instead of aborting the whole run.

No API keys: every endpoint here is a public, unauthenticated HTTPS surface
(RSS/Atom feeds or a keyless JSON API), fixed to a hardcoded host — only the
query string is user-controlled, so there is no SSRF surface via --topic.
Redirects are restricted to the same host as the original request (defense
in depth against a future open-redirect on one of these hosts pivoting the
fetch to an internal address).

Entity-expansion ("billion laughs") hardening: this deliberately does not
pull in `defusedxml` — it's a new pip dependency that would need hash-pinning
against a live PyPI index (not available in every build environment), and
CPython's bundled expat (3.9+) already caps total entity-expansion output as
a ratio of input size by default. The MAX_RESPONSE_BYTES cap below bounds the
worst case further by capping the input itself.
"""

import json
import re
import socket
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlparse

USER_AGENT = "psd-last30days/1.0 (+https://psd401.net; research skill for Peninsula School District)"
REQUEST_TIMEOUT = 10
MAX_RESPONSE_BYTES = 5 * 1024 * 1024  # 5 MB — bounds memory use and worst-case entity-expansion input
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}


class SourceError(Exception):
    pass


class _SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse a redirect that leaves the originally-requested host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).hostname != urlparse(req.full_url).hostname:
            raise SourceError(f"refused cross-host redirect to {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SameHostRedirectHandler)


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with _OPENER.open(req, timeout=REQUEST_TIMEOUT) as resp:
            body = resp.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, socket.timeout) as exc:
        raise SourceError(str(exc)) from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise SourceError(f"response exceeded {MAX_RESPONSE_BYTES} byte cap")
    return body


def _parse_json(body):
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise SourceError(f"malformed JSON response: {exc}") from exc


def _parse_xml(body):
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        raise SourceError(f"malformed XML response: {exc}") from exc


def _cutoff(days):
    return datetime.now(timezone.utc) - timedelta(days=days)


def _clip(text, n=280):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _parse_iso(text):
    """Parse an ISO-8601 timestamp to an aware UTC datetime, or None."""
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _atom_link(entry):
    """Prefer rel="alternate" (or unmarked, the default per RFC 4287); fall back to the first link."""
    links = entry.findall("a:link", ATOM_NS)
    for link in links:
        if link.get("rel") in (None, "alternate"):
            return link.get("href", "")
    return links[0].get("href", "") if links else ""


def _reddit_time_filter(days):
    """Map a --days window to Reddit's coarse `t` buckets (day/week/month/year/all).

    Reddit has no arbitrary day-range filter, so the bucket must be at least as
    wide as `days` — the caller's own `_cutoff` re-filters precisely afterward.
    """
    if days <= 1:
        return "day"
    if days <= 7:
        return "week"
    if days <= 30:
        return "month"
    return "year"


def fetch_reddit(topic, days, limit):
    q = quote(topic)
    t = _reddit_time_filter(days)
    url = f"https://www.reddit.com/search.rss?q={q}&sort=new&t={t}&limit={min(limit, 25)}"
    root = _parse_xml(_get(url))
    cutoff = _cutoff(days)
    items = []
    for entry in root.findall("a:entry", ATOM_NS):
        title_el = entry.find("a:title", ATOM_NS)
        updated_el = entry.find("a:updated", ATOM_NS)
        content_el = entry.find("a:content", ATOM_NS)
        href = _atom_link(entry)
        if title_el is None or not href or updated_el is None:
            continue
        published = _parse_iso(updated_el.text)
        if published is None or published < cutoff:
            continue
        raw_content = content_el.text if content_el is not None else ""
        items.append(
            {
                "title": title_el.text or "(untitled)",
                "url": href,
                "source": "reddit",
                "published": published.isoformat(),
                "snippet": _clip(re.sub(r"<[^>]+>", " ", raw_content or "")),
            }
        )
        if len(items) >= limit:
            break
    return items


def fetch_hackernews(topic, days, limit):
    cutoff_epoch = int(_cutoff(days).timestamp())
    q = quote(topic)
    url = (
        "https://hn.algolia.com/api/v1/search_by_date"
        f"?query={q}&tags=story&numericFilters=created_at_i%3E{cutoff_epoch}&hitsPerPage={min(limit, 50)}"
    )
    data = _parse_json(_get(url))
    items = []
    for hit in data.get("hits", []):
        title = hit.get("title") or hit.get("story_title")
        object_id = hit.get("objectID")
        if not title or not object_id:
            continue
        url_ = hit.get("url") or f"https://news.ycombinator.com/item?id={object_id}"
        items.append(
            {
                "title": title,
                "url": url_,
                "source": "hackernews",
                "published": hit.get("created_at", ""),
                "snippet": _clip(f"{hit.get('points', 0)} points, {hit.get('num_comments', 0)} comments"),
            }
        )
        if len(items) >= limit:
            break
    return items


def fetch_arxiv(topic, days, limit):
    q = quote(f"all:{topic}")
    url = (
        f"https://export.arxiv.org/api/query?search_query={q}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={min(limit, 25)}"
    )
    root = _parse_xml(_get(url))
    cutoff = _cutoff(days)
    items = []
    for entry in root.findall("a:entry", ATOM_NS):
        title_el = entry.find("a:title", ATOM_NS)
        id_el = entry.find("a:id", ATOM_NS)
        published_el = entry.find("a:published", ATOM_NS)
        summary_el = entry.find("a:summary", ATOM_NS)
        if title_el is None or id_el is None or not id_el.text or published_el is None:
            continue
        published = _parse_iso(published_el.text)
        if published is None or published < cutoff:
            continue
        items.append(
            {
                "title": _clip(title_el.text, 200),
                "url": id_el.text,
                "source": "arxiv",
                "published": published.isoformat(),
                "snippet": _clip(summary_el.text if summary_el is not None else ""),
            }
        )
        if len(items) >= limit:
            break
    return items


def fetch_github(topic, days, limit):
    """Direct unauthenticated GitHub REST search — NOT the `gh` CLI.

    `gh` requires a per-user `github_pat` credential (see psd-github/SKILL.md);
    that isn't provisioned for most callers, so it isn't actually keyless.
    The public search API works unauthenticated (10 req/min), which is ample
    for one research run.
    """
    cutoff = _cutoff(days)
    since = cutoff.strftime("%Y-%m-%d")
    q = quote(f"{topic} pushed:>{since}")
    url = f"https://api.github.com/search/repositories?q={q}&sort=updated&order=desc&per_page={min(limit, 30)}"
    data = _parse_json(_get(url))
    if "items" not in data:
        raise SourceError(data.get("message", "unexpected GitHub API response"))
    items = []
    for repo in data["items"]:
        # `pushed:>` is day-granularity; re-check precisely so results stay inside the requested window.
        published = _parse_iso(repo.get("pushed_at"))
        if published is not None and published < cutoff:
            continue
        items.append(
            {
                "title": repo.get("full_name", "(unknown)"),
                "url": repo.get("html_url", ""),
                "source": "github",
                "published": repo.get("pushed_at", ""),
                "snippet": _clip(repo.get("description") or ""),
            }
        )
        if len(items) >= limit:
            break
    return items


def fetch_web(topic, days, limit):
    """Public web chatter via Google News' documented keyless RSS search endpoint."""
    q = quote(f"{topic} when:{days}d")
    url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    root = _parse_xml(_get(url))
    cutoff = _cutoff(days)
    items = []
    for item in root.findall("./channel/item"):
        title_el = item.find("title")
        link_el = item.find("link")
        pubdate_el = item.find("pubDate")
        if title_el is None or link_el is None or link_el.text is None:
            continue
        published = None
        if pubdate_el is not None and pubdate_el.text:
            try:
                published = parsedate_to_datetime(pubdate_el.text)
            except (TypeError, ValueError):
                published = None
            if published is not None and published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
        # No parseable date is treated as out-of-window, consistent with the other adapters
        # (Google's own `when:{days}d` filter is best-effort, not a guarantee).
        if published is None or published < cutoff:
            continue
        items.append(
            {
                "title": title_el.text or "(untitled)",
                "url": link_el.text,
                "source": "web",
                "published": published.isoformat(),
                "snippet": "",
            }
        )
        if len(items) >= limit:
            break
    return items


SOURCES = {
    "reddit": fetch_reddit,
    "hackernews": fetch_hackernews,
    "arxiv": fetch_arxiv,
    "github": fetch_github,
    "web": fetch_web,
}
