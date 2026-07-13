-- Migration 108: psd-aistudio agent MCP service user
-- Part of the zero-touch provisioning for the psd-aistudio agent MCP credential
-- (Issue #1100). The psd-aistudio OpenClaw skill is discovery-only: it POSTs the
-- `describe_capabilities` meta-tool to `/api/mcp` with a `platform:read`-scoped
-- `sk-` key so the agent always knows what AI Studio can do. That key was never
-- provisioned (the AgentPlatformStack wired AISTUDIO_MCP_URL but no
-- AISTUDIO_MCP_API_KEY_SECRET_ID), so the skill's resolveApiKey() exited 11.
-- This migration seeds the SERVICE USER that owns the auto-minted key; the KEY
-- itself is minted at deploy time by the aistudio-mcp-key-bootstrap custom
-- resource (KEY_PROFILE=mcp — a random secret cannot live in a committed
-- migration), which resolves this user by its cognito_sub sentinel.
--
-- Why a SEPARATE service user (not migration 104's psd-atrium-agent): the
-- bootstrap's replaceActiveKey revokes EVERY active key the service user owns
-- before inserting the new one (so exactly one active service key exists). If the
-- MCP key and the atrium content key shared a service user, the two bootstrap
-- custom resources would revoke each other's key on every deploy. Distinct users
-- keep the two credentials independent.
--
-- Identity model (same as 104): `users.id` is a serial int and `users.email`
-- carries NO unique constraint — only `cognito_sub` is unique. So the
-- deterministic, idempotent handle for this row is a `cognito_sub` SENTINEL
-- (`service-account:psd-aistudio-agent`). It is intentionally NOT a UUID, so it
-- can never collide with a real Cognito subject (which are UUIDs) and the account
-- can never be logged into via Cognito. The bootstrap Lambda looks the row up by
-- this exact sentinel.
--
-- Role: the service user is granted the `staff` role via `user_roles`. Staff is
-- the minimum SERVICE-ACCOUNT role used across the agent credentials (mirrors
-- 104) and grants `platform:read` eligibility (lib/api-keys/scopes.ts
-- ROLE_SCOPES.staff — platform:read is granted to student AND staff). platform:read
-- is a low-sensitivity read over non-sensitive product METADATA (the capability
-- catalog); no content or user-data scopes are granted to this user.
--
-- ADDITIVE and idempotent (re-runs are no-ops). No PL/pgSQL DO $$ blocks (the
-- migration runner's statement splitter cannot handle dollar-quoted blocks — see
-- 085/086/090/097). INSERTs into the postgres-owned users/user_roles tables are
-- fine under the master migration role (only ALTER on postgres-owned objects is
-- restricted — see 085).

-- 1. Service user. Deterministic identity via the unique cognito_sub sentinel.
--    first_name/last_name compose to "PSD Agent (aistudio MCP)" for UI provenance.
INSERT INTO users (cognito_sub, email, first_name, last_name)
SELECT 'service-account:psd-aistudio-agent',
       'aistudio-mcp-agent-service@psd401.net',
       'PSD Agent',
       '(aistudio MCP)'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE cognito_sub = 'service-account:psd-aistudio-agent'
);

-- 2. Grant the service user the `staff` role (platform:read eligibility).
--    Idempotent via the user_roles unique (user_id, role_id) constraint.
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.name = 'staff'
WHERE u.cognito_sub = 'service-account:psd-aistudio-agent'
ON CONFLICT (user_id, role_id) DO NOTHING;
