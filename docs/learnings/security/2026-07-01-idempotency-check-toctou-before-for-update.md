---
title: An idempotency short-circuit read BEFORE FOR UPDATE can bypass a security gate (TOCTOU)
category: security
tags:
  - TOCTOU
  - FOR-UPDATE
  - authorization-gate
  - idempotency
  - race-condition
  - drizzle
  - atrium
severity: high
date: 2026-07-01
source: auto — /lfg #1090 (PR #1091 review)
applicable_to: project
---

## What Happened

Issue #1090 asked to stop the Atrium §26.4 public-publish gate from firing on
idempotent no-op saves (re-saving already-public content spuriously required
approval). The first fix gated on an *actual state change*:
`input.visibility?.level === "public" && currentLevel !== "public"`. But
`currentLevel` was read **before** the transaction acquired its `FOR UPDATE`
lock (a pre-transaction `loadPublishable` / a standalone `currentVisibilityLevel`
SELECT).

Three independent PR reviewers (chatgpt-codex P2 ×2, Copilot ×3) converged on the
same hole: between that pre-read and the locked write, a concurrent request can
**narrow** the object (public → internal). Then the "already public → no-op"
branch is evaluated against a stale `public`, the gate is skipped, and
`setLevelInTx` widens the row back to `public` — an unauthorized caller reaching
`public` with **no `ApprovalRequiredError`, no approval event, no review**. A
`currentVisibilityLevel()` returning `null` on a concurrent delete had a related
bug: it was treated as "not public" → `ApprovalRequiredError` instead of the 404
the transaction's `FOR UPDATE` guard would raise.

## The Rule

When a security/authorization decision depends on a mutable row value AND the
same request then writes that row, **make the decision inside the transaction,
reading the value from the `FOR UPDATE`-locked row** — never from a pre-lock read.
A read taken before the lock is a classic TOCTOU: the state can change between the
check and the write, and an idempotency "skip the gate when nothing changes"
optimization is exactly the shape that turns a stale read into a gate bypass.

## The Fix

- `publishService.publish`: split the gate. The `public_web`-destination branch is
  level-**independent**, so it stays pre-transaction (and must precede the
  adapter-not-implemented check so an unauthorized caller still gets the approval
  signal). The visibility-**widen** branch (level-dependent) moved *inside* the
  transaction, reading `locked[0].visibilityLevel` under the `FOR UPDATE` lock.
- `visibilityService.setLevel`: the whole gate moved inside the existing
  `executeTransaction`, reading the current level from the same locked row that
  guards the write. This also fixed the null-on-delete case (the lock lookup 404s
  first, so the gate never sees a null level).
- Throwing `ApprovalRequiredError` inside the tx rolls it back → nothing is
  widened/published. The best-effort `void contentEvents.emit(...)` is safe to
  call right before the throw, even inside the tx, because `emit` swallows its own
  errors and never rejects (`snsPublishBestEffort`).

## Testing Note

Moving the gate into the transaction changed what the mocked-DB unit tests must
seed: a *rejected* widen now OPENS a transaction (reads the locked row, then
throws), so the test must seed the `FOR UPDATE` lock lookup with a **non-public**
locked row for the gate to fire — and assert on the thrown error + emitted event,
not on `executeTransactionCalls === 0`. Add an explicit "no-op re-save of
already-public content passes without approval" case (seed a **public** locked
row) to lock in the idempotency behavior against the locked level.
