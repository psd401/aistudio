# ECS injects HOSTNAME at runtime, silently overriding Dockerfile ENV — breaks Next.js standalone loopback

**Date:** 2026-07-11
**PR:** #1189
**Severity:** P1 — Nexus workspace chat could not read or edit live Atrium documents in any deployed environment; the agent-bridge loopback had been broken in ECS since #1051 shipped.

## What happened

The Next.js standalone server (`server.js`, wrapped by `voice-server.js`) binds to
`process.env.HOSTNAME || '0.0.0.0'`. Both Dockerfiles set `ENV HOSTNAME=0.0.0.0` —
the documented Next.js-in-Docker pattern. But at runtime the ECS/Docker layer
injects `HOSTNAME=<task hostname>` (e.g. `ip-10-0-1-86.ec2.internal`) into the
container environment, overriding the image ENV. The server then listened **only
on the eth0 interface**; nothing listened on `127.0.0.1`.

Every server-to-itself connection failed with `ECONNREFUSED`:
- the Atrium agent bridge collab websocket (`ws://127.0.0.1:$PORT/api/atrium-collab`)
  used by `applyAgentEdit` / `applyAgentComment` / `applyAgentSuggestion` /
  `readAgentDocMarkdown` → surfaced in chat as `collab websocket error`.

Browser traffic arrives via the ALB on eth0, so the collab editor panel connected
fine — the breakage was invisible except to the agent path.

## Why local verification missed it

Local dev servers (`server.ts`, `e2e-local.sh`) bind hostnames that include
loopback, so every local test — unit, Bun smoke, authed Playwright E2E driving
real LLM tool calls — passed honestly. The deployed topology (runtime-injected
`HOSTNAME`) is not reproducible by any test that doesn't run the production
standalone server with a clobbered `HOSTNAME`.

## Diagnostic signature

Boot log is conclusive and takes one look:

```
- Local:    http://ip-10-0-1-86.ec2.internal:3000   ← BROKEN (hostname-bound)
- Local:    http://localhost:3000                    ← healthy (0.0.0.0-bound)
```

When Next binds `0.0.0.0` the `Local:` line says `localhost`. If it shows a
hostname/IP, loopback is dead. (The `Network:` line shows the machine address in
BOTH cases — do not diagnose from it.)

## Fix

- `entrypoint.sh` exports `HOSTNAME=0.0.0.0` immediately before
  `exec su-exec nextjs "$@"` — the last point in the startup chain, wins over
  every injection layer.
- `voice-server.js` runs a boot-time loopback self-check: logs the bound address
  and TCP-probes `127.0.0.1:$PORT`; failure emits one CloudWatch ERROR naming the
  agent bridge as the casualty.

## Rules

1. **A Dockerfile `ENV HOSTNAME=...` is not authoritative** — ECS/Docker inject
   `HOSTNAME` at runtime. Force interface bindings in the entrypoint (or in code),
   never rely on image ENV for `HOSTNAME`.
2. **Any feature that dials the server from inside the server (loopback) must have
   a deployed-environment reachability check** — a boot-time self-check log line
   at minimum. Local E2E cannot cover deployed binding/topology.
3. **When a deployed WS/HTTP client fails while browsers work, read the boot
   log's `Local:` line first** — it distinguishes binding problems from handler,
   origin, or auth problems in seconds.
