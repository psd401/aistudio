-- Migration 189: let the PSD OpenClaw OAuth client request repository WRITE scopes.
--
-- Issue #1907. The MCP capability catalog gained `repositories.create` and
-- `repositories.add_item`, but the first-party OpenClaw client registered in
-- migration 139 allows only the four read scopes. oidc-provider validates every
-- requested scope against `allowed_scopes`, so without this row change the
-- agent-connect authorization request carrying the new scopes (see
-- `lib/oauth/openclaw-client.ts`, AISTUDIO_OPENCLAW_SCOPES) is rejected
-- outright and the user sees a generic consent failure.
--
-- Widening `allowed_scopes` grants nothing on its own: it only permits the
-- scopes to be REQUESTED. Every repository write is additionally gated server
-- side on the caller's live `knowledge-repositories` capability and, for
-- add_item, on owner-or-administrator rights over the target repository
-- (`canModifyUserManagedDurableRepository`). A student who connects the agent
-- still cannot create a repository.
--
-- Existing access tokens are unaffected: their scope snapshot is persisted and
-- re-validated per request, so an already-connected user re-runs `connect` to
-- pick the new scopes up. That is the documented remediation the skill's
-- insufficient-scope hint already prints.
--
-- The guard pins the current scope SET (containment in both directions), so an
-- administrator-modified client is never overwritten and a re-run after a
-- successful update is an intentional no-op. Set containment rather than
-- `allowed_scopes = '[...]'::jsonb`: jsonb equality on ARRAYS is order-
-- sensitive (unlike object keys, which are normalized), so any process that
-- ever rewrote the column with the same nine scopes in a different order would
-- make an equality guard match zero rows — silently, with no error, leaving the
-- app requesting scopes the client does not allow.
--
-- Rollback:
-- UPDATE oauth_clients
-- SET allowed_scopes = '["openid", "profile", "email", "offline_access", "platform:read", "repositories:list", "repositories:read", "repositories:search", "repositories:changes"]'::jsonb,
--     updated_at = NOW()
-- WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126';

UPDATE oauth_clients
SET
  allowed_scopes = '[
    "openid",
    "profile",
    "email",
    "offline_access",
    "platform:read",
    "repositories:list",
    "repositories:read",
    "repositories:search",
    "repositories:changes",
    "repositories:write",
    "repositories:create"
  ]'::jsonb,
  updated_at = NOW()
WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126'
  AND is_first_party = true
  AND allowed_scopes @> '[
    "openid",
    "profile",
    "email",
    "offline_access",
    "platform:read",
    "repositories:list",
    "repositories:read",
    "repositories:search",
    "repositories:changes"
  ]'::jsonb
  AND '[
    "openid",
    "profile",
    "email",
    "offline_access",
    "platform:read",
    "repositories:list",
    "repositories:read",
    "repositories:search",
    "repositories:changes"
  ]'::jsonb @> allowed_scopes;
