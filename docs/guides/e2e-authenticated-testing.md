# Authenticated E2E Testing (Playwright)

How to run AI Studio's Playwright suite, including the **authenticated functional
tests** that drive the real UI as a logged-in user. This setup is committed and
reproducible (previously the harness lived only in tribal knowledge).

## Test tiers

| Tier | Specs | Auth | Runs in CI |
|------|-------|------|-----------|
| **Guard** | `capability-api-guards`, `capability-layout-guards` | none (unauthenticated) | ✅ always |
| **Functional** | `capability-functional`, `nexus/*`, `admin-*`, … | minted session | ⏭️ gated by `PLAYWRIGHT_AUTH_ENABLED` |

- **Guard specs** assert access control only: `{ request }` fixture → `401`, and
  `clearCookies()` + navigation → redirect. No server secrets needed.
- **Functional specs** mint a NextAuth session cookie and drive the UI. They
  skip unless `PLAYWRIGHT_AUTH_ENABLED=true`.

## Config

`playwright.config.ts` (repo root) sets `testDir: tests/e2e` and resolves
`baseURL` from `PLAYWRIGHT_BASE_URL` (falling back to `http://localhost:3000`).

## Running the guard tier (no auth)

```bash
# against the running dev app (Docker :3000)
PLAYWRIGHT_BASE_URL=http://localhost:3000 bunx playwright test \
  tests/e2e/capability-api-guards.spec.ts tests/e2e/capability-layout-guards.spec.ts
```

## Running the functional tier (authenticated)

Authenticated tests mint a session cookie with `AUTH_SECRET` and inject it via
`page.context().addCookies()` (see `tests/e2e/helpers/session-auth.ts`). The cookie
is only valid against a server whose `AUTH_SECRET` **matches** the one used to
mint it.

> ⚠️ The Docker `:3000` container is a **prod-built image** and will not accept a
> host-minted cookie reliably. Run a **host dev server** on a separate port whose
> `node_modules`/`.env.local` match your mint script.

### 1. Apply DB migrations to the local container

The app code expects the current schema. If the local DB is behind, pages break
(e.g. navigation needs `navigation_items.capability_id` from migration 084):

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
  bun run scripts/db/run-migrations.ts        # non-destructive; tracked in migration_log
bun run db:seed                               # seeds test@example.com (admin)
```

### 2. Start a host dev server on :3100

The Docker app owns `:3000`; run the host server on `:3100` (its `.next`/
`node_modules` are isolated from the container's anonymous volumes):

```bash
PORT=3100 DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' \
  DB_SSL=false bun run server.ts
```

### 3. Run the functional specs

```bash
set -a && source .env.local && set +a          # exports AUTH_SECRET for the mint
PLAYWRIGHT_AUTH_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3100 \
  bunx playwright test tests/e2e/capability-functional.spec.ts
```

## The auth helper

`tests/e2e/helpers/session-auth.ts` exports:

- `mintSessionToken(email?)` — `encode()` a NextAuth (Auth.js v5) JWT with salt
  `authjs.session-token`. `email` defaults to the seeded admin `test@example.com`
  (resolved by email fallback when `cognito_sub` doesn't match).
- `authenticateContext(context, email?)` — inject that token as the
  `authjs.session-token` cookie.

Two non-obvious requirements (both encoded in the helper):

1. **`tokenLifetimeMs` must be set** to a full lifetime. `auth.ts`'s
   `shouldRefreshToken()` proactively refreshes when < 25% of lifetime remains;
   a token without it (or near expiry) triggers a refresh against Cognito with a
   fake refresh token → `null` session → `401`.
2. **Use `addCookies`, not a raw `fetch` `Cookie:` header.** The browser context
   delivers the JWE cookie to `@auth/core`'s session store; a hand-built header
   does not round-trip reliably.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` on every authed request | server `AUTH_SECRET` ≠ mint secret | run the host `:3100` server with `.env.local` |
| `401` despite matching secret | token missing `tokenLifetimeMs` / near expiry | use `mintSessionToken()` (sets a 12h lifetime) |
| Empty navigation / page errors | local DB behind on migrations | run `scripts/db/run-migrations.ts` (step 1) |
| `/api/auth/session` → `200 null` | cookie not reaching server | use `authenticateContext()` (addCookies), not raw fetch |
