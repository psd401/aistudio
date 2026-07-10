---
title: y-websocket reconnect replays expired token; URL query-param tokens must not share session signing key
category: security
tags:
  - websocket
  - y-websocket
  - yjs
  - jwt
  - token-expiry
  - silent-failure
  - secrets-management
  - ecs
  - cdk
  - collab
  - atrium
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

Atrium collab tokens (short-TTL JWTs) were baked into the y-websocket `WebsocketProvider`
constructor as `?token=` query params. When the token expired the server closed the socket
with code 4401, but the client reconnect loop replayed the **same expired token** indefinitely
— edits were silently dropped with no user-visible error. Separately, those same tokens shared
the `AUTH_SECRET` NextAuth signing key, meaning the collab token appeared in ALB/proxy access
logs (URL query strings) while the session cookie it shared a key with is HttpOnly-only.

## Root Cause

Two separate issues:

1. **Reconnect loop**: y-websocket re-reads `provider.params` on every connect attempt, but
   only if you mutate it before reconnect. A comment claiming "clients re-mint by reconnecting"
   is not self-fulfilling — the provider simply replays `params` from the last constructor call
   unless you explicitly update it.

2. **Key reuse**: Collab JWTs travel in the URL (`?token=`). Load balancers and reverse
   proxies log full request URLs. Any key that signs a URL-borne token is implicitly logged
   alongside the token, defeating the value of having a separate secret.

## Solution

1. Listen for the `'disconnected'` status event on the provider. On that event, re-fetch a
   fresh token from the server and assign `provider.params = { token: freshToken }` before the
   provider's next reconnect tick. y-websocket v3 documents `params` as safely mutable and
   re-reads it each connect.

2. Introduce `COLLAB_JWT_SECRET` as a dedicated secret: added to AWS Secrets Manager, injected
   into ECS task definitions as a task secret (IAM `secretsmanager:GetSecretValue` grant added
   to the task role), and read in the signing path. `AUTH_SECRET` is retained as fallback only
   outside production.

## Prevention

- Never bake a short-TTL token into a WebSocket provider constructor and assume reconnects will
  refresh it — verify the library's reconnect behavior against its source or docs.
- Any token that rides in a URL query string must use a signing key that is **not** shared with
  HttpOnly cookie secrets. Treat URL params as logged.
- When adding a new JWT signing key: Secrets Manager secret + ECS task secret injection + IAM
  grant must all land in the same PR or the ECS task fails to start.
