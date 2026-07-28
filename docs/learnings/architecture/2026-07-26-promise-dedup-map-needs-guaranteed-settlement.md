---
title: A promise-dedup/coalescing map needs a guaranteed-settlement path, or fail-closed becomes hang-forever
category: architecture
tags:
  - promises
  - cognito
  - fetch
  - timeout
  - concurrency
  - fail-closed
  - nextauth
applicable_to: project
severity: high
date: 2026-07-26
source: auto — /lfg (PR #1350, issue #1297)
---

## What Happened

`lib/auth/cognito-refresh.ts` coalesces concurrent token-refresh calls for the
same session into one in-flight `Promise` via `activeRefreshPromises` (a
`Map<dedupKey, Promise<RefreshResult>>`), removing the entry in a `finally`
once the promise settles. The first implementation called plain `fetch()` with
no timeout. If that `fetch` never settles (hung TCP connection, dropped
response), the map entry never clears, and every subsequent refresh attempt
for that session — and any other session sharing the key — joins the same dead
promise and hangs forever instead of the module's documented "never throws,
fails closed" contract.

## Root Cause

A dedup map's correctness depends entirely on every stored promise eventually
settling. `fetch()` alone provides no such guarantee — network stacks can wedge
a request indefinitely with no error and no completion. The map's `finally`
cleanup is necessary but not sufficient; it only runs if the promise settles at
all.

## Solution

Wrap the underlying operation in a helper that is *itself* guaranteed to
settle within a bound, independent of what the underlying I/O does:

```ts
async function fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(endpoint, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
  }
  // Feature-detection fallback for runtimes without AbortSignal.timeout:
  // race the real request against a timer that always settles, and swallow
  // the loser to avoid an unhandled rejection when the timer wins.
  const request = fetch(endpoint, init)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), REFRESH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    request.catch(() => {})
  }
}
```

Also keep an overflow valve on the map itself (`if (map.size > MAX) map.clear()`)
as a second line of defense in case a settlement path is ever missed by a
future edit — belt-and-suspenders, not a substitute for the guarantee above.

## Prevention

- Any in-flight promise dedup/coalescing map: verify the wrapped operation is
  *itself* guaranteed to settle within a bound (via `AbortSignal.timeout`,
  `Promise.race` against a timer, or an equivalent), not just that the map has
  a `finally` cleanup. The cleanup only helps if the promise it's attached to
  ever fires.
- Prefer `AbortSignal.timeout(ms)` where available; feature-detect a
  `Promise.race` fallback for older runtimes, and swallow the losing promise's
  eventual rejection so it doesn't surface as unhandled.
- Keep a size-based overflow valve on long-lived dedup maps as defense in
  depth — it should never trigger if settlement is correctly guaranteed, but
  it bounds the blast radius if it is not.
- Related but distinct from [[settle-guard-callback-throw-hang]] (a *settled*
  promise's guard flag flipping before a throwing callback) — this is about
  guaranteeing the promise settles in the first place.
