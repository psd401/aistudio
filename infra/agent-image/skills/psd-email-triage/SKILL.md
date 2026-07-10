---
name: psd-email-triage
summary: Smart email triage — opt-in, per-user rules, Gmail labels, daily digest, Chat escalations. Configure entirely from chat.
description: Set up or adjust smart email triage — per-user rules, Gmail labels, daily digest, and Chat escalations. Use when the user wants to start or change triaging their inbox.
allowed-tools: Bash(node:*)
---

# psd-email-triage

Smart email triage controlled entirely through chat. The user says things like "start triaging my email", "ignore vendor-x", "always page me when CEO emails", "show recent classifications", "stop triaging" — and this skill writes the rules into DynamoDB where a background Lambda (`psd-agent-triage-poll-<env>`) picks them up on its next 5-minute tick.

**The skill itself does not classify mail.** It manages CONFIG. The classifier Lambda does the per-email work.

## When to call this skill

- User explicitly asks to enable / disable / configure email triage
- User says "ignore X", "always page me from Y", "auto-archive newsletters" → translate to a `rules.*` or `escalation.*` subcommand
- User asks "show recent triage", "what did you classify?" → `training recent`
- User says "I keep getting Important on noisy senders" → `training correct` + `rules mute`
- User wants a daily summary → `digest enable` / `digest time HH:MM`
- User says "only ping me when you're sure" / "stop pinging me for everything" / "quiet down the notifications" → `escalation mode <high-confidence|rules-only|none>` (+ `escalation threshold`)
- User says "triage my existing inbox" / "sweep my backlog" / "catch up on my old mail" → `sweep`
- User says "show me your suggestions" / "apply that" / "yes do the first one" / "ignore that suggestion" → `suggestions list|apply <id>|dismiss <id>`

Don't call this skill for:
- Generic Gmail operations (use `psd-workspace` / `gws-*`)
- The classifier's runtime behaviour (that's the Lambda — see `docs/operations/email-triage.md`)

## Quick reference

```bash
node /opt/psd-skills/psd-email-triage/run.js <subcommand> --user <email> [args]
```

`--user <email>` is required on every call (matches the existing skill convention; comes from the `[caller: …]` header).

### Lifecycle

| Subcommand | Effect |
|------------|--------|
| `enable` | Create Gmail labels (default `@psd/Important`, `@psd/Later`, `@psd/News`), seed default rules, anchor Gmail history cursor, optionally schedule daily digest, and **kick an initial-inbox sweep** (last 30 days, ≤1000 messages, no Chat pings). Idempotent — running `enable` on an already-enabled triage is a no-op that returns current status. |
| `disable` | Pause classification. Keeps rules + labels intact for re-enable. |
| `disable --forget` | Hard reset: clears rules, learned patterns, decision history; deletes Gmail labels; removes digest schedule. |
| `status` | Returns enabled state, escalation mode/threshold, label set, rule counts, sweep progress, pending-suggestion count, last poll, recent decision counts. |
| `sweep` | (Re)run the initial-inbox backfill for an already-enabled user — classifies the last 30 days of INBOX (≤1000 messages) through the normal pipeline with **no Chat escalations**. Resumable + escalation-silent. No-op if a sweep is already pending/running. |

### Rules

| Subcommand | Effect |
|------------|--------|
| `rules list` | Show all configured rules grouped by type. |
| `rules add-vip <email>` | Always classify as Important. Beats every other rule. |
| `rules mute <pattern>` | Auto-archive sender. Supports `*` wildcards (e.g. `noreply@*`, `*.vendor.com`). |
| `rules add-keyword <kw> --label <important\|later\|news> [--subject\|--snippet\|--from <domain>\|--external]` | Add a keyword rule. Defaults to subject-match. |
| `rules remove <type> <value>` | Remove a rule. `type` is `vip`, `mute`, or `keyword`. |

### Escalation (Chat pings)

| Subcommand | Effect |
|------------|--------|
| `escalation list` | Show current escalation mode, threshold, senders + keywords + label triggers. |
| `escalation add-sender <email>` | Always Chat-ping when this sender's mail classifies as Important. |
| `escalation add-keyword <kw>` | Always Chat-ping when an Important message's subject/snippet contains this keyword. |
| `escalation remove <type> <value>` | Remove an escalation rule. `type` is `sender` or `keyword`. |
| `escalation labels <label1,label2>` | Override which labels trigger Chat. Default: `important` only. |
| `escalation mode <all\|high-confidence\|rules-only\|none>` | **Per-user policy for which Important classifications ping Chat.** `all` (default) = every Important pings. `high-confidence` = only rule matches + LLM decisions ≥ threshold. `rules-only` = only your VIP/escalation-rule matches; plain LLM Important never pings. `none` = label only, digest is the sole surface. Explicit escalation sender/keyword rules always ping (except `none`). |
| `escalation threshold <0-1>` | LLM-confidence bar for `high-confidence` mode. Default `0.85`. |

### Training feedback

| Subcommand | Effect |
|------------|--------|
| `training recent [--limit N]` | Last N classifications (default 20) with sender, subject, label, source (rule vs llm), confidence, reason. |
| `training correct <messageId> <newLabel>` | Re-label one message in Gmail and record a training signal. |

### Learned suggestions

A nightly job mines the user's corrections into weighted hints (fed to the
classifier automatically) and **suggested rule changes** ("you archived 3
Important emails from X → mute X"). Hard rules are **suggest-only** — a
suggestion becomes a real rule only when the user approves it here. New
suggestions also arrive as a Chat card.

| Subcommand | Effect |
|------------|--------|
| `suggestions list` | Show pending rule suggestions (each has an `id`, `kind` = `mute`/`vip`, `target`, and `reason`). |
| `suggestions apply <id>` | Approve a suggestion — writes the real rule (`vip` → VIP sender, `mute` → mute pattern) and clears it from pending. |
| `suggestions dismiss <id>` | Reject a suggestion — cleared from pending and **never raised again**. |

### Simulation

| Subcommand | Effect |
|------------|--------|
| `simulate --from <email> [--subject "..."] [--snippet "..."] [--external] [--has-user-reply]` | Dry-run the rule engine against a synthetic email. Useful for "would my mute rule catch this?" without waiting for real mail. |

### Labels

| Subcommand | Effect |
|------------|--------|
| `labels list` | Show current label names + Gmail label IDs. |
| `labels rename <key> <new-name>` | Rename one of `important` / `later` / `news` (renames the Gmail label too). |

### Digest

| Subcommand | Effect |
|------------|--------|
| `digest enable` | Schedule a daily summary card at the user's configured time. |
| `digest disable` | Remove the daily schedule (rules/labels stay). |
| `digest time <HH:MM>` | Set the time (24-hour, user's timezone from the agent users table). Default `08:00`. |

### Tasks (user-gesture, Phase 1.5)

When the user applies the `@psd/Task` label to a Gmail message, the classifier
Lambda detects the gesture. What happens next depends on `tasksMode`:

| Subcommand | Effect |
|------------|--------|
| `tasks mode none` | (default) Lambda ignores the label — the message just sits with `@psd/Task` applied. No automation. |
| `tasks mode invoke-agent` | Lambda invokes AgentCore with the email metadata. The user's agent (per their `MEMORY.md` instructions + skills) creates a task in their preferred task system. On success the email is archived (INBOX + @psd/Task removed). On failure the email is left alone and a Chat card surfaces the reason. |
| `tasks notify-success on\|off` | (default off) When on, every successful task creation posts a one-line confirmation card to Chat. Failures always notify regardless. |
| `tasks status` | Returns current mode, notify setting, recent task-creation entries. |

For `invoke-agent` mode to actually create tasks, the user's `MEMORY.md` must
include instructions for what to do when invoked with a `[psd-email-triage
task request]` prompt. The reply must be exactly one line in either
`Created <system> <type> <id>: <title>` or `FAILED: <reason>` shape — the
Lambda parses this deterministically.

## Output

stdout is JSON — one object per call. Shape:

```json
{
  "ok": true,
  "subcommand": "enable",
  "summary": "Watching <email>. 3 Gmail labels created. Default rules seeded.",
  "data": { /* subcommand-specific */ }
}
```

On error: `{ "ok": false, "subcommand": "...", "error": "...", "code": "..." }`.

The agent should:
- Show `summary` to the user as the headline
- Use `data` to render any follow-on cards (rule lists, training tables, etc.) via `chat-card`

## Examples

### Onboarding

```bash
node /opt/psd-skills/psd-email-triage/run.js enable --user hagelk@psd401.net
```

### "Ignore noisy vendor X"

```bash
node /opt/psd-skills/psd-email-triage/run.js rules mute "noreply@vendor-x.com" --user hagelk@psd401.net
```

### "Always page me when the CEO emails"

```bash
node /opt/psd-skills/psd-email-triage/run.js escalation add-sender ceo@psd401.net --user hagelk@psd401.net
```

### "I'm getting Important on github noreplies"

```bash
# 1. Move recent github noreply messages to Later
node /opt/psd-skills/psd-email-triage/run.js training correct <messageId> later --user hagelk@psd401.net
# 2. Add a mute rule so future ones auto-go
node /opt/psd-skills/psd-email-triage/run.js rules mute "noreply@github.com" --user hagelk@psd401.net
```

## Rule 13 reminder

If the user says "set this up for the whole organisation" or anything that touches OTHER USERS' triage rows, **refuse**. This skill is strictly per-caller. Multi-user setup is admin work and lives at `/admin/agents/[userEmail]/triage`.
