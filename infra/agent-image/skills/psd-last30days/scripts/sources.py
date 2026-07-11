"""Keyless source adapters for psd-last30days.

Each adapter takes (topic, days, limit) and returns a list of item dicts:
{"title", "url", "source", "published" (ISO 8601 UTC or ""), "snippet"}.
Adapters raise SourceError on a hard failure (network/malformed response);
the caller degrades gracefully per-source instead of aborting the whole run.

No API keys: every endpoint here is a public, unauthenticated HTTP surface
(RSS/Atom feeds or a keyless JSON API), fixed to a hardcoded host — only the
query string is user-controlled, so there is no SSRF surface to guard.
"""

import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

USER_AGENT = "psd-last30days/1.0 (+https://psd401.net; research skill for Peninsula School District)"
REQUEST_TIMEOUT = 10
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}


class SourceError(Exception):
    pass


def _get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read()
    except (urllib.error.URLError, socket.timeout) as exc:
        raise SourceError(str(exc)) from exc


def _cutoff(days):
    return datetime.now(timezone.utc) - timedelta(days=days)


def _clip(text, n=280):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def fetch_reddit(topic, days, limit):
    q = urllib.parse.quote(topic)
    url = f"https://www.reddit.com/search.rss?q={q}&sort=new&t=month&limit={min(limit, 25)}"
    body = _get(url)
    root = ET.fromstring(body)
    cutoff = _cutoff(days)
    items = []
    for entry in root.findall("a:entry", ATOM_NS):
        title_el = entry.find("a:title", ATOM_NS)
        link_el = entry.find("a:link", ATOM_NS)
        updated_el = entry.find("a:updated", ATOM_NS)
        content_el = entry.find("a:content", ATOM_NS)
        if title_el is None or link_el is None or updated_el is None:
            continue
        try:
            published = datetime.fromisoformat(updated_el.text.replace("Z", "+00:00"))
        except ValueError:
            continue
        if published < cutoff:
            continue
        raw_content = content_el.text if content_el is not None else ""
        items.append(
            {
                "title": title_el.text or "(untitled)",
                "url": link_el.get("href", ""),
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
    q = urllib.parse.quote(topic)
    url = (
        "https://hn.algolia.com/api/v1/search_by_date"
        f"?query={q}&tags=story&numericFilters=created_at_i%3E{cutoff_epoch}&hitsPerPage={min(limit, 50)}"
    )
    body = _get(url)
    data = json.loads(body)
    items = []
    for hit in data.get("hits", []):
        title = hit.get("title") or hit.get("story_title")
        if not title:
            continue
        url_ = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
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
    q = urllib.parse.quote(f"all:{topic}")
    url = (
        f"http://export.arxiv.org/api/query?search_query={q}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={min(limit, 25)}"
    )
    body = _get(url)
    root = ET.fromstring(body)
    cutoff = _cutoff(days)
    items = []
    for entry in root.findall("a:entry", ATOM_NS):
        title_el = entry.find("a:title", ATOM_NS)
        id_el = entry.find("a:id", ATOM_NS)
        published_el = entry.find("a:published", ATOM_NS)
        summary_el = entry.find("a:summary", ATOM_NS)
        if title_el is None or id_el is None or published_el is None:
            continue
        try:
            published = datetime.fromisoformat(published_el.text.replace("Z", "+00:00"))
        except ValueError:
            continue
        if published < cutoff:
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
    since = _cutoff(days).strftime("%Y-%m-%d")
    q = urllib.parse.quote(f"{topic} pushed:>{since}")
    url = f"https://api.github.com/search/repositories?q={q}&sort=updated&order=desc&per_page={min(limit, 30)}"
    body = _get(url, headers={"Accept": "application/vnd.github+json"})
    data = json.loads(body)
    if "items" not in data:
        raise SourceError(data.get("message", "unexpected GitHub API response"))
    items = []
    for repo in data["items"][:limit]:
        items.append(
            {
                "title": repo.get("full_name", "(unknown)"),
                "url": repo.get("html_url", ""),
                "source": "github",
                "published": repo.get("pushed_at", ""),
                "snippet": _clip(repo.get("description") or ""),
            }
        )
    return items


def fetch_web(topic, days, limit):
    """Public web chatter via Google News' documented keyless RSS search endpoint."""
    q = urllib.parse.quote(f"{topic} when:{days}d")
    url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    body = _get(url)
    root = ET.fromstring(body)
    cutoff = _cutoff(days)
    items = []
    for item in root.findall("./channel/item"):
        title_el = item.find("title")
        link_el = item.find("link")
        pubdate_el = item.find("pubDate")
        if title_el is None or link_el is None:
            continue
        published_iso = ""
        if pubdate_el is not None and pubdate_el.text:
            try:
                dt = parsedate_to_datetime(pubdate_el.text)
            except (TypeError, ValueError):
                dt = None
            if dt is not None:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt < cutoff:
                    continue
                published_iso = dt.isoformat()
        items.append(
            {
                "title": title_el.text or "(untitled)",
                "url": link_el.text or "",
                "source": "web",
                "published": published_iso,
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
