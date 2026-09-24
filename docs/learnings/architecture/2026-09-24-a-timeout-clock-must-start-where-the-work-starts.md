---
title: A timeout clock must start where the work starts — every hop between "accepted" and "started" is a duplicate-write bug
category: architecture
tags: [timeout, queueing, idempotency, duplicate-writes, code-review]
severity: high
date: 2026-09-24
source: /lfg #1788
applicable_to: project
---

## What Happened

#1788 moved Atrium artifact queries off serialized Server Actions and added a
concurrency limit with a bounded queue. The sandbox frame already had a timeout
that started when the artifact *posted* a request. Introducing a queue meant
"posted" and "started" were no longer the same moment, so the fix added a
dispatch ack that restarts the frame's clock when the parent dispatches.

That ack was then found to be a lie **five separate times**, each by a different
review round, each one layer deeper:

1. **Queue wait exceeded the pre-ack budget.** The ack can only re-arm a request
   that is still pending. With 26 queued behind 6 concurrent, the tail expired
   un-dispatched — and was then dispatched anyway.
2. **Record ops kept a bare 10s pre-ack budget** while queries got the
   queue-tolerant one. A queued `submit` expired, then ran.
3. **Records were acked 6-at-a-time but ride serialized Server Actions**, so
   five of six acks fired while the request sat in Next's client-side action
   queue.
4. **The ack fired before the lazy `import()` of the action chunk**, so a slow
   chunk meant the clock was running before the transport existed.
5. **The failed-import path acked anyway**, and since the loader clears its memo
   on rejection, a second slow import started *behind* the now-running clock.

The same class appeared on the server too: the 30s budget was armed around the
connector work, so it covered neither the preflight nor (initially) the
handshake — and once armed at the top it still was not *observed* between
preflight stages, so abandoned requests kept doing background work.

Every single instance had the same consequence: **a `submit` commits after the
artifact has already been told it failed, so the author's retry creates a
duplicate record.**

## Root Cause

A timeout is a claim about *how long the work has been running*. Any hop between
"we accepted this" and "the work actually began" that the clock does not know
about makes the claim false. Those hops are easy to miss because each one is
individually invisible:

- an in-process queue you just added
- a *second* queue you did not add (the framework's — Server Actions serialize)
- a lazy module import
- a rejected import that a retry-friendly memo silently re-arms
- server-side preflight that runs before the deadline is armed
- an armed deadline that nothing checks between awaits

Fixing one moves the failure down a layer rather than removing it, which is why
this took five review rounds to converge.

## Solution

Two rules, applied at every layer:

1. **The clock starts when the work starts, and "starts" means the transport can
   actually begin.** The parent now awaits transport readiness *before* acking,
   runs record ops one-at-a-time (because their transport serializes anyway, so
   a wider limit only creates a hidden queue), and never acks a request whose
   transport failed to load — it answers instead.
2. **Whoever gives up first must be the one who can still stop the work.** The
   parent's queue deadline (300s) is deliberately *shorter* than the frame's
   (315s), so the parent always abandons a request before the frame does. The
   opposite ordering is precisely the bug: the frame gives up, deletes its
   pending entry, and the parent then dispatches a write nobody is waiting for.

On the server, one `AbortSignal.timeout` is armed at the top of the action,
threaded into the connector call, raced against the whole preflight, **and**
checked between preflight stages so an expired request cannot start the next
lookup.

## Prevention

- When adding a queue in front of timed work, ask: *what is the worst-case wait,
  and does the pre-dispatch budget outlast it?* Compute
  `ceil(queueDepth / concurrency) × worstCaseSlotDuration`.
- Apply the pre-dispatch budget to **every** operation the queue accepts, not
  just the one you were thinking about.
- Before trusting a "dispatched" signal, list everything between it and the
  first byte of real work: another queue, a dynamic import, a lazy connection, a
  retry that re-arms. Each is a place the clock is wrong.
- Make the layer that can still *cancel* the work give up first. Set its deadline
  strictly below the layer that merely stops *listening*.
- For a non-cancellable sequence, racing it bounds the caller but not the work —
  check the deadline between stages too, or abandoned requests keep consuming
  the resource that was already slow.
- Reconcile capacity between layers explicitly. Two layers both saying "32" do
  not agree when one counts open promises and the other counts queued items:
  derive one from the other (`queue = hostPending − concurrency`), or cap the
  total directly, which is correct for every lane by construction.
