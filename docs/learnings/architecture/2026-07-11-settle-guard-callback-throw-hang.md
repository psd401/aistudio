---
title: A settle-guard that flips its `done` flag before calling a throwing callback deadlocks the promise
category: architecture
tags:
  - promises
  - websocket
  - collab
  - atrium
  - error-handling
severity: high
date: 2026-07-11
source: auto — /lfg (PR #1186, §1087)
applicable_to: project
---

## What Happened

`withHydratedDoc` (the read-only Atrium collab loopback) wrapped its single-settle
logic in a `finish(fn)` helper:

```ts
const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
// ...
if (syncType === SYNC_STEP_2) finish(() => resolve(read(ydoc))); // read() may THROW
```

`read(ydoc)` (`yDocToProseMirrorJSON`) was called INSIDE `finish`, i.e. AFTER `finish`
had already set `done = true` and cleared the timeout. When `read` threw, the throw
propagated to the message-listener's outer `catch`, which called `finish(() => reject(...))`
— but `done` was already `true`, so that call was a no-op. The promise never settled:
`readAgentDocMarkdown` hung forever, the `SYNC_TIMEOUT_MS` rescue timer was already
cleared, and the `finally { ws.close() }` never ran (socket leak). Net effect: the read
tool hung the whole chat turn instead of falling back to the persisted projection — the
exact fallback guarantee the code existed to provide.

## Root Cause

A one-shot settle guard must treat "flip the guard bit" and "run the user callback" as
separable: if the guard flips FIRST and the callback can throw, the throw escapes with the
guard already latched, so no later handler can settle the promise. The pre-existing WRITE
path (`runLoopbackEdit`) avoided this because its `reject(...)` calls are unconditional and
it sets its `applied` flag only AFTER the mutating call succeeds.

## Solution

Compute the possibly-throwing value BEFORE flipping the guard, so a throw settles via the
still-armed reject:

```ts
if (syncType === SYNC_STEP_2) {
  let value;
  try { value = read(ydoc); }
  catch (e) { finish(() => reject(e instanceof Error ? e : new Error(String(e)))); return; }
  finish(() => resolve(value)); // finish's fn now never throws
}
```

## Prevention

- Keep a single-settle guard's callback throw-free: do the work (that can throw) outside the
  guard, then call the guard with a pure resolve/reject.
- Any promise wrapper with a `done`/`settled` flag: verify that EVERY escape path (timeout,
  error, close, AND a throwing success callback) can still settle it. Add a test where the
  success callback throws — a hang there is silent (no error surfaces) and only shows up as a
  stuck request.
- Related §1087 fact: `atrium_doc_state.markdown` is written ONLY on seed and never
  re-derived from later edits, so reading it returns seed-era text. To read a live Atrium
  document's current text, hydrate the Yjs doc over a read-only (`w:false`) collab client and
  serialize it — do not trust the projection except as a fallback.
