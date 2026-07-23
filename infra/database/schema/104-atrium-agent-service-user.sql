-- Migration 104: Atrium agent service user
-- Part of the zero-touch provisioning for the psd-atrium agent credential
-- (follow-up to PR #1195). PR #1195 added the psd-atrium OpenClaw skill + the
-- empty `psd-agent/<env>/atrium-content-api-key` secret, but left TWO manual
-- steps: (1) a human minted a content-scoped `sk-` key in AI Studio Settings,
-- (2) a human ran `aws secretsmanager put-secret-value`. This migration removes
-- the human owner of that key: it seeds a dedicated SERVICE USER that owns the
-- auto-minted key. The KEY itself is minted at deploy time by the
-- atrium-content-key-bootstrap custom resource (a random secret cannot live in
-- a committed migration), which resolves this user by its cognito_sub sentinel.
--
-- Why a service user (not a human): the psd-atrium skill authenticates with an
-- `sk-` key and acts as the key's OWNER (requesterFromApiAuth -> `user`
-- requester, visibility-gated by that user's roles — lib/content/requester-from-auth.ts).
-- Attributing writes to a dedicated service account keeps provenance legible in
-- the Atrium UI ("PSD Agent (service)") instead of borrowing a real staffer's
-- identity.
--
-- Identity model: `users.id` is a serial int (not a UUID), and `users.email`
-- carries NO unique constraint — only `cognito_sub` is unique. So the
-- deterministic, idempotent handle for this row is a `cognito_sub` SENTINEL
-- (`service-account:psd-atrium-agent`). It is intentionally NOT a UUID, so it
-- can never collide with a real Cognito subject (which are UUIDs) and the
-- account can never be logged into via Cognito. The bootstrap Lambda looks the
-- row up by this exact sentinel.
--
-- Role: the service user is granted the `staff` role via `user_roles`. Staff is
-- the minimum role that grants INTERNAL Atrium content visibility and makes the
-- content:read/create/update/publish_internal scopes eligible for the owned key
-- (lib/api-keys/scopes.ts ROLE_SCOPES.staff; verified working with a staff key
-- in PR #1195's functional test). `content:publish_public` is deliberately NOT
-- granted — the §26.4 public-publish approval gate stays.
--
-- ADDITIVE and idempotent (re-runs are no-ops). No PL/pgSQL DO $$ blocks (the
-- migration runner's statement splitter cannot handle dollar-quoted blocks — see
-- 085/086/090/097). INSERTs into the postgres-owned users/user_roles tables are
-- fine under the master migration role (only ALTER on postgres-owned objects is
-- restricted — see 085).

-- 1. Service user. Deterministic identity via the unique cognito_sub sentinel.
--    first_name/last_name compose to "PSD Agent (service)" for UI provenance.
INSERT INTO users (cognito_sub, email, first_name, last_name)
SELECT 'service-account:psd-atrium-agent',
       'atrium-agent-service@psd401.net',
       'PSD Agent',
       '(service)'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE cognito_sub = 'service-account:psd-atrium-agent'
);

-- 2. Grant the service user the `staff` role (internal content visibility +
--    content scope eligibility). Idempotent via the user_roles unique
--    (user_id, role_id) constraint.
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.name = 'staff'
WHERE u.cognito_sub = 'service-account:psd-atrium-agent'
ON CONFLICT (user_id, role_id) DO NOTHING;
