---
name: psd-last30days
summary: Research what people said about a topic in the last ~30 days across keyless social/community sources (Hacker News, Reddit, arXiv, GitHub, Google News) and return a grounded, cited brief — in chat, as a private Atrium page, or both.
description: Research recent chatter on a topic — "what did people actually say about X in the last ~30 days?" Fans out across free, keyless sources (Hacker News, Reddit, arXiv, GitHub, Google News), ranks by engagement/recency, de-duplicates, and returns a source-cited brief you synthesize. Default output is a Markdown brief in chat; on request it also (or instead) produces a self-contained HTML page delivered privately as an Atrium artifact. Use for trend/pulse/"what's new" research on a person, product, company, or topic.
allowed-tools: Bash(/opt/agentcore-venv/bin/python3:*)
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
the user turn. It is **required for `--format html|both`**. For the default
Markdown mode it is optional but harmless.

## Usage

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "<topic>"
```

Options:

| Flag | Description |
|------|-------------|
| `--topic "<text>"` | Topic to research (required; `--query` is an alias) |
| `--user <email>` | Caller email; **required** for `--format html\|both` |
| `--format md\|html\|both` | Output mode (default `md`) — see below |
| `--out <path.html>` | Where to write the page for `html\|both` (default: a file in the work dir) |
| `--days <n>` | Look-back window (default `30`, max `90`) |
| `--limit <n>` | Max items per source (default `10`, max `25`) |
| `--sources <list>` | Comma-separated subset of `hackernews,reddit,arxiv,github,web` (default all) |

```bash
# Default: Markdown brief in chat
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "llama 4" --days 14

# Only two sources, tighter list
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --topic "chromebooks in schools" --sources web,hackernews

# HTML page written locally, then delivered privately (see below)
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --user name@psd401.net --topic "gpt-5" --format html

# Both: brief in chat AND the HTML page
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-last30days/scripts/last30days.py --user name@psd401.net --topic "gpt-5" --format both
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
  self-contained styled HTML page and writes it to a local file (`html_path`).
  Nothing is uploaded and nothing is public.
- **`both`** — when the user wants the answer now *and* a page. The result
  carries `brief_markdown` **and** `html_path`.

## Delivering the page (`html` / `both`) — private by default

Every agent output is private to the person who asked (#2034). Deliver the page
as a **private Atrium artifact** by running the exact `deliver_with` command from
the result (psd-atrium `create-artifact --code-file <html_path> --body-format
html`). It starts private + draft: the requester can open it, nobody else can.
Do **not** publish it to the intranet or widen its visibility unless the user
asks for that audience in so many words — "share it with X" means grant that
person (psd-atrium `set-visibility --level group --add-grants`), never publish.

Then your chat reply **must contain the Atrium `url` bare, on a line by
itself** — the user cannot see the tool result.

- ✅ `Here's the brief (private to you):` then the bare URL on its own line.
- ❌ `[Open the brief](https://…)` or `**https://…**` — Google Chat corrupts
  long URLs wrapped in link or bold markup.
- ❌ Replying "the brief has been created" without including the URL.

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
  "html_path": "/home/node/.openclaw/work/last30days-gpt-5-20260710-211100.html",
  "sharing": "local-file",
  "deliver_with": "node /opt/psd-skills/psd-atrium/run.js create-artifact --title \"Last 30 days: gpt-5\" --code-file \"/home/node/.openclaw/work/last30days-gpt-5-20260710-211100.html\" --body-format html"
}
```

`brief_markdown` is present for `md`/`both`; `html_path`/`sharing`/`deliver_with`
for `html`/`both` — except that on `both`, a page that cannot be written omits
them and degrades to the Markdown brief plus a warning (see **Errors**).

## Notes & limits

- **Graceful degradation.** A source that errors or is rate-limited contributes
  nothing and is listed under `warnings` — the brief is still built from the
  sources that answered. Expect Reddit to 429 intermittently from cloud IPs.
- **Engagement vs recency.** Only Hacker News (points/comments) and GitHub
  (stars) carry a keyless engagement signal; Reddit, arXiv, and Web are ranked by
  recency. Don't over-read the ordering of the recency-ranked sources.
- **Reddit relevance is loose.** Keyless Reddit search returns recent posts that
  loosely match; treat low-signal Reddit hits with skepticism when you synthesize.
- **No dedicated secrets.** The engine needs no API key and uploads nothing.
  GitHub access uses the allowlisted GitHub broker; no credentials enter the
  model process.
- **De-duplication is mechanical.** Items with the same normalized title or URL
  are folded to their first occurrence; the same story *retitled* by two outlets
  can still appear twice — fold those in your synthesis.
- **Web citations are Google News redirect links** (`news.google.com/rss/...`),
  not the publisher's URL — they open the article, but don't cite them as the
  publisher's own domain.
- **Window & size caps.** `--days` ≤ 90, `--limit` ≤ 25 per source, topic ≤ 300
  chars, and all sources share a combined 60s fetch budget (a source that blows
  it is reported under `warnings`).

## Errors

Errors are a single JSON object `{ "status": "error", "error": "<code>", "message": "..." }`:

- **`bad_args`** — missing `--topic`, an unknown `--source`, an over-long topic,
  `--format html|both` without a valid `--user` email, `--out` that is not an
  `.html` path or is used without `--format html|both`, or any malformed flag
  (non-integer `--days`/`--limit`, unknown option — argparse failures honor the
  JSON contract too).
- **`upstream_error`** — `--format html` requested but the page could not be
  written.

Two kinds of failure are **not** fatal — they surface under `warnings` in a
successful (`status: "ok"`) result, not as an error:
- Any individual source failing or being rate-limited (the brief is built from
  the sources that answered).
- For **`--format both`**, a page that cannot be written degrades to delivering
  just the Markdown brief plus a `HTML page could not be written (...)` warning — only
  `--format html` (with nothing else to return) fails hard.
