---
title: Real-time Yjs collab on Bun — Hocuspocus is incompatible; attach ws listeners synchronously
category: integration
tags:
  - yjs
  - y-websocket
  - hocuspocus
  - bun
  - websocket
  - crossws
  - collaboration
  - atrium
  - playwright
severity: high
date: 2026-06-26
source: manual — #1051 Atrium Phase 1 collab verification (Playwright)
applicable_to: project
---

## What Happened

Building Atrium's real-time collaborative editor (TipTap + Yjs), the first transport
choice — **Hocuspocus v4** — connected but never synced: `onConnect`/`onAuthenticate`
never fired even in a clean minimal harness, under both Bun and Node.

## Root Cause #1 — Hocuspocus v4 does not work under Bun

Hocuspocus v4's `Server` routes the websocket through **`crossws`**, whose Node
adapter throws on construction under Bun: `[crossws] Using Node.js adapter in an
incompatible environment`. Our dev server runs under Bun (`bun run server.ts`), so
the `Server` API is unusable there. The lower-level `new Hocuspocus().handleConnection(ws, req)`
path bypasses crossws but then never wires its message handler to a plain `ws`
socket (it expects its own transport), so no hook ever fires.

**Fix:** drop Hocuspocus; implement the y-websocket protocol directly with
`y-protocols/sync` + `y-protocols/awareness` + `lib0` over a raw `ws` server. It is
~150 lines, runtime-agnostic (Bun AND Node), and is the exact protocol TipTap's
`Collaboration` extension + y-websocket's `WebsocketProvider` already speak. The
verified pattern: per-doc `Y.Doc` + `Awareness`; on connect send SyncStep1; on
message route by type (0=sync via `readSyncMessage`, 1=awareness); on `ydoc.update`
broadcast `writeUpdate` to peers + publish to Redis + debounced persist.

## Root Cause #2 — early frames dropped during async connection setup

After the rewrite, browser editors synced but a raw client (the agent bridge) timed
out with only `syncType: 0` received. The server's `handleConnection` attached
`ws.on("message")` only AFTER `await verifyToken` + `await loadDocFromPostgres`. A
client sends its first **SyncStep1 immediately on open**, which arrived during those
awaits with no listener attached → dropped → the server never replied SyncStep2 →
the client never synced. (Browsers survived it via the provider's resync; a one-shot
raw client did not.)

**Fix:** attach the `message` listener **synchronously** at the top of the handler,
queue frames into a buffer, then replay them once the real handler is ready:

```ts
let process = null; const pending = [];
ws.on("message", (d) => { const u8 = new Uint8Array(d); process ? process(u8) : pending.push(u8); });
await verifyToken(); await loadDoc();           // async setup — frames buffer
process = (u8) => { /* real sync/awareness handling */ };
sendSyncStep1(ws); for (const u8 of pending) process(u8); pending.length = 0;
```

This same "attach listener before any await" rule applies to the custom-server side
too: in server.ts the collab `'connection'` handler must call the handler
synchronously (pre-import it), not `await import()` inside the handler.

## Other gotchas hit (all verified via Playwright on the live dev server)

- **WS path namespace:** Next dev intercepts websocket upgrades under `/api/<route>/*`
  namespaces that overlap real routes. The collab WS lives at a dedicated top-level
  `/api/atrium-collab` (NOT `/api/content/collab`, which collided with the
  `/api/content/[id]/*` routes and never reached the custom upgrade handler).
- **Agent bridge = client, not shared memory:** the bridge route (Next module graph)
  and the WS server (server.ts graph) are separate module instances with separate
  in-memory doc maps (separate bundles in prod). The bridge applies edits by
  connecting as a y-sync CLIENT (native `WebSocket`, not the `ws` package — which
  errors `Unexpected server response: 101` in the Next runtime; and not
  `WebsocketProvider`, which won't sync there), so the edit reaches the same doc the
  editors hold. Cross-ECS-task delivery still needs Redis.
