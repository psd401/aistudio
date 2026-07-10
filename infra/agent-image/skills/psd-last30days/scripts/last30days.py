#!/usr/bin/env python3
"""
last30days.py — psd-last30days engine

Research "what people actually said about <topic> in the last ~30 days" across
free/keyless social and community sources, then return a grounded, source-cited
brief. This is a lean PSD port of the open-source last30days skill
(github.com/mvanhorn/last30days-skill, MIT) fitted to the AgentCore runtime.

Design (why this differs from upstream):
- Upstream assumes a developer laptop: a first-run wizard, ~/.config credential
  store, paid API keys, and a host WebSearch tool. This runtime has none of
  those, so the engine fetches its OWN sources over stdlib urllib and scopes v1
  to KEYLESS sources only: Hacker News, Reddit, arXiv, GitHub, and Google News.
- Pure Python stdlib (urllib + xml.etree + json) — NO new pip dependency, so the
  image footprint stays lean and the AgentCore Firecracker microVM boot is not
  put at risk (the matplotlib/pymupdf1.x precedent). boto3 (already baked into
  the venv) is used only for the optional S3 HTML upload.
- No env/.env/~/.config secret reads. GitHub optionally borrows the caller's
  `gh auth token` for a higher rate limit, but every source works without any
  key. If a paid source is ever provisioned, its key must come from
  `psd-credentials get --shared --name <key>` — never the environment.

The engine is deliberately synthesis-light: it fetches, filters to the window,
ranks by each source's native engagement signal (or recency), de-duplicates, and
emits a structured, cited Markdown brief. The reasoning model (the agent that
invokes this skill) does the final narrative synthesis on top of that grounded
draft — matching upstream's "engine fans out, model synthesizes" split.

Output modes (both are first-class; user chooses per invocation via --format):
  md   (default) — JSON with `brief_markdown`, a cited brief the agent relays.
  html           — render the brief to a self-contained HTML page, upload it to
                   S3 public-by-link under public-images/<email>/, return the URL.
  both           — brief_markdown AND the S3 URL.

Usage:
    python3 last30days.py --topic "district AI policy"
    python3 last30days.py --topic "llama 4" --days 14 --limit 8
    python3 last30days.py --topic "chromebooks" --sources hackernews,web
    python3 last30days.py --user name@psd401.net --topic "gpt-5" --format both
"""

import argparse
import concurrent.futures
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

USER_AGENT = "psd-last30days/1.0 (+https://psd401.ai; Peninsula School District research skill)"

# Every outbound fetch must target one of these hosts. Because the source
# endpoints are hardcoded and the user-supplied topic only ever lands in query
# strings (never the host), an exact-host allowlist fully closes SSRF here —
# stronger and simpler than IP-range resolution for a fixed set of endpoints.
ALLOWED_HOSTS = frozenset({
    "hn.algolia.com",
    "www.reddit.com",
    "export.arxiv.org",
    "api.github.com",
    "news.google.com",
})

ALL_SOURCES = ("hackernews", "reddit", "arxiv", "github", "web")

DEFAULT_DAYS = 30
MAX_DAYS = 90
DEFAULT_LIMIT = 10
MAX_LIMIT = 25
FETCH_TIMEOUT = 15  # seconds per HTTP request
# Cap each response body so a hostile/misbehaving endpoint can't exhaust memory.
# The feeds we fetch are JSON/XML in the tens-to-hundreds of KB; 8 MB is generous.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_TOPIC_CHARS = 300

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

# Stopwords for the mechanical "recurring terms" line — kept tiny on purpose.
_STOPWORDS = frozenset("""
a an the and or but of to in on for with from by at as is are was were be been
being this that these those it its it's you your we our they them their he she
how what why when where who which new news show ask hn via using use used get
""".split())


class ConfigError(Exception):
    """Raised for invalid CLI configuration; carries a machine-readable code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _fail(message, code="error"):
    print(json.dumps({"status": "error", "error": code, "message": message}))
    sys.exit(1)


def _emit(obj):
    print(json.dumps(obj, indent=2))


def valid_email(email):
    # Reject '/' because the email is interpolated into the S3 key path.
    return bool(email) and bool(_EMAIL_RE.match(email)) and "/" not in email


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def _check_url(url):
    """Enforce https + the exact-host allowlist. Raises ValueError otherwise."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"refusing non-https url: {url}")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"refusing fetch to non-allowlisted host: {parsed.hostname}")


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop against the https+host allowlist. Without
    this, urllib follows 3xx by default and a redirect from an allowlisted host
    to an internal/other host would slip past the one-time check in _fetch —
    an SSRF escape. None of our source endpoints legitimately redirect, so a
    redirect off the allowlist is refused outright."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url, headers=None):
    """Fetch bytes from an allowlisted https host, size-capped. Raises ValueError
    for a disallowed scheme/host (including on any redirect hop), urllib.error.*
    for transport failures."""
    _check_url(url)
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)
    opener = urllib.request.build_opener(_GuardedRedirectHandler)
    with opener.open(req, timeout=FETCH_TIMEOUT) as resp:  # noqa: S310 (https + host allowlisted; redirects re-checked)
        body = resp.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError(f"response body exceeds {MAX_RESPONSE_BYTES} bytes")
    return body


# --------------------------------------------------------------------------- #
# Date helpers
# --------------------------------------------------------------------------- #

def _now_utc():
    return dt.datetime.now(dt.timezone.utc)


def parse_iso(value):
    """Parse an ISO-8601 timestamp (arXiv/GitHub) to an aware UTC datetime, or None."""
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def parse_rfc822(value):
    """Parse an RFC-822 date (RSS pubDate) to an aware UTC datetime, or None."""
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def fmt_date(when):
    return when.strftime("%Y-%m-%d") if when else "undated"


# --------------------------------------------------------------------------- #
# XML helpers (namespace-agnostic — Reddit/arXiv Atom + Google News RSS)
# --------------------------------------------------------------------------- #

def _local(tag):
    """Strip an XML namespace: '{http://www.w3.org/2005/Atom}entry' -> 'entry'."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_all(node, name):
    return [child for child in node if _local(child.tag) == name]


def _find_first(node, name):
    for child in node:
        if _local(child.tag) == name:
            return child
    return None


def _text(node, name):
    child = _find_first(node, name)
    return (child.text or "").strip() if child is not None else ""


# --------------------------------------------------------------------------- #
# Source adapters. Each returns a list[Item]. An Item is a dict:
#   { source, title, url, published (datetime|None), score (int|None),
#     score_label (str), snippet (str) }
# Adapters raise on failure; run_source() converts that into a warning so one
# dead source never sinks the whole brief.
# --------------------------------------------------------------------------- #

def _clean(text):
    """Collapse whitespace and strip tags from a fetched title/snippet."""
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def source_hackernews(query, cutoff, limit):
    since_ts = int(cutoff.timestamp())
    q = urllib.parse.quote(query)
    url = (
        f"https://hn.algolia.com/api/v1/search_by_date?query={q}&tags=story"
        f"&numericFilters=created_at_i>{since_ts}&hitsPerPage={min(limit * 3, 100)}"
    )
    data = json.loads(_fetch(url))
    items = []
    for hit in data.get("hits", []):
        title = _clean(hit.get("title") or hit.get("story_title") or "")
        if not title:
            continue
        object_id = hit.get("objectID") or ""
        discussion = f"https://news.ycombinator.com/item?id={object_id}"
        points = int(hit.get("points") or 0)
        comments = int(hit.get("num_comments") or 0)
        items.append({
            "source": "hackernews",
            "title": title,
            "url": hit.get("url") or discussion,
            "published": parse_iso(hit.get("created_at")),
            "score": points,
            "score_label": f"{points} pts, {comments} comments",
            "snippet": f"HN discussion: {discussion}",
        })
    items.sort(key=lambda i: i["score"], reverse=True)
    return items[:limit]


def source_reddit(query, cutoff, limit):
    q = urllib.parse.quote(query)
    url = f"https://www.reddit.com/search.rss?q={q}&sort=new&t=month&limit={min(limit * 2, 50)}"
    root = ET.fromstring(_fetch(url))
    # Reddit search feeds are Atom (<feed><entry>).
    entries = _find_all(root, "entry")
    items = []
    for entry in entries:
        title = _clean(_text(entry, "title"))
        if not title:
            continue
        link_el = _find_first(entry, "link")
        link = link_el.get("href") if link_el is not None else ""
        published = parse_iso(_text(entry, "updated") or _text(entry, "published"))
        if published and published < cutoff:
            continue
        subreddit = ""
        for cat in _find_all(entry, "category"):
            subreddit = cat.get("label") or cat.get("term") or ""
            if subreddit:
                break
        items.append({
            "source": "reddit",
            "title": title,
            "url": link,
            "published": published,
            "score": None,
            "score_label": subreddit or "reddit",
            "snippet": "",
        })
    items.sort(key=lambda i: i["published"] or cutoff, reverse=True)
    return items[:limit]


def source_arxiv(query, cutoff, limit):
    q = urllib.parse.quote(f"all:{query}")
    url = (
        f"https://export.arxiv.org/api/query?search_query={q}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={min(limit * 2, 50)}"
    )
    root = ET.fromstring(_fetch(url))
    items = []
    for entry in _find_all(root, "entry"):
        title = _clean(_text(entry, "title"))
        if not title:
            continue
        published = parse_iso(_text(entry, "published"))
        if published and published < cutoff:
            continue
        link = ""
        for link_el in _find_all(entry, "link"):
            if link_el.get("rel") in (None, "alternate"):
                link = link_el.get("href") or ""
                break
        if not link:
            link = _text(entry, "id")
        authors = [_clean(_text(a, "name")) for a in _find_all(entry, "author")]
        authors = [a for a in authors if a]
        byline = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
        summary = _clean(_text(entry, "summary"))
        items.append({
            "source": "arxiv",
            "title": title,
            "url": link,
            "published": published,
            "score": None,
            "score_label": byline or "arXiv",
            "snippet": summary[:280],
        })
    return items[:limit]


def _github_token():
    """Best-effort: borrow the caller's gh auth token for a higher REST rate
    limit. Never required — GitHub search works keyless. Any failure is ignored."""
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    token = (result.stdout or "").strip()
    return token if result.returncode == 0 and token else None


def source_github(query, cutoff, limit):
    since = cutoff.strftime("%Y-%m-%d")
    q = urllib.parse.quote(f"{query} pushed:>={since}")
    url = (
        f"https://api.github.com/search/repositories?q={q}"
        f"&sort=updated&order=desc&per_page={min(limit, MAX_LIMIT)}"
    )
    headers = {"Accept": "application/vnd.github+json"}
    token = _github_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.loads(_fetch(url, headers=headers))
    items = []
    for repo in data.get("items", []):
        name = _clean(repo.get("full_name") or "")
        if not name:
            continue
        stars = int(repo.get("stargazers_count") or 0)
        items.append({
            "source": "github",
            "title": name,
            "url": repo.get("html_url") or f"https://github.com/{name}",
            "published": parse_iso(repo.get("pushed_at")),
            "score": stars,
            "score_label": f"★{stars}",
            "snippet": _clean(repo.get("description") or "")[:280],
        })
    items.sort(key=lambda i: i["score"], reverse=True)
    return items[:limit]


def source_web(query, cutoff, limit, days):
    q = urllib.parse.quote(f"{query} when:{days}d")
    url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    root = ET.fromstring(_fetch(url))
    channel = _find_first(root, "channel")
    if channel is None:
        channel = root
    items = []
    for item in _find_all(channel, "item"):
        title = _clean(_text(item, "title"))
        if not title:
            continue
        published = parse_rfc822(_text(item, "pubDate"))
        if published and published < cutoff:
            continue
        source_name = _clean(_text(item, "source")) or "news"
        items.append({
            "source": "web",
            "title": title,
            "url": _text(item, "link"),
            "published": published,
            "score": None,
            "score_label": source_name,
            "snippet": "",
        })
    items.sort(key=lambda i: i["published"] or cutoff, reverse=True)
    return items[:limit]


_ADAPTERS = {
    "hackernews": lambda q, c, l, d: source_hackernews(q, c, l),
    "reddit": lambda q, c, l, d: source_reddit(q, c, l),
    "arxiv": lambda q, c, l, d: source_arxiv(q, c, l),
    "github": lambda q, c, l, d: source_github(q, c, l),
    "web": lambda q, c, l, d: source_web(q, c, l, d),
}

_SOURCE_LABELS = {
    "hackernews": "Hacker News",
    "reddit": "Reddit",
    "arxiv": "arXiv",
    "github": "GitHub",
    "web": "Web (Google News)",
}


def run_source(name, query, cutoff, limit, days):
    """Run one adapter, returning (name, items, warning|None)."""
    try:
        items = _ADAPTERS[name](query, cutoff, limit, days)
        return name, items, None
    except Exception as exc:  # noqa: BLE001 — any single-source failure degrades, never crashes
        return name, [], f"{_SOURCE_LABELS.get(name, name)}: {type(exc).__name__}: {exc}"


def gather(sources, query, cutoff, limit, days):
    """Fan out across the requested sources concurrently. Concurrency is safe:
    _fetch does not mutate global state (unlike a getaddrinfo monkeypatch), so
    threads don't interfere."""
    results, warnings = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(sources)) as pool:
        futures = {
            pool.submit(run_source, name, query, cutoff, limit, days): name
            for name in sources
        }
        for future in concurrent.futures.as_completed(futures):
            name, items, warning = future.result()
            results[name] = items
            if warning:
                warnings.append(warning)
    return results, warnings


# --------------------------------------------------------------------------- #
# Synthesis scaffolding (mechanical — the agent adds narrative on top)
# --------------------------------------------------------------------------- #

def recurring_terms(results, query, top=6):
    """Count significant terms across all titles, minus stopwords and the
    topic's own words, to hint at what themes are recurring."""
    topic_words = {w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 1}
    counts = {}
    for items in results.values():
        for item in items:
            for word in re.findall(r"[a-z0-9]{3,}", item["title"].lower()):
                if word in _STOPWORDS or word in topic_words:
                    continue
                counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [(w, n) for w, n in ranked[:top] if n >= 2]


def top_signals(results, per_source=1):
    """One cross-source snapshot: the top item from each non-empty source (by
    that source's native ranking, which the adapters already applied)."""
    picks = []
    for name in ALL_SOURCES:
        for item in (results.get(name) or [])[:per_source]:
            picks.append(item)
    return picks


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

def _safe_url(url):
    """Only http(s) links are rendered as links; anything else (javascript:,
    data:, mailto:) is dropped so a hostile source URL can't inject a scheme."""
    if not url:
        return ""
    scheme = urllib.parse.urlparse(url).scheme.lower()
    return url if scheme in ("http", "https") else ""


def _item_line_md(idx, item):
    label = f" — {item['score_label']}" if item["score_label"] else ""
    date = f" · {fmt_date(item['published'])}" if item["published"] else ""
    line = f"{idx}. **{item['title']}**{label}{date}"
    url = _safe_url(item["url"])
    if url:
        line += f"\n   {url}"
    if item["snippet"]:
        line += f"\n   {item['snippet']}"
    return line


def render_markdown(query, days, since, generated, results, warnings):
    counts = {name: len(results.get(name) or []) for name in ALL_SOURCES}
    summary = " · ".join(
        f"{_SOURCE_LABELS[name]} ({counts[name]})" for name in ALL_SOURCES
    )
    lines = [
        f"# Last-{days}-days brief: {query}",
        "",
        f"_Window: since {since} · generated {generated} · {summary}_",
        "",
        "## What's surfacing",
    ]

    signals = top_signals(results)
    if signals:
        for item in signals:
            label = f" ({item['score_label']})" if item["score_label"] else ""
            url = _safe_url(item["url"])
            cite = f" — {url}" if url else ""
            lines.append(f"- **[{_SOURCE_LABELS[item['source']]}]** {item['title']}{label}{cite}")
    else:
        lines.append("- No items surfaced from the queried sources in this window.")

    terms = recurring_terms(results, query)
    if terms:
        lines.append("")
        lines.append("Recurring terms: " + ", ".join(f"{w} ({n})" for w, n in terms))

    for name in ALL_SOURCES:
        items = results.get(name) or []
        if not items:
            continue
        lines.append("")
        lines.append(f"## {_SOURCE_LABELS[name]}")
        for idx, item in enumerate(items, 1):
            lines.append(_item_line_md(idx, item))

    lines.append("")
    lines.append("## Notes")
    lines.append(
        "- Engagement signals: Hacker News = points/comments, GitHub = stars. "
        "Reddit, arXiv, and Web are ranked by recency (no keyless engagement metric)."
    )
    empty = [_SOURCE_LABELS[n] for n in ALL_SOURCES if not (results.get(n) or [])]
    if empty:
        lines.append(f"- Returned nothing in this window: {', '.join(empty)}.")
    if warnings:
        for warning in warnings:
            lines.append(f"- Source unavailable — {warning}")
    lines.append(
        "- Keyless sources only. Paid sources (X, TikTok/Instagram, Perplexity, "
        "Brave) are out of scope until a district key is provisioned via psd-credentials."
    )
    return "\n".join(lines)


def render_html(query, days, since, generated, results, warnings):
    """Render the same brief as a self-contained, styled HTML page. ALL external
    text (titles, snippets, source names, the topic) is HTML-escaped: the page is
    served from our S3 domain public-by-link, so an unescaped hostile title would
    be a stored-XSS vector."""
    e = html.escape

    def link(item):
        url = _safe_url(item["url"])
        title = e(item["title"])
        return f'<a href="{e(url)}" target="_blank" rel="noopener noreferrer">{title}</a>' if url else title

    counts = {name: len(results.get(name) or []) for name in ALL_SOURCES}
    summary = " · ".join(f"{_SOURCE_LABELS[name]} ({counts[name]})" for name in ALL_SOURCES)

    parts = [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>Last-{days}-days brief: {e(query)}</title>",
        "<style>",
        ":root{color-scheme:light dark}",
        "*{box-sizing:border-box}",
        "body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        "color:#1a1f2b;background:#f6f7f9}",
        ".wrap{max-width:820px;margin:0 auto;padding:32px 20px 64px}",
        "header{border-bottom:3px solid #003b5c;padding-bottom:16px;margin-bottom:24px}",
        "h1{font-size:1.7rem;margin:0 0 6px;color:#003b5c}",
        ".meta{color:#5a6472;font-size:.85rem}",
        "h2{font-size:1.15rem;margin:32px 0 10px;color:#003b5c;border-bottom:1px solid #dfe3e8;padding-bottom:4px}",
        ".signals li{margin:6px 0}",
        ".src{display:inline-block;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;"
        "color:#fff;background:#0072ce;border-radius:4px;padding:1px 6px;margin-right:6px;vertical-align:1px}",
        "ol{padding-left:22px}",
        "li{margin:10px 0}",
        ".label{color:#5a6472;font-size:.85rem}",
        ".snippet{color:#3a4250;font-size:.9rem;display:block;margin-top:2px}",
        "a{color:#0072ce;text-decoration:none;word-break:break-word}",
        "a:hover{text-decoration:underline}",
        ".notes{margin-top:32px;font-size:.85rem;color:#5a6472;background:#eef1f4;border-radius:8px;padding:14px 18px}",
        "@media(prefers-color-scheme:dark){body{background:#12151b;color:#e6e9ee}"
        "header,h1,h2{color:#5cc5ff;border-color:#26313f}.notes{background:#1b2029;color:#aeb6c2}"
        ".label,.meta,.snippet{color:#aeb6c2}}",
        "</style></head><body><div class='wrap'>",
        "<header>",
        f"<h1>Last-{days}-days brief: {e(query)}</h1>",
        f'<div class="meta">Window: since {e(since)} · generated {e(generated)}<br>{e(summary)}</div>',
        "</header>",
        "<h2>What's surfacing</h2>",
    ]

    signals = top_signals(results)
    if signals:
        parts.append('<ul class="signals">')
        for item in signals:
            label = f' <span class="label">({e(item["score_label"])})</span>' if item["score_label"] else ""
            parts.append(f'<li><span class="src">{e(_SOURCE_LABELS[item["source"]])}</span>{link(item)}{label}</li>')
        parts.append("</ul>")
    else:
        parts.append("<p>No items surfaced from the queried sources in this window.</p>")

    terms = recurring_terms(results, query)
    if terms:
        parts.append("<p><strong>Recurring terms:</strong> "
                     + ", ".join(f"{e(w)} ({n})" for w, n in terms) + "</p>")

    for name in ALL_SOURCES:
        items = results.get(name) or []
        if not items:
            continue
        parts.append(f"<h2>{e(_SOURCE_LABELS[name])}</h2><ol>")
        for item in items:
            label = f' <span class="label">— {e(item["score_label"])}'
            label += f' · {e(fmt_date(item["published"]))}' if item["published"] else ""
            label += "</span>"
            snippet = f'<span class="snippet">{e(item["snippet"])}</span>' if item["snippet"] else ""
            parts.append(f"<li>{link(item)}{label}{snippet}</li>")
        parts.append("</ol>")

    note_lines = [
        "Engagement signals: Hacker News = points/comments, GitHub = stars. "
        "Reddit, arXiv, and Web are ranked by recency.",
    ]
    empty = [_SOURCE_LABELS[n] for n in ALL_SOURCES if not (results.get(n) or [])]
    if empty:
        note_lines.append("Returned nothing in this window: " + ", ".join(empty) + ".")
    for warning in warnings:
        note_lines.append("Source unavailable — " + warning)
    note_lines.append(
        "Keyless sources only. Paid sources are out of scope until a district key "
        "is provisioned via psd-credentials."
    )
    parts.append('<div class="notes">' + "<br>".join(e(n) for n in note_lines) + "</div>")
    parts.append("</div></body></html>")
    return "\n".join(parts)


def upload_html(html_text, user_email):
    bucket = os.environ.get("WORKSPACE_BUCKET")
    if not bucket:
        _fail("WORKSPACE_BUCKET env var not set — cannot upload HTML artifact", "misconfigured")
    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        import boto3  # baked into the container venv
    except ImportError:
        _fail("boto3 not available in the runtime — cannot upload HTML artifact", "misconfigured")
    key = f"public-images/{user_email}/{uuid.uuid4()}.html"
    try:
        s3 = boto3.client("s3", region_name=region)
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=html_text.encode("utf-8"),
            ContentType="text/html; charset=utf-8",
            Metadata={"generated_by": "psd-last30days"},
        )
    except Exception as exc:  # noqa: BLE001 — botocore ClientError, network failure, etc.
        _fail(f"failed to upload HTML artifact to S3: {exc}", "upstream_error")
    encoded_key = "/".join(urllib.parse.quote(seg) for seg in key.split("/"))
    url = f"https://{bucket}.s3.{region}.amazonaws.com/{encoded_key}"
    return url, key


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser():
    parser = argparse.ArgumentParser(
        description="Research what people said about a topic in the last ~30 days across keyless sources.")
    parser.add_argument("--topic", "--query", dest="topic", help="Topic to research (required)")
    parser.add_argument("--user", help="Caller email (from the [caller: ...] header); required for --format html|both")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS,
                        help=f"Look-back window in days (default {DEFAULT_DAYS}, max {MAX_DAYS})")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"Max items per source (default {DEFAULT_LIMIT}, max {MAX_LIMIT})")
    parser.add_argument("--sources", default="all",
                        help="Comma-separated subset of: " + ",".join(ALL_SOURCES) + " (default all)")
    parser.add_argument("--format", dest="fmt", choices=("md", "html", "both"), default="md",
                        help="Output mode: md (default, brief in chat), html (S3 artifact URL), or both")
    return parser


def normalize_config(ns):
    """Pure validation/normalization of a parsed namespace -> config dict.
    Raises ConfigError(code, message) for anything invalid."""
    topic = (ns.topic or "").strip()
    if not topic:
        raise ConfigError("bad_args", "--topic is required")
    if len(topic) > MAX_TOPIC_CHARS:
        raise ConfigError("bad_args", f"--topic is {len(topic)} chars; maximum is {MAX_TOPIC_CHARS}")

    days = max(1, min(int(ns.days), MAX_DAYS))
    limit = max(1, min(int(ns.limit), MAX_LIMIT))

    raw = (ns.sources or "all").strip().lower()
    if raw in ("", "all"):
        sources = list(ALL_SOURCES)
    else:
        requested = [s.strip() for s in raw.split(",") if s.strip()]
        unknown = [s for s in requested if s not in ALL_SOURCES]
        if unknown:
            raise ConfigError("bad_args", f"unknown source(s): {', '.join(unknown)}. Valid: {', '.join(ALL_SOURCES)}")
        # De-dupe while preserving canonical order.
        sources = [s for s in ALL_SOURCES if s in requested]
    if not sources:
        raise ConfigError("bad_args", "no valid sources selected")

    fmt = ns.fmt
    if fmt in ("html", "both") and not valid_email(ns.user):
        raise ConfigError("bad_args", "--user (a valid email) is required for --format html|both to scope the S3 path")

    return {
        "topic": topic,
        "user": ns.user,
        "days": days,
        "limit": limit,
        "sources": sources,
        "fmt": fmt,
    }


def main(argv=None):
    ns = build_parser().parse_args(argv)
    try:
        cfg = normalize_config(ns)
    except ConfigError as exc:
        _fail(exc.message, exc.code)

    generated_dt = _now_utc()
    cutoff = generated_dt - dt.timedelta(days=cfg["days"])
    since = cutoff.strftime("%Y-%m-%d")
    generated = generated_dt.strftime("%Y-%m-%d %H:%MZ")

    results, warnings = gather(cfg["sources"], cfg["topic"], cutoff, cfg["limit"], cfg["days"])
    total = sum(len(v) for v in results.values())

    brief_md = render_markdown(cfg["topic"], cfg["days"], since, generated, results, warnings)

    out = {
        "status": "ok",
        "topic": cfg["topic"],
        "window_days": cfg["days"],
        "since": since,
        "generated_at": generated,
        "format": cfg["fmt"],
        "total_items": total,
        "counts": {name: len(results.get(name) or []) for name in cfg["sources"]},
        "warnings": warnings,
    }

    if cfg["fmt"] in ("md", "both"):
        out["brief_markdown"] = brief_md
    if cfg["fmt"] in ("html", "both"):
        html_text = render_html(cfg["topic"], cfg["days"], since, generated, results, warnings)
        url, key = upload_html(html_text, cfg["user"])
        out["url"] = url
        out["s3Key"] = key
        out["sharing"] = "public-by-link"

    _emit(out)


if __name__ == "__main__":
    main()
