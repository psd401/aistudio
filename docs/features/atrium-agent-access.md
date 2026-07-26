# Connecting Agents to Atrium Content

How external agents — a local MCP client (Claude Code, Claude Desktop, any MCP
client) or the PSD AI Agents (OpenClaw on AgentCore) — read and write Atrium
documents and artifacts, what each path can and cannot do, and how the live
collaborative document fits in.

> Transport, auth plumbing, and the full MCP tool registry live in
> [mcp-server.md](./mcp-server.md). The in-app chat editing path is documented in
> [nexus-workspace-chat-editing.md](./nexus-workspace-chat-editing.md). This page
> is the Atrium-specific integration guide.

## The one distinction that matters: version-based vs. live

Atrium content has **two write surfaces**:

| Surface | What it touches | Who can use it today |
|---|---|---|
| **Version-based** (MCP content tools, `/api/v1` content endpoints) | Persisted content objects + version snapshots. Reads return the last saved version; writes create a new version. | Any holder of an `sk-` API key with `content:*` scopes — local agents, scripts, OpenClaw skills. |
| **Live document bridge** (`POST /api/content/[id]/agent-bridge`) | The live Yjs document open in the collaborative editor — edits appear in real time on the purple agent rail, including `comment` and `suggest` (track-changes) ops. | **Logged-in humans only** (session auth). The session is the authorization conduit; `X-Agent-Id` is attribution. In-app Nexus workspace chat uses this via a server-side loopback. Autonomous-agent auth (API keys / delegated tokens) is a designed later phase — not available yet. |

Consequences for external agents:

- `get_content` returns the **last saved version** — a document being edited live
  in the collab editor may be ahead of what the agent reads until someone
  snapshots a version.
- External agent writes land as **new versions**, not live-editor keystrokes.
  Humans see them in the version history, not on the purple rail.
- If you need an external agent on the live rail, that is the agent-bridge
  API-key phase — file it as a feature, don't work around it.

## Path 1 — Local agent / any MCP client

1. **Mint a key:** AI Studio → **Settings → API Keys**. Administrators can grant
   all scopes; grant the minimum the agent needs (see scope table below).
2. **Connect** to the MCP endpoint with the key as a bearer token:

   ```bash
   # Claude Code
   claude mcp add --transport http aistudio https://dev.aistudio.psd401.ai/api/mcp \
     --header "Authorization: Bearer sk-YOUR_KEY"
   ```

   Any MCP client works the same way: Streamable HTTP `POST /api/mcp`,
   `Authorization: Bearer sk-…`.

3. **Use the content tools** (defined in `lib/mcp/content-tools.ts`, scope
   enforcement in `CONTENT_TOOL_SCOPE_MAP`):

   | Tool | Required scope | Notes |
   |---|---|---|
   | `get_content` | `content:read` | Object + last saved version |
   | `list_content` | `content:read` | |
   | `create_document` | `content:create` | Markdown documents; created **private + draft** |
   | `create_artifact` | `content:create` | Created **private + draft** |
   | `update_content` | `content:update` | Metadata |
   | `create_version` | `content:update` | The version-based "edit" |
   | `set_visibility` | `content:update` | |
   | `publish_content` | `content:publish_internal` | Public destinations additionally require the human/admin-held `content:publish_public` — the tool surfaces a structured `approval_required` signal instead of publishing |
   | `unpublish_content` | `content:publish_internal` | Taking down a **public** destination is gated the same as putting it up (§26.4) |
   | `export_okf` | `content:read` | `--audience public` additionally needs `content:publish_public` |
   | `import_okf` | `content:create` | Imports land private + draft |

**Safety invariants:** all agent-created objects start **private + draft**
(create → widen, never create-public), and every write is permission-gated by the
caller. **§28.3 screening (Bedrock Guardrails + PII telemetry) applies only to
writes that reach the server as an AGENT requester** (`agent-autonomous` /
`agent-delegated` — see `screenAgentBodyForWrite`, which no-ops for `user`
requesters). A plain `sk-` key resolves to its **owner** (`kind: "user"`), so those
writes are trusted, attributed to the key owner, and NOT guardrail/PII-screened —
mint the key to an accountable staff/service identity. True agent-identity writes
(the delegated/autonomous path) are screened and attributed to the agent.

## Path 2 — PSD AI Agents (OpenClaw on AgentCore)

The deployed `psd-aistudio` skill
(`infra/agent-image/skills/psd-aistudio/`) discovers platform capabilities and,
after per-user AI Studio OAuth consent, lists, describes, searches, reads exact
sources from, and polls changes in the repositories that user can access. The
credential priority is delegated OAuth, the legacy per-user personal API key,
then the shared `platform:read` discovery key. The shared key remains
**discovery-only** and is zero-touch provisioned exactly like the content key
(see below); it has its own secret and service user. Repository commands never
borrow the shared identity's content access and instead prompt the user to run
`psd-aistudio connect`.

**Gotcha:** `AGENT_INTERNAL_API_KEY` is a pre-shared key for the internal agent
endpoints — it is **not scope-aware and cannot authenticate to `/api/mcp`**.
Content/repository access needs a scoped `sk-` key or the per-user OAuth grant.

**The `psd-atrium` skill** (`infra/agent-image/skills/psd-atrium/`) gives the
agents Atrium abilities. It calls the fixed `/api/agent/atrium` broker surface,
whose signed invocation proof identifies the workspace owner. The broker resolves
that email to an active `users` row and `requesterForUserId`, then invokes the
shared content services directly. No reusable content key enters the workspace
and the route never falls back to the shared service principal.
Subcommands: `find`, `read`, `create-document`, `create-artifact`, `edit`
(`--mode replace|append`), `set-visibility`, `publish`, `unpublish`. The agent
works **version-based** (create-as-private, owner permission and capability
gating) and acts as the **signed workspace owner** — a `user` requester. Writes
are attributed to that owner; public publish/widen authority is never synthesized,
so the existing approval gate remains in force.

### Deployment — signed-owner broker

The `psd-atrium` runtime needs the internal agent broker origin and invocation
proof configuration already used by the other owner-bound skills. It does **not**
read `AISTUDIO_CONTENT_API_KEY` or
`psd-agent/{env}/atrium-content-api-key`.

Migration 104 and the `AtriumContentKeyProvisioner` may remain for legacy
service-principal clients, but that shared identity is not an authorization
conduit for owner-bound workspace operations.

#### The psd-aistudio MCP key (`platform:read`, Issue #1100)

The `psd-aistudio` discovery skill's `platform:read` key is provisioned by the
**same bootstrap Lambda body under a second profile** (`KEY_PROFILE=mcp`) — it is
**not** a reuse of the content key:

1. **Migration `108-aistudio-mcp-service-user.sql`** seeds a *separate* service
   user (`cognito_sub = service-account:psd-aistudio-agent`, email
   `aistudio-mcp-agent-service@psd401.net`, display name **"PSD Agent
   (aistudio MCP)"**) with the **staff** role (staff grants `platform:read`).
2. **The `AistudioMcpKeyProvisioner` custom resource** — a second instance of the
   bootstrap Lambda (`psd-agent-aistudio-mcp-key-bootstrap-<env>`, `KEY_PROFILE=mcp`)
   — idempotently ensures `psd-agent/{env}/aistudio-mcp-api-key` holds a valid,
   active `sk-` key scoped to **exactly `platform:read`** (no content scopes)
   owned by that service user. Same idempotency / rotation / skip-on-missing-
   migration / per-deploy-Nonce self-heal contract as the content key.
3. **Runtime env**: `AISTUDIO_MCP_API_KEY_SECRET_ID` points the skill at that
   secret; `AISTUDIO_MCP_URL` (derived from `APP_BASE_URL`) is the `/api/mcp`
   endpoint. Before #1100 this secret id was never wired, so the skill's
   `resolveApiKey()` exited 11 ("no credential configured").

> **Why a separate secret AND a separate service user (not a shared one):** the
> bootstrap's `replaceActiveKey` revokes **every** active key the service user
> owns before minting the new one (so exactly one active service key exists per
> user). If the content key and the MCP key shared a service user, the two
> bootstrap custom resources would revoke each other's key on every deploy. Two
> profiles → two secrets → two service users → two independent credentials.

**The only remaining human steps:**

1. **`cdk deploy`** — applies the current migrations, including migration 139
   for repository OAuth and Nexus Projects, and provisions the `psd-aistudio`
   discovery key. Atrium workspace operations use signed-owner broker authority
   rather than the legacy content service key.
2. **Rebuild + redeploy the agent image** — the agent discovers the skill only
   after `infra/agent-image` is rebuilt and the AgentCore runtime redeployed.

Provenance: writes land as the signed workspace owner (`user` requester), with
the same object ownership and capability checks as that human. A missing or
inactive owner fails closed before any content service call.

## Acting on behalf of a specific user (delegated tokens)

`POST /api/v1/agents/delegated-token` mints a **short-lived (300 s) delegated
token** that acts as a named human user. Requirements:

- The caller must be an **OIDC client-credentials agent client** holding the
  agent-held `content:delegate` scope — a user session or `sk-` key **cannot**
  mint one even with the scope.
- A delegated token can never carry `content:delegate` itself.

Status: the endpoint is implemented server-side, but the OIDC agent client it
requires is **not provisioned in our infrastructure yet**. Until then, agents
act as their own identity (attribution: the agent), not as a user.

Details: `docs/API/v1/context-graph.md` (§`POST /api/v1/agents/delegated-token`).

## How the live bridge actually works (for maintainers)

`POST /api/content/[id]/agent-bridge` (ops: `replace` / `append` / `comment` /
`suggest`) and the Nexus workspace-chat tools both funnel through
`lib/content/collab/apply-agent-edit.ts`, which connects to this same process's
collab websocket **over loopback** (`ws://127.0.0.1:$PORT/api/atrium-collab`) as
a y-sync client, so edits land on the exact Y.Doc connected editors hold.

Operational hazard: the loopback requires the server to be bound to an interface
that includes `127.0.0.1`. ECS injects `HOSTNAME=<task hostname>` at runtime,
which once made the standalone server bind eth0 only and broke every agent
read/write in deployed environments while browsers worked fine (PR #1189). The
fix (`entrypoint.sh` exports `HOSTNAME=0.0.0.0`) plus a boot-time loopback
self-check are documented in
`docs/learnings/infrastructure/2026-07-11-ecs-hostname-injection-breaks-loopback.md`.
Boot-log check: `Local: http://localhost:3000` = healthy;
`Local: http://<hostname>:3000` = loopback dead.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 from `/api/mcp` using `AGENT_INTERNAL_API_KEY` | Wrong credential class — mint an `sk-` key (see gotcha above) |
| `psd-atrium` exits 11 (unauthorized / not configured) | The signed invocation proof is missing/invalid, or its owner no longer resolves to an active Atrium requester. Check the agent broker proof configuration and the owner's user/capability records. |
| `psd-aistudio` exits 11 (no credential configured) | The `platform:read` MCP key isn't in the secret. It is auto-provisioned by the `AistudioMcpKeyProvisioner` custom resource on `cdk deploy` — check its CloudWatch logs (`/aws/lambda/psd-agent-aistudio-mcp-key-bootstrap-<env>`); confirm migration 108 applied. A re-deploy re-mints. (`AISTUDIO_MCP_API_KEY` may be set directly for local/dev.) |
| A `psd-aistudio repositories-*` command reports insufficient scope | Run `psd-aistudio connect --user <email>` and complete the one-time AI Studio consent. The shared discovery key intentionally has no repository scopes. |
| `psd-atrium publish` returns `approval_required` | Public destination without `content:publish_public` — expected; relay the message so the user knows it's queued |
| 403 `INSUFFICIENT_SCOPE` on a content tool | Key lacks the scope in the table above |
| `publish_content` returns `approval_required` | Public destination — needs human/admin `content:publish_public`; internal destinations publish directly |
| Agent reads stale document text | Expected: `get_content` returns the last saved **version**; live editor changes appear after a snapshot |
| Workspace chat says the live document service is unreachable | Loopback binding regression — check the boot log `Local:` line and the `loopback self-check` line (see maintainers section) |
