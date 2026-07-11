# Agent Canva Integration (`psd-canva`)

Per-user Canva access for AI Studio agents via the Canva Connect REST API
(issue #1176, PR #1178). Mirrors the Google Workspace integration
([agent-workspace-integration.md](agent-workspace-integration.md)): a
confidential OAuth client owned by the deploying district, per-user refresh
tokens in Secrets Manager, chat → browser one-time consent.

**Everything below the "Deployment checklist" is already wired in code.** A new
district needs exactly two external inputs — their own Canva integration's
`client_id`/`client_secret` — the same way they need their own
`GoogleClientId`. No code changes, no per-user administration.

## Components

| Piece | Location | Purpose |
|---|---|---|
| Skill | `infra/agent-image/skills/psd-canva/` | `whoami` / `list-designs` / `create-design` / `export` / `upload-asset` against `api.canva.com/rest` |
| Consent pages | `app/agent-connect-canva/` (+ `/callback`) | Session-less, token-authenticated consent + OAuth callback (public in `middleware.ts`) |
| Server actions | `actions/agent-canva.actions.ts` | PKCE S256 authorize-URL mint + confidential (Basic-auth) code exchange |
| Secrets | `psd-agent/{env}/canva-oauth-client`, `psd-agent-creds/{env}/user/{email}/canva` | District OAuth client; per-user refresh tokens (created lazily on first consent) |
| Migration | `infra/database/schema/101-agent-workspace-canva.sql` | Adds `'canva'` consent-nonce kind |

## User flow (self-serve, per user)

1. User asks the agent anything Canva-related.
2. Skill finds no stored token → emits `needs-auth` (exit 10) with a signed
   one-time consent link; the agent pastes it into chat.
3. User clicks → consent page → Canva authorize → callback stores the refresh
   token in their per-user secret. Done — subsequent requests just work.

Canva refresh tokens are **single-use with rotation**; the skill persists the
rotated token on every refresh and treats a failed write-back as non-fatal
(next call self-heals to `needs-auth`).

## Deployment checklist (one-time per district / environment)

1. **Canva Developer Portal** (one-time): create an integration at
   <https://www.canva.com/developers/> under an account in your Canva team.
   - Add redirect URL: `https://<your-app-domain>/agent-connect-canva/callback`
     (one per environment, e.g. dev and prod domains).
   - Enable scopes: `design:content:read design:meta:read design:content:write
     asset:read asset:write folder:read profile:read`.
   - Generate a client secret (shown once — capture it).
   - Note: Canva gates some integration types by plan (private integrations
     have historically required Enterprise; the Autofill/Brand-template APIs
     require Enterprise regardless and are deliberately **not** used by this
     skill). Canva for Education districts: verify integration creation in the
     portal before rollout.
2. **Populate Secrets Manager** (the deploy creates the shell secret empty;
   the consent flow fails closed with "not configured" until this runs):
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id psd-agent/<env>/canva-oauth-client \
     --secret-string '{"client_id":"...","client_secret":"..."}'
   ```
3. Deploy infra (AgentPlatformStack for the secret + FrontendStack for the
   consent pages; migration 101 applies automatically) and build/push the
   agent image (`infra/agent-image/build-and-push.sh`) so the skill reaches
   AgentCore.
4. Verify: ask the agent to connect to Canva → complete consent → ask it to
   run `whoami`.

## Runtime error contract

| Exit | Status | Meaning |
|---|---|---|
| 10 | `needs-auth` | No token / grant revoked — payload carries `consent_url` |
| 12 | `canva-error` | Canva API failure (or unconfigured client) |
| 14 | `rate-limited` | 429s exhausted after `Retry-After`-aware backoff |

## Known limits (by design)

- **No autofill / brand templates** — Enterprise-gated APIs.
- **No editing an existing design's contents** — Canva's Design Editing API is
  Apps SDK-only (in-editor); the Connect REST API has no content-edit
  endpoints. Closest: `create-design --asset-id`, export/import.
- Pro-gated export options (`transparent_background`, pro quality) are not
  requested; exports are plain renders.
