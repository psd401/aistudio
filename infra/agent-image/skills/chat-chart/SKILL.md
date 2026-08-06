---
name: chat-chart
summary: REQUIRED for any user request containing "chart", "graph", "plot", or "visualize" — renders inline bar/line/pie/scatter in Google Chat.
description: Render an inline bar/line/pie/scatter chart in Google Chat from a small data payload. REQUIRED whenever the user asks to "chart", "graph", "plot", or "visualize" data.
allowed-tools: Bash(node:*)
---

# chat-chart

Render a chart and surface it as an inline image in a Google Chat card.

## When to use — non-negotiable triggers

**If the user's request contains any of these words: "chart", "graph", "plot", "visualize", "visualise", "draw" → you MUST call this skill.** Do not fall back to a text card with the data laid out as bullet points or decoratedText widgets. The user explicitly asked for a visual; deliver one.

Other good triggers:
- Comparison or trend that's clearer as a picture than a list of numbers.
- Morning-brief or weekly-report cards that benefit from a small visual summary.

Don't use this for:
- A single number or short list — a sentence is better.
- Massive datasets: on the default engine 50 series points is a hard ceiling (the skill exits 3 above it), and much past ~25 the bars are thinner than their labels. Aggregate first.

## Combining chat-chart with chat-card (recommended pattern)

For "chart this data for me" style requests:

1. Run `chat-chart` to render the chart and get the image URL (first line of stdout).
2. Run `chat-card` with `--image "$CHART_URL"` plus any `--paragraph` / `--kv` widgets you want to add as context (top-line summary, key stats, source date range).
3. Include the chat-card envelope in your reply.

Do NOT pick one or the other when the user wants a chart with surrounding context — pair them.

## Comparing several series in one chart

Give each point a `values` object instead of a single `value`, and every named
series becomes its own dataset — grouped bars for `bar`, one line each for
`line`, with a legend naming them:

```bash
node /opt/psd-skills/chat-chart/run.js \
  --user hagelk@psd401.net --type bar \
  --title 'DES i-Ready by grade - Spring 2026' \
  --data-json '[
    {"label":"Grade 1","values":{"Math":412,"Reading":398}},
    {"label":"Grade 2","values":{"Math":441,"Reading":430}}
  ]'
```

Prefer this over emitting two separate charts when the user asks to compare
subjects, years, or schools — one chart is what they asked for. Every series
must supply a value at every label; a gap is refused rather than drawn as zero.
`pie` takes a single series only (a pie divides one whole), so use `bar` to
compare.

The flat `{"label":…,"value":…}` shape is unchanged for single-series charts.

## Engine selection

| Engine     | Speed | Data leaves AWS? | When |
|------------|-------|------------------|------|
| `auto` (default) | <1s | No (stays in PSD AWS) | Everything. Renders on-host — same engine as `local`. |
| `local`    | <1s   | No (stays in PSD AWS) | Same as `auto`; name it when you want the choice to be explicit in the transcript. |
| `quickchart` | <1s   | YES (quickchart.io) | Only for data you have verified is public. Refused outright for `--sensitive` or PII-matching data. |

**You do not need to reason about sensitivity to get a chart.** The default
engine rasterises the PNG inside the agent container and uploads it to the PSD
workspace bucket, so student, staff, achievement, attendance and HR data all
chart normally. `--sensitive` is still worth passing — it documents intent and
hard-blocks an accidental `--engine quickchart` — but it is no longer the
difference between a chart and a refusal.

**What "on-host" does and does not mean.** The *values* never leave PSD AWS:
no third party ever sees the numbers, the labels, or the chart spec. The
finished PNG is a different matter — Google Chat has to fetch it, so it is
published to an unauthenticated (unguessable, ~30-day) workspace URL, exactly
like `psd-image-gen` output. Anyone holding that URL, Google included, can
fetch the image. Treat a chart of student data the way you would treat any
other image you post into a Chat space: fine for the audience in the space,
not a place for anything you would not put in the message body.

**Never pass `--engine quickchart` for district data.** It encodes the values
into a quickchart.io URL, so the numbers land in a third party's logs. The skill
refuses that combination when `--sensitive` is set or the data trips the inline
email/phone/SSN/student-ID regex, but the regex is a backstop, not a substitute
for judgment.

## Usage

```bash
node /opt/psd-skills/chat-chart/run.js \
  --type bar|line|pie|scatter \
  --data-json '[{"label":"Mon","value":12},{"label":"Tue","value":8},...]' \
  [--user <email>] \
  [--title "Chart title"] \
  [--engine auto|quickchart|local] \
  [--sensitive] \
  [--text-fallback "Daily volume chart"]
```

**Data shape.**
- `bar`, `line`, `pie`: `[{ "label": string, "value": number }, ...]`
- `scatter`: `[{ "x": number, "y": number }, ...]`

Multi-series and custom colors aren't supported in v1 — keep it to one series for now.

`--user` is optional. The workspace broker derives the storage path from the calling agent's identity, so the email is provenance only — pass it verbatim from the `[caller: Name <email>]` header of the user turn when you have it.

**Rendering limits.** Up to 50 points per chart; one series; labels are drawn with a built-in 5x7 ASCII font, so non-ASCII characters (accents, em dashes, curly quotes) render as `?` and long category labels are truncated to fit their slot. Prefer short, ASCII labels.

The 50-point cap is enforced by the local renderer, so it binds on `auto` and `local` — i.e. every chart unless you explicitly ask for `--engine quickchart`. That path has no point-count check of its own and is bounded only by argv size and the ~16KB practical spec-URL ceiling noted above; a large explicit-quickchart payload fails as a broken URL rather than a clean exit 3. Not a reason to send one — it's a reason not to reach for `--engine quickchart` to escape the cap.

## Output

Prints two things to stdout in order:

1. The chart's image URL on its own line (useful if the agent wants to mention it in prose).
2. A `PSD_AGENT_RICH_V1` envelope wrapping a cardsV2 entry whose section contains an `image` widget pointing at the chart.

**Include the envelope verbatim in your reply** so the Router renders the card. Add a sentence of prose above or below it if the chart needs context — that text becomes the fallback `text` of the message.

**Every delivery surface renders this envelope — Google Chat and the AI Studio
web chat alike.** The Router owns rendering, not the client, so there is no
surface where emitting the envelope is wrong. Never strip it, summarise the
chart in prose instead of showing it, or withhold the image because you think
the caller's client cannot display a card. Observed 2026-08-06: an agent assumed
web chat could not render the envelope, sent a title-only card with no image,
and repeated that across several turns while the user told it the chart was
missing — the assumption was invented, not read anywhere, and it took a
screenshot of a working chart to dislodge it.

If a user says the image did not appear, do NOT theorise about their client.
Resend the envelope exactly as `run.js` emitted it, and log it with
`psd-failure-report` — a chart the user cannot see is a failure whatever the
cause.

## Examples

### Any district data — the default (on-host) engine

```bash
node /opt/psd-skills/chat-chart/run.js \
  --user hagelk@psd401.net \
  --type bar \
  --title "Daily message volume (last week)" \
  --data-json '[{"label":"Mon","value":120},{"label":"Tue","value":150},{"label":"Wed","value":135},{"label":"Thu","value":160},{"label":"Fri","value":110}]' \
  --text-fallback "Daily message volume chart"
```

### Student attendance — flagged sensitive (still the local engine)

```bash
node /opt/psd-skills/chat-chart/run.js \
  --user hagelk@psd401.net \
  --type line \
  --title "Daily attendance — Building 3" \
  --data-json '[{"label":"2026-05-12","value":0.94},{"label":"2026-05-13","value":0.95},...]' \
  --sensitive \
  --text-fallback "Attendance trend"
```

### Combining with chat-card

Run `chat-chart` first to get a chart URL, then build a richer card with `chat-card`:

```bash
CHART_URL=$(node /opt/psd-skills/chat-chart/run.js --user ... --type bar --data-json ... | head -1)
node /opt/psd-skills/chat-card/run.js \
  --title "Weekly Report" \
  --paragraph "Top-line: volume held steady." \
  --image "$CHART_URL" \
  --kv "Total::1,290 messages" \
  --button "Open dashboard::open_dashboard"
```

The chart-card combo is the standard pattern for richer dashboards — `chat-chart` alone produces a card with just the chart and (optional) title, which is fine for quick answers.

## Failure behavior

- Malformed `--user`: exits non-zero with a clear error on stderr.
- `--engine quickchart` combined with `--sensitive` or PII-matching data: exits 3 without rendering and without building a quickchart.io URL. Drop the `--engine` flag and re-run — the same chart renders on-host.
- Local render fails (unsupported type, non-numeric values, more than 50 points): exits 3 with the reason on stderr. Fix the payload; do not fall back to QuickChart.
- Artifact upload fails: exits non-zero. Surface the error as plain text instead of retrying silently.
