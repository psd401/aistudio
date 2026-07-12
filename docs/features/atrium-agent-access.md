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

**Today:** the deployed `psd-aistudio` skill
(`infra/agent-image/skills/psd-aistudio/`) is **discovery-only**. It calls the
`describe_capabilities` meta-tool over `/api/mcp` with a `platform:read`-scoped
key (from `AISTUDIO_MCP_API_KEY` or Secrets Manager via
`AISTUDIO_MCP_API_KEY_SECRET_ID`) so the agent always knows what AI Studio can
do — it deliberately does not execute content actions.

**Gotcha:** `AGENT_INTERNAL_API_KEY` is a pre-shared key for the internal agent
endpoints — it is **not scope-aware and cannot authenticate to `/api/mcp`**.
Content access needs its own `sk-` key.

**The `psd-atrium` skill** (`infra/agent-image/skills/psd-atrium/`) gives the
agents Atrium abilities. It wraps the `/api/v1/content/*` REST surface (which is
1:1 with the MCP content tools but returns the saved body inline and a real HTTP
202 for the approval gate), authenticated with a scoped `sk-` **content** key.
Subcommands: `find`, `read`, `create-document`, `create-artifact`, `edit`
(`--mode replace|append`), `set-visibility`, `publish`, `unpublish`. The agent
works **version-based**, like any other `sk-` caller (create-as-private, permission
gating), and acts as the **content key's owner identity** — a `user` requester, so
its writes are trusted + attributed to the owner and are NOT §28.3-screened (that
runs only for true agent-identity writes; see the Safety invariants above). Not the
asking user, either; per-user delegation is the future phase below.

### Deployment — zero-touch (no manual credential steps)

The content key is **provisioned automatically at deploy time**. There is no
"mint a key in the UI" or `put-secret-value` step. Two pieces do it:

1. **Migration `104-atrium-agent-service-user.sql`** seeds a dedicated service
   user (`cognito_sub = service-account:psd-atrium-agent`, email
   `atrium-agent-service@psd401.net`, display name **"PSD Agent (service)"**) and
   grants it the **staff** role — the minimum role that grants internal Atrium
   visibility and makes the `content:read/create/update/publish_internal` scopes
   eligible.
2. **The `AtriumContentKeyProvisioner` custom resource**
   (`infra/lambdas/atrium-content-key-bootstrap/`, wired in
   `infra/lib/agent-platform-stack.ts`) runs on every `cdk deploy` and
   **idempotently** ensures `psd-agent/{env}/atrium-content-api-key` holds a
   valid, active `sk-` key owned by that service user, scoped to
   `content:read content:create content:update content:publish_internal`
   (**not** `content:publish_public` — the §26.4 public-publish approval gate
   stays; public publishes return `approval_required`). The DB stores only the
   Argon2id hash; the plaintext is written to the secret and never logged.

**Idempotency contract** (the custom resource re-runs each deploy — self-healing):

| Secret state | Action |
| --- | --- |
| holds a valid, active, sufficiently-scoped key owned by the service user | **no-op** |
| empty / malformed | **mint** |
| points at a missing, inactive, revoked, or under-scoped key | **re-mint** (and revoke the service user's other active keys, so exactly one stays live) |

**Rotation:** delete the secret value **or** revoke/delete the `api_keys` row →
the next `cdk deploy` re-mints. (No dedicated rotation Lambda; a redeploy is the
rotation trigger.)

**Runtime env** (wired by `infra/lib/agent-platform-stack.ts`, no manual step):
`AISTUDIO_CONTENT_API_KEY_SECRET_ID` points the skill at that secret;
`APP_BASE_URL` supplies the `/api/v1/content` base. (`AISTUDIO_CONTENT_API_KEY`
may be set directly for local/dev instead of the secret.)

**The only remaining human steps:**

1. **`cdk deploy`** — applies migration 104 and runs the key-bootstrap custom
   resource (DatabaseStack deploys before AgentPlatformStack, so the service user
   exists before the key is minted).
2. **Rebuild + redeploy the agent image** — the agent discovers the skill only
   after `infra/agent-image` is rebuilt and the AgentCore runtime redeployed.

Provenance & screening: writes land as the service user (a `user`/`kind:"user"`
requester), attributed to **"PSD Agent (service)"** as a human `authorActor`, and
are **not** §28.3-screened — platform guardrails run telemetry-only by product
decision, and the `sk-`/owner path is the trusted-caller path (see the Safety
invariants above). True agent-identity (delegated/autonomous) writes remain
screened and attributed to the agent.

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
| `psd-atrium` exits 11 (unauthorized / not configured) | The content key isn't in the secret. It is auto-provisioned by the `AtriumContentKeyProvisioner` custom resource on `cdk deploy` — check its CloudWatch logs (`/aws/lambda/psd-agent-atrium-key-bootstrap-<env>`). A re-deploy re-mints. (`AISTUDIO_CONTENT_API_KEY` may be set directly for local/dev.) |
| `psd-atrium publish` returns `approval_required` | Public destination without `content:publish_public` — expected; relay the message so the user knows it's queued |
| 403 `INSUFFICIENT_SCOPE` on a content tool | Key lacks the scope in the table above |
| `publish_content` returns `approval_required` | Public destination — needs human/admin `content:publish_public`; internal destinations publish directly |
| Agent reads stale document text | Expected: `get_content` returns the last saved **version**; live editor changes appear after a snapshot |
| Workspace chat says the live document service is unreachable | Loopback binding regression — check the boot log `Local:` line and the `loopback self-check` line (see maintainers section) |
