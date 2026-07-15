---
title: Making a scheduled directory sync an authorization source — email join keys, last-known-good fail-safety, and success-absence staleness
category: architecture
tags:
  - authorization
  - group-sync
  - google-directory
  - cloudwatch
  - database
  - migrations
  - fail-safe
severity: high
date: 2026-07-14
source: auto — /lfg (#1207, Epic #1202 Phase 4)
applicable_to: project
---

## What Happened

Epic #1202 turned Google Workspace group membership into an authorization source:
an hourly service-account sync mirrors group membership into `group_members`
(keyed by **email**), and that membership drives a user's roles and per-resource
`resource_access_grants`. Phase 4 (#1207) hardened it. Four decisions are worth
remembering because the "obvious" alternative is wrong for an **authz** source
specifically:

1. **Email became a join key with no uniqueness constraint.** Every reconciler
   joins `lower(users.email) = lower(group_members.member_email)`, but `users.email`
   had no unique index. Two rows sharing a case-insensitive email would each match
   the same membership and could be granted/revoked inconsistently.

2. **A migration that adds `UNIQUE (lower(email))` can silently no-op or silently
   narrow.** In this repo's migration runners, a `duplicate key`/`already exists`
   error is swallowed for idempotency — so a naive attempt to dedge duplicates with a
   *partial* index would hide the ambiguity, and any error message that happens to
   match the swallow list would mark a failed index as "applied".

3. **Staleness of a scheduled job cannot be measured by the job itself.** The
   instinct is to emit a "seconds since last successful sync" gauge. But a Lambda
   that has stopped running (disabled schedule, throttle, broken deploy) emits
   *nothing*, so that gauge never reports the very failure you care about.

4. **Dropping the legacy `ai_models.allowed_roles` column looked risky** (it gates
   model access) but was safe because all *read* paths had already moved to
   `resource_access_grants` in Phase 3 — several places still `SELECT`ed the column
   into a typed field but never used it for a decision (dead carries), and the model
   list is filtered server-side, making the client-side role filter redundant.

## Root Cause / Principle

An authorization source has an asymmetric failure cost: **under-granting** briefly
is an annoyance; **over-granting**, **mass-revoking**, or **going stale unnoticed**
is a security or availability incident. That asymmetry dictates the design:

- **The join key must be single-valued.** Add `CREATE UNIQUE INDEX ... ON
  users (lower(email))`. NULLs are fine (distinct in a unique index) — no partial
  `WHERE` needed. Make it **fail loud** on pre-existing duplicates rather than
  dodging them: a plain `CREATE UNIQUE INDEX` raises `could not create unique
  index ... is duplicated`, which does **not** match the runner's
  `already exists`/`duplicate key` swallow list, so the deploy fails and forces
  human dedupe. Ship a read-only pre-check script + a documented dedupe runbook, not
  a partial index.

- **Never mass-revoke on a degraded upstream.** Skip deactivation when the directory
  listing is empty (an empty list is almost always an API glitch, not a real
  de-selection); on a per-group fetch failure, keep that group's last-known-good
  membership (`markError`, don't `replaceMembers`); paginate exhaustively so nothing
  is silently capped.

- **Detect staleness by the ABSENCE of success, from outside the job.** Emit a
  `SyncRunSucceeded` = 1 metric on success (0 on failure) and alarm on
  `sum(SyncRunSucceeded) < 1` over N periods with
  `treatMissingData: BREACHING`. That single alarm catches "ran but failed" **and**
  "did not run at all". Pair it with an alarm on the Lambda's built-in `Errors`
  metric for the "ran and errored" case (the handler re-throws so `Errors` counts
  both crashes and handled-then-rethrown failures).

- **Retire a legacy authz column only after confirming reads moved, and grep for
  dead carries.** `grep` both the snake_case (SQL) and camelCase (TS) spellings.
  A field that is `SELECT`ed and typed but never read for a decision is safe to
  remove; a server-side gate makes a client-side filter redundant (remove it, don't
  leave two enforcement points that can drift). Strip the removed field defensively
  on the write path (`delete updates.x`) so an older client echoing it can't reach a
  dropped column via a `.set({ ...updates })` spread.

## Also

- Lowercase **both** sides of every email comparison even when storage is lowercased
  by convention — no DB constraint enforces the convention, so the auth decision must
  not trust it.
- A last-administrator lockout guard that exists in two reconcile paths (hourly bulk +
  login-time per-user) needs a **shared** Postgres advisory lock, or the two paths can
  each read the other's uncommitted admin row as "surviving" and both revoke.
- A default-role heuristic (`isNumeric ? student : staff`) is a legacy fallback once
  group-sync is authoritative; retiring it to a no-role default is **coverage-gated** —
  produce a report of users whose manual roles group-sync would *not* reproduce, and
  centralize the heuristic to one helper so the eventual reduction is a single edit.

## See also

- Feature doc + runbooks: `docs/features/google-group-sync.md`
- `docs/learnings/security/2026-07-01-idempotency-check-toctou-before-for-update.md`
