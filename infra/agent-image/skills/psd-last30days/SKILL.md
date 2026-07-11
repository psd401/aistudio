---
name: psd-last30days
summary: Research what people said about a topic across Reddit, Hacker News, GitHub, arXiv, and Google News in the last N days — a cited digest, in chat or as a shareable HTML page.
description: Research "what has people actually said about X in the last ~30 days" across social/community sources (Reddit, Hacker News, GitHub, arXiv, public web news) and return a grounded, source-cited brief. Use when the user asks for a "last 30 days" recap, recent chatter, or a trend/sentiment check on a topic.
allowed-tools: Bash(python3:*)
---

# psd-last30days

Fan out across five keyless public sources — Reddit, Hacker News, GitHub, arXiv,
and Google News — for a topic, filter to the last N days (default 30), and return
a structured, source-cited digest grouped by source. No API keys, no host
`WebSearch` tool, no first-run wizard — everything runs against public,
unauthenticated endpoints baked into the container.

Use the returned digest as your source material: read the `markdown` field and
write your own synthesized summary/analysis in chat, citing the linked items.
The skill itself does the fetching and organizing; you do the reasoning.

**Identity.** Requires `--user <caller-email>`. Pass the email verbatim from the
`[caller: Name <email>]` header of the user turn — it scopes the S3 upload path
when `--format html` or `--format both` is requested. It has no effect on `md`-only
requests beyond validation.

## Usage

```bash
python3 /opt/psd-skills/psd-last30days/scripts/last30days.py \
  --topic "<topic to research>" \
  --user <email> \
  [--days 30] \
  [--format md | html | both] \
  [--sources reddit,hackernews,github,arxiv,web] \
  [--limit-per-source 10]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--topic` | _required_ | Free-text topic/query, ≤ 200 chars |
| `--user` | _required_ | Caller's email — required always, used for S3 scoping only in `html`/`both` mode |
| `--days` | `30` | Lookback window, 1–90 |
| `--format` | `md` | `md` — digest inlined only; `html` — digest rendered + uploaded to S3, no inline markdown item list needed; `both` — do both |
| `--sources` | all five | Comma-separated subset to query |
| `--limit-per-source` | `10` | Max items per source, 1–50 |

## Output

A single JSON object on stdout:

```json
{
  "status": "ok",
  "topic": "...",
  "window_days": 30,
  "sources_used": ["arxiv", "hackernews", "reddit"],
  "sources_failed": [{"source": "github", "error": "..."}],
  "item_count": 27,
  "markdown": "# Last 30 Days: ...\n\n## Arxiv (4)\n- [title](url) (2026-07-01) — snippet\n...",
  "html_url": "https://.../public-images/<email>/<uuid>.html"
}
```

- `markdown` is always present (empty-results digest if nothing matched) — read it and write your synthesis from it.
- `html_url` is present only when `--format` is `html` or `both`: a self-contained, styled HTML page grouped the same way as the markdown, uploaded public-by-link (same sharing model as `psd-image-gen`/`psd-tts` — unsigned URL, unguessable UUID path).
- `sources_failed` lists any source that errored (timeout, malformed response) — the run still succeeds with partial results as long as at least one source returned something.

## Required Reply Format (when `--format html`/`both`)

If the caller asked for a shareable page, your next chat message MUST include the
bare `html_url` value on its own line — same rule as `psd-image-gen` (the user
cannot see the tool result; Google Chat renders bare URLs as links, not
markdown-wrapped ones).

## Choosing sources

All five sources are queried by default. Narrow with `--sources` when the topic
is clearly scoped to one community (e.g. `--sources github,hackernews` for a
software-library trend check, `--sources reddit,web` for general public sentiment).

- **reddit** — `reddit.com/search.rss`, sorted by newest, last-month window.
- **hackernews** — Algolia's HN Search API (`hn.algolia.com`), keyless JSON.
- **arxiv** — arXiv's Atom query API, sorted by submission date.
- **github** — direct unauthenticated GitHub REST search (`api.github.com/search/repositories`), filtered by `pushed:>`. **Not** the `gh` CLI: `gh` requires a per-user `github_pat` credential (see `psd-github/SKILL.md`) that most callers won't have provisioned, so it isn't actually keyless. The public search API works unauthenticated at 10 requests/minute, ample for one research run.
- **web** — Google News' documented keyless RSS search endpoint (`news.google.com/rss/search`), not HTML scraping.

## Notes & limits

- Every adapter degrades independently — one source timing out or returning a
  malformed response does not fail the whole run; it's recorded in
  `sources_failed`. The run only errors out (`upstream_error`) if **every**
  requested source failed.
- No paid sources (X/xAI, ScrapeCreators, Perplexity, Brave) are wired in — out
  of scope for v1 per the issue decision. If a district key is later
  provisioned, a new adapter would read it via
  `psd-credentials/get.js --user <email> --shared --name <name>`, following the
  same subprocess + JSON-parse contract `psd-image-gen` uses for its OpenAI key.
- No capability gating — open to all agent users (explicit decision, no
  `skill.last30days` row).
- This skill does **not** call an LLM itself — the reasoning/synthesis step is
  the calling agent's job, using the returned `markdown` as source material.

## Errors

- **`bad_args`** — missing/empty `--topic`, invalid `--user` email, `--days`/`--limit-per-source` out of range, or an unknown `--sources` name.
- **`upstream_error`** — every requested source failed (network/parse errors); message lists each source's error.
- **`misconfigured`** — `WORKSPACE_BUCKET` env var unset while `--format html`/`both` was requested.
