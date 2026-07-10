# The Logbook

An agent skill that helps Peninsula keep watch on its own learning — across teams, across cycles, across the whole voyage.

Draft v2· Owner: the CIO· Build window: Summer 2026

The Logbook is an **agent skill** that anyone in the district can load into their personal AI agent. It reads the team Google Chat Spaces it has been given access to, synthesizes what is happening across teams, walks individual SHIP teams through their cycle, and generates the first draft of every cycle's brief. One skill, used many ways.

How it gets used The Logbook is not a separate product. It is a skill loaded into the personal agents of people who need it — the superintendent, the five chiefs, the CIO, and SHIP team members. Each person uses the skill for the role they are in: a chief uses it to see what is moving across their teams; a team member uses it to draft their next brief.

## § I  ·  The four jobs — What the Logbook does

Job 01Synthesize

#### Read across team Spaces, surface what is moving

The Logbook reads the weekly written check-ins from each SHIP team's Google Chat Space. It produces a weekly digest — themes, blockers, connections worth surfacing, and any team that has gone silent. Anyone with the skill loaded can ask for the digest at any cadence; chiefs typically schedule a weekly run.

Job 02Coach

#### Walk a team through the SHIP cycle

A team member can ask the Logbook to help them frame their Sense paragraph, write a strong Hypothesis, structure their Implement work, or shape their Publish. It knows the doctrine, the quarterly intent, the templates, and the past briefs published by other teams.

Job 03Draft

#### Generate first drafts of every cycle brief

At the end of a cycle, a team asks the Logbook to draft their brief — Adoption, Decommission, or Continuation. The Logbook pulls from the team's check-ins, the bet roster, and the team's own working notes, and returns a structured first draft. The team revises it before publication.

Job 04Flag

#### Surface accountability and conflict

The Logbook flags teams silent past 14 days, bets that appear to conflict, and hypotheses that may be failing earlier than the team expected. Flags surface in the weekly digest to the cabinet — shared accountability across the five chiefs and the superintendent, not concentrated in one office.

## § II  ·  Who loads the skill — The Logbook in personal agents

| Loader | Why they load it |
|----|----|
| The superintendent | Weekly cross-district synthesis, quarterly intent alignment, surfaced flags |
| The five chiefs | Weekly view of the teams in their department; shared accountability with the superintendent |
| the CIO | District-wide oversight; build and maintenance of the skill itself |
| SHIP team members | In-cycle coaching, brief drafting, looking up what other teams have learned |
| DILs & AI ART teachers (fall) | Same usage as cabinet teams when their builder cycles begin |

## § III  ·  Where teams work — The Google Chat Space

Every SHIP team operates in a dedicated **Google Chat Space** — Peninsula's district standard for team collaboration. That Space is the canonical home for all team activity: weekly written check-ins, shared notes, asks across teams, and any artifact the team is building. The Logbook reads from there. *If a piece of work isn't in the Space, it isn't visible to the Logbook.*

## § IV  ·  Scope — What the Logbook watches & never touches

#### Watches

- Each SHIP team's Google Chat Space (with permission)
- Weekly written check-ins — tried · learned · stuck · needs
- The current quarterly intent
- The bet roster (one row per active bet)
- The corpus of past briefs published on psd401.ai

#### Never touches

- Personnel matters — disciplinary, grievance, evaluative
- Active vendor negotiations, pricing, contract specifics
- Legal counsel communications
- Anything explicitly marked "out of band" by a team

The Logbook runs inside Peninsula's secured environment; data does not leave PSD infrastructure.

## § V  ·  A sample weekly dispatch — What the digest looks like

Logbook 0023 · Cycle 01 · Week 03 Mon · 21 Sep 2026

##### Themes

- Three teams (HR, Communications, Special Ed) are working on AI-assisted communication drafting. Two are converging on the same template — worth a quick alignment.
- "Time saved" is showing up as a metric across four teams. Cabinet should pick a single way to measure it before Cycle 02.

##### Connections to surface

- MatchTech team's draft of an IEP scheduling helper looks like the problem Special Ed described in Week 01. Suggest a 15-minute sync.
- MatchElementary Principal team and T&L are both exploring student feedback agents. Different angles — worth comparing notes.

##### Blockers

- StuckFinance team waiting on procurement clarity for a vendor tool.
- StuckHigh School Principal team is unsure whether their bet falls inside the current intent.

##### Accountability flags

- SilentOperations team — no check-in for 12 days. Lead has been nudged.

## § VI  ·  Shared accountability — How escalations flow

The cabinet operates as a shared accountability model. Escalations surface to the five chiefs and the superintendent together — no single person carries oversight alone.

| Situation | Surface to | How |
|----|----|----|
| Team flags hypothesis failing earlier than expected | Chiefs & superintendent | Next weekly digest · not interrupt |
| Team silent 14+ days | Team lead first | Direct nudge · then team's chief & superintendent at 21 days |
| Two teams' bets in conflict | Chiefs & superintendent | Next weekly digest |
| Out-of-scope content detected | the CIO | Omit from digest · do not store · flag |

## § VII  ·  What the Logbook knows — The knowledge base

The Logbook's skill is built on the knowledge base being developed in this collection. Specifically:

- The SHIP doctrine — what each phase requires, the doctrine stack, the kill-bet rule
- The current quarterly intent and the cabinet's most recent intent statements
- The brief templates — Adoption, Decommission, Continuation — and the patterns that distinguish them
- Every published brief on psd401.ai (the growing corpus)
- The Bet Brief and Weekly Check-In templates
- The plain-English doctrine primer for staff who want grounding

As the corpus grows, the Logbook gets sharper — that is the design.

## § VIII  ·  Build sequence — How we get there

the CIO builds the Logbook during Summer 2026 and pilots it against the Tech department before August. Chiefs review one round of digest output in July; the skill goes live in cabinet's personal agents before Cycle 01 kicks off. Teams pick up the skill themselves when they begin their first cycle.

Why this design matters An operating model that claims to absorb AI capability faster than other districts must itself be running on AI for its own coordination. The medium is the message. If the Logbook works, the model is credible. If the Logbook isn't there, the model is just another framework on a slide.
