---
name: chat-card
summary: Send a rich Google Chat card (header, sections, buttons) instead of plain text.
description: Builds a Google Chat cardsV2 payload wrapped in the PSD_AGENT_RICH_V1 envelope. The Router Lambda detects the envelope and renders the card inline in Chat. Use this for structured replies — morning brief sections, key/value summaries, confirmations with buttons. The skill produces only stdout JSON; it does not call the Chat API directly.
allowed-tools: Bash(node:*)
---

# chat-card

Emit a rich Google Chat card. The skill prints a `<<<PSD_AGENT_RICH_V1>>>` envelope wrapping a single `cardsV2` entry. **Include the entire envelope verbatim in your final reply to the user** — the Router Lambda parses it out and sends the card. Any prose you add before or after the envelope (outside the sentinels) becomes the fallback `text` of the message (used by Chat for notification previews and clients that don't render cards).

## When to use this

- Multi-section replies (e.g. morning brief with calendar / inbox / team-logs sections).
- Key/value summaries (e.g. "Ticket created — Title: X, ID: Y, Status: Open").
- Replies that benefit from buttons (e.g. "View in FreshService", "Mark resolved", "Try again").
- Whenever you would otherwise type a bulleted list of labels and values.

**Do NOT use** for:
- A single short sentence reply.
- Verbatim relay of someone else's text where the formatting matters and adding a card would distort the message.
- Anything sensitive enough that you'd want plain text (cards can be screenshot just like text — but skip when in doubt).

## Two interfaces — pick whichever fits

### High-level (preferred)

```bash
node /opt/psd-skills/chat-card/run.js \
  --title "Card title" \
  [--subtitle "Subtitle under the title"] \
  [--paragraph "First paragraph of body."] \
  [--paragraph "Another paragraph; flag is repeatable."] \
  [--kv "Status::Open"] \
  [--kv "Assignee::hagelk@psd401.net"] \
  [--divider] \
  [--image "https://example.com/chart.png"] \
  [--button "View ticket::view_ticket::id=12345"] \
  [--text-fallback "Ticket 12345 created."]
```

Repeatable flags add widgets in the order they appear. `--divider` inserts a divider widget at that point in the sequence.

**Buttons.** `--button "<label>::<intent>[::<key>=<value>;<key>=<value>...]"`. The intent name and any params travel back to your agent when the user clicks — your next turn will receive a synthesised user message like `[button] intent=view_ticket id=12345`.

**Key/value.** `--kv "<topLabel>::<text>"`. Rendered as a `decoratedText` widget (label above, value below).

### Low-level (escape hatch)

```bash
node /opt/psd-skills/chat-card/run.js \
  --card-json '{"header":{"title":"..."},"sections":[{"widgets":[{"textParagraph":{"text":"..."}}]}]}' \
  [--text-fallback "Fallback text"]
```

Pass a full Google Chat `card` object. Use when you need a widget the high-level interface doesn't expose (selectionInput, dateTimePicker, columns, etc.) — see https://developers.google.com/chat/api/reference/rest/v1/cards.

## Output

stdout: the rich envelope, on its own lines. Print it as-is — do not edit it. Example:

```
<<<PSD_AGENT_RICH_V1>>>
{"cardsV2":[{"cardId":"c1","card":{"header":{"title":"…"},"sections":[…]}}],"textFallback":"Ticket 12345 created."}
<<<END_PSD_AGENT_RICH_V1>>>
```

stderr: human-readable diagnostics (errors, warnings about ignored flags) — your turn ignores stderr.

## Examples

### Morning brief shell (sections only, no buttons)

```bash
node /opt/psd-skills/chat-card/run.js \
  --title "Morning Brief — 2026-05-15" \
  --paragraph "*Today:* 4 meetings, 12 inbox items, 2 follow-ups due." \
  --divider \
  --kv "Next meeting::8:30 AM — Tech IF Interviews" \
  --kv "Unread email::12 messages" \
  --text-fallback "Morning Brief delivered"
```

### Ticket confirmation with action button

```bash
node /opt/psd-skills/chat-card/run.js \
  --title "FreshService ticket created" \
  --kv "Ticket ID::#12345" \
  --kv "Title::Printer offline at GHHS" \
  --kv "Status::Open" \
  --button "View in FreshService::view_ticket::id=12345" \
  --text-fallback "Ticket #12345 created"
```

### Chart image inline

Pair with `chat-chart` (which uploads a chart PNG and returns a URL), then:

```bash
node /opt/psd-skills/chat-card/run.js \
  --title "Daily message volume" \
  --image "$CHART_URL" \
  --paragraph "Mon–Fri last week, agent-router only." \
  --text-fallback "Daily message volume chart"
```
