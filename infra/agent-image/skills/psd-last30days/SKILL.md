---
name: psd-last30days
summary: Research what people said about a topic in the last ~30 days across keyless social/community sources (Hacker News, Reddit, arXiv, GitHub, Google News) and return a grounded, cited brief — in chat, as an S3 HTML artifact, or both.
description: Research recent chatter on a topic — "what did people actually say about X in the last ~30 days?" Fans out across free, keyless sources (Hacker News, Reddit, arXiv, GitHub, Google News), ranks by engagement/recency, de-duplicates, and returns a source-cited brief you synthesize. Default output is a Markdown brief in chat; on request it also (or instead) produces a self-contained HTML page uploaded to S3 and shareable by link. Use for trend/pulse/"what's new" research on a person, product, company, or topic.
allowed-tools: Bash(python3:*)
---

# psd-last30days

Research **what people actually said about a topic in the last ~30 days** across
free, keyless social and community sources, then hand you a grounded, cited brief
to synthesize from. This is a lean PSD port of the open-source
[last30days](https://github.com/mvanhorn/last30days-skill) skill (MIT), fitted to
the AgentCore runtime.

The engine fans out, filters to the window, ranks each source by its native
engagement signal (or recency), de-duplicates, and returns the ranked findings.
**You (the reasoning model) write the narrative synthesis on top of that draft** —
the engine does the grounding, you do the sense-making.

## Sources (v1 — all keyless, no district key needed)

| Source | Signal | Notes |
|--------|--------|-------|
| **Hacker News** | points, comments | Algolia search, window-filtered |
| **Reddit** | recency | Public search RSS; may be rate-limited (429) from cloud IPs — degrades gracefully |
| **arXiv** | recency | Research pre-prints, newest first |
| **GitHub** | stars | Repos pushed within the window; borrows your `gh auth token` for a higher rate limit if you have one, otherwise keyless |
| **Web (Google News)** | recency | Recent press/editorial coverage |

Paid sources (X/xAI, TikTok/Instagram via ScrapeCreators, Perplexity, Brave) are
**out of scope** until a district key is provisioned via `psd-credentials`.

## Identity

Pass `--user <caller-email>` verbatim from the `[caller: Name <email>]` header of
the user turn. It is **required for `--format html|both`** (it scopes the S3 key
path to the caller). For the default Markdown mode it is optional but harmless.

## Usage

```bash
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "<topic>"
```

Options:

| Flag | Description |
|------|-------------|
| `--topic "<text>"` | Topic to research (required; `--query` is an alias) |
| `--user <email>` | Caller email; **required** for `--format html\|both` |
| `--format md\|html\|both` | Output mode (default `md`) — see below |
| `--days <n>` | Look-back window (default `30`, max `90`) |
| `--limit <n>` | Max items per source (default `10`, max `25`) |
| `--sources <list>` | Comma-separated subset of `hackernews,reddit,arxiv,github,web` (default all) |

```bash
# Default: Markdown brief in chat
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "llama 4" --days 14

# Only two sources, tighter list
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "chromebooks in schools" --sources web,hackernews

# HTML artifact uploaded to S3 (public-by-link)
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --user name@psd401.net --topic "gpt-5" --format html

# Both: brief in chat AND an S3 HTML link
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --user name@psd401.net --topic "gpt-5" --format both
```

## Output modes — how to choose

Pick the mode from what the user asked for:

- **`md` (default)** — for "what's the buzz on X", "catch me up on X", any in-chat
  answer. The result JSON carries `brief_markdown`: a cited, structured brief
  (a *What's surfacing* snapshot + per-source sections with links, dates, and
  engagement). **Relay `brief_markdown`**, and add 1–3 sentences of your own
  synthesis at the top (the themes, the disagreement, what changed). Keep the
  citations.
- **`html`** — when the user wants "a page", "something to share", "a report",
  "a link", or a polished artifact. The engine renders the brief to a
  self-contained styled HTML page, uploads it to S3 public-by-link, and returns a
  `url`. Surface that URL (see the reply rule below); you do not need to relay the
  Markdown.
- **`both`** — when the user wants the answer now *and* a shareable link. The
  result carries `brief_markdown` **and** `url`.

### Reply rule for `html` / `both`

When the result includes a `url`, your chat reply **must contain the bare `url`
on a line by itself** — the user cannot see the tool result. Do not wrap it in
`[label](url)` or `**bold**` (Google Chat corrupts long S3 URLs). One short line
of context above it is fine.

## Result shape

```json
{
  "status": "ok",
  "topic": "gpt-5",
  "window_days": 30,
  "since": "2026-06-10",
  "generated_at": "2026-07-10 21:11Z",
  "format": "both",
  "total_items": 23,
  "counts": { "hackernews": 8, "reddit": 0, "arxiv": 5, "github": 5, "web": 5 },
  "warnings": ["Reddit: HTTPError: HTTP Error 429: Too Many Requests"],
  "brief_markdown": "# Last-30-days brief: gpt-5\n...",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/public-images/<email>/<uuid>.html",
  "s3Key": "public-images/<email>/<uuid>.html",
  "sharing": "public-by-link"
}
```

`brief_markdown` is present for `md`/`both`; `url`/`s3Key` for `html`/`both`.

## Notes & limits

- **Graceful degradation.** A source that errors or is rate-limited contributes
  nothing and is listed under `warnings` — the brief is still built from the
  sources that answered. Expect Reddit to 429 intermittently from cloud IPs.
- **Engagement vs recency.** Only Hacker News (points/comments) and GitHub
  (stars) carry a keyless engagement signal; Reddit, arXiv, and Web are ranked by
  recency. Don't over-read the ordering of the recency-ranked sources.
- **Reddit relevance is loose.** Keyless Reddit search returns recent posts that
  loosely match; treat low-signal Reddit hits with skepticism when you synthesize.
- **No secrets.** The engine reads **no** environment variables, `.env`, or
  `~/.config` credentials. If a paid source is ever added, its key must come from
  `psd-credentials get --shared --name <key>` — never the environment.
- **Window & size caps.** `--days` ≤ 90, `--limit` ≤ 25 per source, topic ≤ 300
  chars.

## Errors

Errors are a single JSON object `{ "status": "error", "error": "<code>", "message": "..." }`:

- **`bad_args`** — missing `--topic`, an unknown `--source`, an over-long topic,
  or `--format html|both` without a valid `--user` email.
- **`misconfigured`** — `--format html` requested but `WORKSPACE_BUCKET` is unset
  or `boto3` is unavailable (S3 upload impossible).
- **`upstream_error`** — `--format html` requested but the S3 upload failed.

Two kinds of failure are **not** fatal — they surface under `warnings` in a
successful (`status: "ok"`) result, not as an error:
- Any individual source failing or being rate-limited (the brief is built from
  the sources that answered).
- For **`--format both`**, an HTML-upload failure degrades to delivering just the
  Markdown brief plus a `HTML artifact upload failed (...)` warning — only
  `--format html` (with nothing else to return) fails hard.
