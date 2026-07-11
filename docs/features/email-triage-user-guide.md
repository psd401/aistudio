# Email Triage — User Guide

How to use PSD AI Agent email triage from first enable through day-to-day use
and continuous tuning. Everything here is done by **chatting with your agent
in Google Chat** or by **acting naturally in Gmail** — there is no separate
app to learn.

> Admins/operators: the runtime architecture, ops knobs, and troubleshooting
> matrix live in [docs/operations/email-triage.md](../operations/email-triage.md).

---

## 1. What it does

Once enabled, the agent watches your Gmail and files every new message into
one of three labels within about 5 minutes of arrival:

| Label | Meaning | Inbox behavior |
|-------|---------|----------------|
| `@psd/Important` | Needs your attention | Moved out of Inbox into the label |
| `@psd/Later` | Legitimate but not urgent | Moved out of Inbox into the label |
| `@psd/News` | Newsletters, announcements | Moved out of Inbox into the label |

**Labels are folders.** Every classified message lives in exactly one place —
it is removed from Inbox when labeled. An empty Inbox means triage is caught
up, not that you have no mail. The "look at this now" signal is a **Chat
ping** (an escalation card in your agent DM), which is separate from the
label and independently tunable (see §5).

There is also a fourth label, `@psd/Task`, that **you** apply (the classifier
never does) to turn an email into a task — see §8.

How a decision gets made, in priority order:

1. **VIP sender** you configured → Important. Beats everything.
2. **Muted sender** you configured → Later (effectively auto-archive). Beats
   everything below, including rule 3.
3. **You previously replied in the thread** → Important.
4. **Your keyword rules**, first match wins.
5. Otherwise a small **AI classifier** decides, using the message body, your
   rules, and patterns learned from your past corrections. It only picks
   Important when it is confident (≥ 0.75); anything ambiguous goes to Later.

Knowing this order matters for tuning: **muting a sender is the only
user rule that overrides the "you replied in this thread" rule** (rule 2 beats
rule 3). Keyword rules cannot demote thread-reply mail (rule 4 runs after
rule 3).

---

## 2. Before you start

- You need a working DM with the PSD AI Agent in Google Chat (send it any
  message first — the DM is also where escalation pings and digest cards land).
- Your Google account must be connected to the agent (the standard workspace
  consent flow, including the Gmail scope). If it isn't, the agent will give
  you the consent link when you try to enable.

---

## 3. Getting started

Say to your agent:

> "Start triaging my email"

Confirm on the card it shows you. The agent then:

1. Creates the labels `@psd/Important`, `@psd/Later`, `@psd/News` in your Gmail.
2. Seeds a few sensible default rules (e.g. `noreply@*` muted, newsletters → News).
3. Schedules your daily digest (default 08:00, your timezone — see §7).
4. **Sweeps your existing inbox**: mail from the last 30 days still sitting in
   your Inbox (up to 1000 messages) is classified and filed through the same
   pipeline, with Chat pings suppressed so you don't get a notification storm.
   If your inbox is already clean, the sweep simply finds nothing.

New mail starts being classified on the next 5-minute cycle. If you were
enabled before the sweep feature existed and want your backlog filed, say
"run a triage sweep".

---

## 4. Day-to-day use

- **Work out of the labels, not the Inbox.** Check `@psd/Important` when you
  get pinged or on your own rhythm; batch `@psd/Later` and `@psd/News`.
- **A message the agent gets wrong? Correct it — it learns from you** (see §6).
  For mail wrongly buried in `@psd/Later`/`@psd/News`, just drag it back to
  Inbox in Gmail — that's recorded automatically. For mail wrongly marked
  Important, tell the agent ("that email from X should have been News") — it
  re-files the message and records the correction. Note that archiving an
  `@psd/Important` message does **not** register as a correction: Important
  mail is already out of the Inbox, so there's nothing for archive to do.
- Mail that a Gmail filter or you already labeled is **left alone** — triage
  never overrides an existing classification.
- Expect up to ~5 minutes of latency on everything (classification, pings,
  task gestures) — the system polls; it isn't push-based.

---

## 5. Getting fewer (or better) pings — escalation tuning

By default, in `all` mode, **every message classified Important pings your
Chat DM**. If that's too noisy, pick a stricter mode:

> "Set my triage escalation mode to high-confidence"

| Mode | What pings you |
|------|----------------|
| `all` (default) | Everything labeled Important — **unless** you've added escalation senders/keywords (below), in which case only those explicit matches ping |
| `high-confidence` | Any deterministic-rule Important (VIP, a thread you've replied in, your keyword rules), plus AI classifications at ≥ 0.85 confidence (threshold tunable: "set my escalation threshold to 0.9") |
| `rules-only` | Any deterministic-rule Important (VIP, a thread you've replied in, your keyword rules) — the AI alone never pings |
| `none` | Never ping. The label and daily digest are your only surfaces |

You can also target pings precisely:

- "Always page me when `superintendent@psd401.net` emails" (escalation sender)
- "Ping me when a message mentions 'board meeting'" (escalation keyword)
- "Show my escalation rules" / "remove that escalation rule"

These explicit escalation rules ping in **every** mode except `none` — they
mean "always tell me about this." In `all` mode they also act as a filter:
once you have any, only they ping.

Note the distinction: **escalation tuning changes what pings you; it does not
change what gets labeled Important.** To change the labels themselves, tune
the rules (§6).

---

## 6. Getting fewer things IN Important — rules and learning

This is the continuous-improvement loop. Three ways to tune, from most to
least explicit:

### a. See why, then set a rule

Ask: **"Show my recent triage classifications."** Each entry shows the label
and the *reason*:

| Reason shown | What it means | Fix if wrong |
|--------------|---------------|--------------|
| `vip:<sender>` | Your VIP list | "Remove <sender> from my VIPs" |
| `thread:user-replied-here` | You replied in that thread once | "Mute <sender>" — muting is the only rule that overrides this |
| `keyword:<rule>` | One of your keyword rules | "Remove my keyword rule for <x>" |
| An LLM reason + confidence | The AI's judgment | Correct it (b) or add a rule |

Then set rules in plain language:

- "Mute `noreply@vendor.com`" or "mute `*.vendor.com`" — wildcards work
- "Emails with 'weekly digest' in the subject go to News"
- "External emails from `pta.org` go to Later"
- "Add `principal@psd401.net` as a VIP"
- "Show my triage rules" / "remove the mute for X"

Not sure a rule will catch what you intend? Ask the agent to **simulate**:
"Would my rules catch an email from news@vendor.com with subject 'Special
offer'?" — it dry-runs the rule engine without waiting for real mail.

### b. Correct individual messages

Two signals, by direction:

- **Wrongly buried** (`@psd/Later`/`@psd/News` mail you wanted to see):
  drag it back to Inbox in Gmail — recorded automatically.
- **Wrongly Important**: tell the agent — "that email from X should have
  been News." It re-files the message in Gmail and records the correction.
  (Archiving an Important in Gmail is *not* a signal — it's already
  archived; only Inbox-direction moves are detected automatically.)

### c. Let the nightly learning loop propose rules

Every night the agent analyzes your corrections:

- Patterns feed the AI classifier automatically as soft hints — repeated
  corrections about a sender make the classifier lean the way you did, with
  recent corrections weighing more than old ones.
- When a pattern is strong (you've corrected the same sender/domain at least
  twice), the agent sends you a **suggestion card** in Chat — e.g. "You've
  archived 3 Important emails from X. Mute them?" Reply to apply or dismiss.
  **Nothing is ever auto-applied** — dismissed suggestions are remembered and
  not re-raised.

So the lazy-but-effective workflow is: flick wrongly-buried mail back to
Inbox, tell the agent about wrong Importants as you notice them, approve the
suggestion cards that follow, and add explicit mutes for anything
`training recent` shows repeatedly slipping through.

---

## 7. The daily digest

A once-a-day Chat card summarizing what was filed where. Control it in chat:

- "Set my digest time to 17:00"
- "Turn off my digest" / "turn my digest back on"

`none` escalation mode + the digest is a good combination if you want zero
interruptions but a daily overview.

---

## 8. Turning an email into a task — `@psd/Task`

Apply the `@psd/Task` label to any message in Gmail. Within ~5 minutes your
agent picks it up and creates a task in **your** task system, then archives
the email. Requirements:

- Ask the agent to turn the feature on: "enable task creation from email"
  (sets `tasks mode invoke-agent`; default is off).
- Tell your agent *how* you want tasks created (which system, what fields) —
  it follows the instructions in your agent memory. See the example memory
  entry in [the ops doc](../operations/email-triage.md#phase-15--psdtask-user-gesture-task-creation).
- Failures always surface as a Chat card; to retry, remove and re-add the
  label. For a success confirmation card too: "notify me when email tasks are
  created."

---

## 9. Pausing, stopping, renaming

- "Pause my email triage" — stops classifying; rules, labels, and history are
  kept. "Resume email triage" picks up where it left off.
- "Stop triaging and forget everything" — hard reset: deletes rules, learned
  patterns, history, the Gmail labels, and the digest schedule.
- "Rename my Important label to `@psd/Act`" — any of the three labels can be
  renamed; the system keeps working.

---

## 10. Quick reference — things to say to your agent

| You want | Say something like |
|----------|--------------------|
| Turn it on | "Start triaging my email" |
| Backfill existing inbox | "Run a triage sweep" |
| See what it's been doing | "Show my recent triage classifications" |
| Silence a sender forever | "Mute noreply@vendor.com" |
| Route a topic | "Emails about 'PD sign-up' go to Later" |
| Never miss a person | "Add the superintendent as a VIP" |
| Fewer pings, same labels | "Set my escalation mode to high-confidence" |
| Ping on a topic | "Page me when anything mentions 'levy'" |
| Fix one mistake | "That email from X should have been News" (or drag a buried message back to Inbox in Gmail) |
| Review pending suggestions | "Show my triage suggestions" |
| Daily summary timing | "Set my digest time to 7:30" |
| Email → task | Apply `@psd/Task` in Gmail (after "enable task creation from email") |
| Check status | "What's my triage status?" |
| Take a break | "Pause my email triage" |

---

## 11. FAQ

**Too much lands in Important.** Run "show my recent triage classifications"
and look at the reasons. `thread:user-replied-here` noise → mute those
senders (only mute overrides that rule). AI misjudgments → correct them and
approve the suggestion cards that follow; the ≥ 0.75 confidence bar plus your
learned patterns tightens it over time.

**Something I needed went to Later/News.** Drag it back to Inbox (that's a
recorded correction) and add the sender as a VIP or add a keyword rule if
it's a category.

**I get pinged too much.** That's escalation, not labeling — switch modes
(§5). `rules-only` means only what you explicitly listed ever pings.

**I'm not getting pinged at all.** Check "what's my triage status" — if your
escalation mode is `none` or your label triggers were narrowed, that's why.
Also confirm you've DM'd the agent at least once (pings need the DM channel).

**A message never got classified.** Mail already labeled by you or a Gmail
filter is intentionally skipped, as is anything not in the Inbox. Otherwise
remember the ~5-minute cycle.

**Does the agent read my email?** Classification uses sender, subject, and a
body excerpt, processed by a small model inside PSD's AWS environment. Rules
and decisions are stored per-user; other users and other users' agents see
nothing of yours. Admins can see your triage *configuration and decision log*
(not message bodies) on the admin support page.
