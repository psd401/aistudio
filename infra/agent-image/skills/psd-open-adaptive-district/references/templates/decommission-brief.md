# Decommission Brief

For a bet that didn't work — and the team is honest about it.

Template· One of three: Adoption · Decommission · Continuation· Drafted by The Logbook

A **Decommission Brief** is what a team publishes when a six-week bet did not work and the team is stopping. *This is a feature, not a failure.* Education culture punishes public failure; the Open Adaptive District treats public decommissioning as evidence that the system is honest. Bets that quietly disappear are the failure mode — not bets that are openly killed.

## § I  ·  Shared backbone — Six fields, one of three patterns

The Decommission Brief follows the same six-field backbone as Adoption and Continuation Briefs. What changes is the Decision (stop, not scale) and the "What others should know" field (which becomes "What others should not repeat").

1.  **Header strip** — Decommission Brief · ID · cycle · team
2.  **Hypothesis** — what the team said they'd try, and what they expected
3.  **What we did** — the actual moves, with dates and surprises
4.  **What we learned** — including, especially, what didn't work and why
5.  **Decision** — "Decommission" + the reasoning
6.  **What others should not repeat** — the warnings, the conditions, the salvageable parts

## § II  ·  A worked example — What a published Decommission Brief looks like

Decommission Brief Logbook 0011 · Cycle 01 · 14 Oct 2026

### Auto-categorizing help desk tickets with an LLM classifier

Team · Tech Department

#### Hypothesis

If we route incoming help desk tickets through an LLM classifier that tags by category and urgency, we expect to cut average time-to-first-response by 30%. Success means classification accuracy above 90% and first-response time reduction across at least 200 tickets.

#### What we did

In Week 01 we built a classifier prompt against the categorical schema our help desk already uses. We tested against 50 historical tickets — accuracy was 78%. We adjusted the prompt twice and re-tested in Week 02 — accuracy rose to 84%. In Week 03 we shadow-deployed the classifier alongside human triage on incoming tickets for two weeks. In Week 05 we compared.

Surprise: the classifier was 91% accurate on tickets it could handle, but it flagged 22% of tickets as "uncategorizable" — far more than the human baseline (4%).

#### What we learned

- The classifier worked on the easy tickets — the same ones humans clear in seconds. It did not help with the long-tail tickets that drive most of our response delay.
- The "uncategorizable" rate exposed a real schema problem: our existing categories are insufficient for ~20% of incoming work. The classifier surfaced it; the schema did not catch up.
- Time-to-first-response did not move meaningfully — net 4% improvement, well below target.
- The classifier itself was technically fine. The problem was upstream of it.

Decision

Decommission the classifier as deployed

We are stopping the classifier work as scoped. The real bet — fix the upstream category schema before re-introducing classification — moves to Cycle 02 as a different bet, owned by the same team. The classifier prompt is preserved in our internal library in case it becomes useful again later.

#### What others should not repeat

- Don't deploy an LLM classifier against a category schema you haven't audited. Audit first; deploy second.
- Time-to-first-response is dominated by long-tail tickets, not the easy ones. Optimizing the easy ones moves the average barely.
- Watch the "uncategorizable" rate carefully. A high rate is data — usually about your taxonomy, not your model.
- What we'd salvage: the prompt and the shadow-deployment pattern are reusable. The schema dependency was the killer.

## § III  ·  The discipline of decommissioning — What makes this brief honest

**Name the surprise.** Every cycle reveals something the team did not expect at the start. The Decommission Brief is the place to put it. Hide nothing — the field benefits from seeing what surprised you.

**Separate the bet from the team.** The bet failed. The team did not. Education culture conflates the two; the Open Adaptive District does not.

**Identify what is salvageable.** Most failed bets contain reusable parts — a prompt, a workflow, a data structure, a pattern. Name them. Someone else will want them.

**Distinguish what is being decommissioned.** The bet, as scoped, is being stopped. That is not the same as abandoning the underlying problem. If the problem still matters, say so — and where it goes next.

## § IV  ·  How the Logbook helps — From a hard week to a publishable brief

Decommission Briefs are the hardest to write — they require admitting publicly that a bet did not work. The Logbook drafts them from the team's Google Chat Space record of the cycle. The Logbook's drafting tone is factual, not defensive; it pulls in the team's check-in language about what was surprising and what did not work. The team revises and approves before publication.

Why the field needs these The corpus of Decommission Briefs is, in many ways, the more useful one. Adoption Briefs tell other districts what to try. Decommission Briefs tell them what not to repeat — and why. That second corpus is rarer in education, which is why we are committing to build it.
