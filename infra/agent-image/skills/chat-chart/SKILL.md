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
- Massive datasets (≥ 100 series points): the chart will be unreadable in Chat.

## Combining chat-chart with chat-card (recommended pattern)

For "chart this data for me" style requests:

1. Run `chat-chart` to render the chart and get the image URL (first line of stdout).
2. Run `chat-card` with `--image "$CHART_URL"` plus any `--paragraph` / `--kv` widgets you want to add as context (top-line summary, key stats, source date range).
3. Include the chat-card envelope in your reply.

Do NOT pick one or the other when the user wants a chart with surrounding context — pair them.

## Engine selection

| Engine     | Speed | Data leaves AWS? | When |
|------------|-------|------------------|------|
| `quickchart` | <1s   | YES (quickchart.io) | Aggregated, clearly-public data — no PII, no student data, no internal IDs. |
| `local`    | 2–4s  | No (stays in PSD AWS) | Anything sensitive, anything with student IDs, or when you're not 100% sure it's public. |
| `auto` (default) | varies | varies | Picks `local` if `--sensitive` is set OR if data contains things matching email/phone/SSN/PSD student-ID patterns; else `quickchart`. |

**The safety knob is `--sensitive`.** When you're handling anything that's even arguably internal — names, attendance, grades, salaries, FreshService tickets that reference people — pass `--sensitive`. The inline regex is a backstop, not a substitute for judgment.

## Usage

```bash
node /opt/psd-skills/chat-chart/run.js \
  --user <email> \
  --type bar|line|pie|scatter \
  --data-json '[{"label":"Mon","value":12},{"label":"Tue","value":8},...]' \
  [--title "Chart title"] \
  [--engine auto|quickchart|local] \
  [--sensitive] \
  [--text-fallback "Daily volume chart"]
```

**Data shape.**
- `bar`, `line`, `pie`: `[{ "label": string, "value": number }, ...]`
- `scatter`: `[{ "x": number, "y": number }, ...]`

Multi-series and custom colors aren't supported in v1 — keep it to one series for now.

`--user` is required for the `local` engine (used as the S3 key prefix so the chart lives under the calling user's path). Pass the email verbatim from the `[caller: Name <email>]` header of the user turn.

## Output

Prints two things to stdout in order:

1. The chart's image URL on its own line (useful if the agent wants to mention it in prose).
2. A `PSD_AGENT_RICH_V1` envelope wrapping a cardsV2 entry whose section contains an `image` widget pointing at the chart.

**Include the envelope verbatim in your reply** so the Router renders the card. Add a sentence of prose above or below it if the chart needs context — that text becomes the fallback `text` of the message.

## Examples

### Public dashboard data — QuickChart

```bash
node /opt/psd-skills/chat-chart/run.js \
  --user hagelk@psd401.net \
  --type bar \
  --title "Daily message volume (last week)" \
  --data-json '[{"label":"Mon","value":120},{"label":"Tue","value":150},{"label":"Wed","value":135},{"label":"Thu","value":160},{"label":"Fri","value":110}]' \
  --text-fallback "Daily message volume chart"
```

### Student attendance — force local

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

- Missing `--user` (when `local` engine selected): exits non-zero with a clear error on stderr.
- QuickChart returns non-200: skill exits non-zero; agent sees the error in the tool result and should surface it as plain text instead of retrying silently.
- Local matplotlib import fails: skill exits non-zero with a hint to verify the agent image was rebuilt after this skill was added.
