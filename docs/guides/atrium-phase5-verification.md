# Atrium Phase 5 — Agent Access Verification Runbook

Issue #1055 (Epic #1059). Manual verification for the MCP tools, REST v1 content
API, autonomous/delegated identities, the public-publish gate, audit, and events.

The CI-safe pieces (guard E2E, unit tests, registry parity, OIDC init) run
automatically. This runbook covers the authenticated, end-to-end paths that need
a running app + DB.

## Prerequisites

```bash
bun run db:up                 # local PostgreSQL
bun run db:reset && bun run db:seed   # migrations (incl. 090, 091) + test users

# Required for autonomous content ownership. MUST be a DEDICATED, NON-ADMIN,
# non-interactive service account that NEVER authors content through the UI.
# ⚠ Do NOT use an admin (or any real human) account: a client-credentials token
# is stamped sub = ATRIUM_SYSTEM_USER_ID, so (a) an autonomous agent with
# content:update could edit that account's own content (it owns via the same id),
# and (b) admin-gated non-content endpoints (e.g. /api/v1/assistants) that check
# isAdminByUserId(auth.userId) would treat the machine token as an admin.
export ATRIUM_SYSTEM_USER_ID=<a dedicated non-admin users.id>

# Optional — without it, events no-op (debug log only):
# export ATRIUM_EVENTS_TOPIC_ARN=arn:aws:sns:...:aistudio-dev-atrium-content-events
bun run dev:local
```

Seed the autonomous agent identities + their client-credentials OIDC clients
(prints the client secrets ONCE — store them):

```bash
bunx tsx scripts/seed-atrium-agents.ts
# → ship-reporter / screentime-bot (content:create, publish_internal)
#   tutorial-publisher (content:create, update) — none hold publish_public
```

## 1. REST v1 with an sk- API key (staff)

Mint a staff API key in the UI (Settings → API keys) with `content:read`,
`content:create`, `content:update`, `content:publish_internal`. Then:

```bash
KEY=sk-...
BASE=http://localhost:3000/api/v1
# create
ID=$(curl -s -X POST $BASE/content -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"document","title":"SOP draft","body":"# Hello","visibility":{"level":"internal"}}' \
  | jq -r '.data.id')
# new version
curl -s -X POST $BASE/content/$ID/versions -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"body":"# Hello v2","summary":"edit"}' | jq '.data.version.versionNumber'
# publish internally
curl -s -X POST $BASE/content/$ID/publish -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"destination":"intranet"}' | jq
# public publish WITHOUT content:publish_public → HTTP 202 approval_required
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/content/$ID/publish \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"destination":"public_web"}'   # expect 202
```

Confirm a `content_audit_logs` row per mutation (`surface = 'rest'`), and — with a
topic ARN set — one SNS publish per successful publish.

## 2. MCP tools

Point an MCP client (Claude Code, etc.) at `/api/mcp` with the same key. The
content tools (`create_document`, `create_artifact`, `get_content`,
`list_content`, `update_content`, `create_version`, `set_visibility`,
`publish_content`, `unpublish_content`, plus the Phase 8 `export_okf` /
`import_okf`) appear in `tools/list` for a caller holding `content:*`.
`publish_content` to `public_web` without `content:publish_public` returns a
structured `{ status: "approval_required" }` result (not an error);
`unpublish_content` mirrors the REST `DELETE /content/{id}/publish/{destination}`
semantics, including the public-destination authority check. `list_content`
accepts an optional `query` (title contains, ≤200 chars).

## 3. Autonomous identity (OAuth client-credentials)

```bash
CID=agent-ship-reporter
SECRET=<from the seed output>
TOKEN=$(curl -s -X POST http://localhost:3000/api/oauth/token \
  -u "$CID:$SECRET" \
  -d 'grant_type=client_credentials&scope=content:create content:publish_internal' \
  | jq -r '.access_token')
# Decode and confirm: sub = ATRIUM_SYSTEM_USER_ID, client_id = agent-ship-reporter,
# scope = content:create content:publish_internal
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq

# Use it against the content API — resolves to an agent-autonomous Requester:
curl -s -X POST http://localhost:3000/api/v1/content \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"document","title":"Weekly SHIP update","body":"# ...","visibility":{"level":"internal"}}' | jq '.data.createdByActor'   # expect "agent"

# Autonomous cannot publish publicly — gate returns approval_required (202):
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:3000/api/v1/content/<id>/publish \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"destination":"public_web"}'   # expect 202; emits content.public_publish_requested
```

## 4. Acceptance checklist (issue §31.2, Phase 5)

- [ ] MCP tools + `/v1/content` create & publish (steps 1–2).
- [ ] Delegated and autonomous identities work; delegated cannot exceed the
      human's grants (unit-tested in `tests/unit/atrium-requester-from-auth.test.ts`;
      delegated transport = an OIDC token carrying a `delegated_for` claim).
- [ ] Autonomous identity cannot `publish_content(public_web)` → structured
      `approval_required` (steps 2–3).
- [ ] Audit rows written; events emitted exactly once per successful publish.
- [ ] `bun run lint` + `bun run typecheck` pass.

## ⚠ Production / KMS caveat (OIDC JWT signing)

node-oidc-provider must sign JWT access tokens with an **in-process private key**
whose public half is served at `/api/oauth/jwks` (what the API middleware
verifies against). The local dev signer exports an extractable key, so steps 3
works locally. **AWS KMS keys are non-exportable**, so in production
`getSigningJwk()` returns null and JWT issuance is disabled (tokens stay opaque
and the middleware cannot verify them). Before relying on autonomous
client-credentials in a KMS deployment, supply an exportable RSA signing key to
the OIDC provider whose public half is also what `jwks-cache` serves (so signing
and verification agree). Until then, the autonomous transport is local/dev-only;
the autonomous **authorization** logic (Requester resolution + the public gate)
is fully implemented and unit-tested regardless of transport.
