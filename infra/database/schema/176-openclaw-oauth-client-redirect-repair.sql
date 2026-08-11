-- Migration 176: Repair the PSD OpenClaw OAuth client registration.
--
-- Two problems in one row, both user-visible as a generic `invalid_client`:
--
-- 1. The client carries a dev-only `http://localhost:3000/...` redirect URI.
--    Its application_type is `native`, and lib/oauth/redirect-uri-policy.ts
--    rejects an HTTP redirect whose host is not a literal loopback address —
--    LOOPBACK_HOSTS is {"127.0.0.1", "[::1]"}, and `localhost` is not in it
--    (RFC 8252 section 7.3). Redirect validation in DrizzleOidcAdapter is
--    all-or-nothing, so that single entry made loadClient() return undefined
--    and oidc-provider answer `invalid_client`. The two correct production
--    URIs never got a chance, and agent-connect was broken for EVERY user, not
--    just the one who reported it (prod errors 2026-08-10 19:35:28, 19:36:25,
--    19:39:43 UTC).
--
-- 2. is_active was set to false on 2026-08-10 23:18 UTC. The admin UI exposes
--    only create/list/revoke — there is no way to edit a redirect URI — so
--    revoking was the only control available for a client that plainly needed
--    changing. This migration reverses that, and the accompanying change adds
--    the missing update path so the next fix does not need a deploy.
--
-- Verified before writing this: the client had 0 refresh tokens, 0 access
-- tokens and 0 authorization codes, so nothing was ever issued against it and
-- reactivating grants nothing retroactively.
--
-- The guard pins the exact current redirect array and the public-PKCE native
-- profile, so an administrator-modified or unrelated client is never
-- overwritten. Re-running after a successful update is an intentional no-op,
-- and the migration is a no-op in any environment whose row already differs.
--
-- Rollback:
-- UPDATE oauth_clients
-- SET
--   redirect_uris = '["http://localhost:3000/agent-connect-aistudio/callback", "https://dev.aistudio.psd401.ai/agent-connect-aistudio/callback", "https://aistudio.psd401.ai/agent-connect-aistudio/callback"]'::jsonb,
--   is_active = false,
--   updated_at = NOW()
-- WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126';

UPDATE oauth_clients
SET
  redirect_uris = '["http://127.0.0.1:3000/agent-connect-aistudio/callback", "https://dev.aistudio.psd401.ai/agent-connect-aistudio/callback", "https://aistudio.psd401.ai/agent-connect-aistudio/callback"]'::jsonb,
  is_active = true,
  updated_at = NOW()
WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126'
  AND application_type = 'native'
  AND token_endpoint_auth_method = 'none'
  AND client_secret_hash IS NULL
  AND require_pkce = true
  AND is_first_party = true
  AND redirect_uris = '["http://localhost:3000/agent-connect-aistudio/callback", "https://dev.aistudio.psd401.ai/agent-connect-aistudio/callback", "https://aistudio.psd401.ai/agent-connect-aistudio/callback"]'::jsonb;
