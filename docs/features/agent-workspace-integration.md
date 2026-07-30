# Agent-Owned Google Workspace Integration (#912)

Per-user agents operate as their own Google Workspace identity
(`agnt_<uniqname>@psd401.net`). Humans delegate to the agent the same way
they would delegate to a real executive assistant. The agent's
`psd-workspace` submits tokenized `gws` commands to a trusted operation broker.
The broker obtains credentials outside the model runtime for two slots:

- **User slot (`--scope user`)** — the human's own identity. Still uses a
  per-user OAuth **consent** flow; the refresh token lives in Secrets Manager
  and is exchanged for an access token at runtime.
- **Agent slot (`--scope agent`)** — the `agnt_*` identity. As of **#1232**
  there is **no consent flow and no stored refresh token**: a short-lived
  access token is minted on demand by a **domain-wide-delegation (DWD) token
  broker behind `POST /api/agent/workspace-execute`, then injected only into
  the trusted `gws` child process. Agent accounts are created automatically via
  the OneSync sheet (**#1233**); interactive sign-in on `agnt_*` accounts is
  blocked at the Google layer.
  - **Confused-deputy isolation (#1232 hardening):** the DWD broker and the
    OneSync sheet writer do **not** run in the Next.js app. They run in a
    dedicated **mint Lambda** (`psd-agent-mint-{env}`) with its own least-
    privilege role, which is the **sole AWS principal the Google WIF provider
    trusts**. `/api/agent/workspace-execute` obtains its agent-slot token through
    the mint boundary, and `/api/agent/account-request` is a thin provisioning
    proxy; both reach the mint Lambda via IAM-authenticated
    `lambda:InvokeFunction`. So a frontend RCE/SSRF can at most *invoke* the mint
    Lambda — which always derives `agnt_<owner>` server-side — and can never
    reach the WIF credential to `signJwt(sub=<arbitrary human>)`. Blast radius of
    a frontend compromise: **any `agnt_` account** (agent-generated content), not
    any psd401.net mailbox. (When `AGENT_MINT_LAMBDA_NAME` is unset — local dev —
    the boundary runs in-process; there is no real WIF locally.)

## Components

| Layer | Where | Purpose |
|---|---|---|
| DB | `psd_agent_workspace_tokens`, `psd_agent_workspace_consent_nonces` (migration 071) | Token manifest (user slot lifecycle; agent slot shows "Auto (DWD)") + one-time consent nonces |
| API | `POST /api/agent/consent-link` | Owner-bound, router-signed request that mints a consent URL (**user slot only** — agent_account is rejected, #1232) |
| API | `POST /api/agent/workspace-execute` | Owner-bound trusted operation broker. Validates the complete `gws` argv, obtains the selected slot's token outside the model runtime, executes `gws`, and returns bounded output. |
| API | `POST /api/agent/workspace-token` | Retired raw-token endpoint. Authenticated callers receive 410 and must use `workspace-execute`; the model runtime never receives a reusable Google token. |
| API | `POST /api/agent/account-request` | Owner-bound, router-signed **thin proxy** to the mint Lambda (existence probe + OneSync `agents` sheet append) that auto-provisions the agnt_ account (#1233) |
| Lambda | `psd-agent-mint-{env}` (AgentPlatformStack, role `psd-agent-mint-execution-role-{env}`) | **#1232 isolation** — the sole WIF principal. Houses the DWD broker + provisioning-sheet writer; derives `agnt_<owner>` server-side. Role grants only `secretsmanager:GetSecretValue` on `psd-agent/{env}/*` + logs; the frontend holds only `lambda:InvokeFunction` on it. |
| UI | `/agent-connect`, `/agent-connect/callback` | Public OAuth bootstrap (off-nav) |
| Admin | "Workspace" tab in `/admin/agents` | Per-user status dashboard |
| Skill | `infra/agent-image/skills/psd-workspace/` | Agent-side `gws` wrapper |
| Workflow skill | `infra/agent-image/skills/psd-workflows/` | Dynamically discovers the PSD Agent Gateway MCP roster, describes schemas, and calls owner-bound workflows (#1403) |
| Binary | `gws` (pinned in `Dockerfile`) | Google Workspace CLI |
| Upstream skills | `gws-gmail`, `gws-calendar`, `gws-sheets`, … (cloned at image build, same tag as the binary) | Per-API guidance for the agent |
| Rules | `infra/agent-image/skills/psd-rules/SKILL.md` | Tier 1 progressive-disclosure rules (think silently, never fabricate URLs/memory, no empty promises, Chat formatting) |
| Formatter | `infra/agent-image/chat_format.py` | Markdown → Google Chat transform applied at the harness boundary |
| Invocation proof | `psd-agent/{env}/invocation-signing-key` | CDK-generated signing secret shared by the router and trusted web boundary. Every model-facing broker request is bound to the verified owner and invocation mode; caller-supplied owner selectors are rejected. |
| Secrets | `psd-agent/{env}/google-oauth-client`, `psd-agent/{env}/gcp-dwd-config` (#1232/#1233), `psd-agent/{env}/agent-gateway` (#1230/#1403), `psd-agent-creds/{env}/user/{email}/google-workspace-user` (user slot) | OAuth client, GCP DWD config JSON, dynamic workflow-gateway URL+token JSON, and per-user refresh tokens. The agent slot no longer stores a refresh token (#1232). |
| DWD config | `psd-agent/{env}/gcp-dwd-config` JSON: `{projectNumber, wifPoolId, wifProviderId, serviceAccountEmail, provisioningSheetId}` (Secrets Manager, IT-supplied; env-var overrides for local dev) | Keyless WIF → service-account impersonation for the broker + OneSync provisioning-sheet id. Read lazily (5-min cached); broker fails closed until populated. |
| Local broker | `infra/agent-image/mantle_proxy.py` + `skills/_shared/agent-broker.js` | Restricts callable `/api/agent/*` routes and forwards the router-signed invocation context; Workspace commands use `workspace-execute`, never the retired raw-token route. |

## Bootstrap flow — user slot (consent)

1. User DMs agent with a request needing THEIR mailbox/calendar (`--scope user`).
2. Skill submits the command to `/api/agent/workspace-execute`; the trusted
   broker finds no usable per-user refresh token and returns `needs-auth`.
3. Skill POSTs `/api/agent/consent-link` (`kind:"user_account"`) through the
   owner-bound signed broker context.
4. App signs a JWT (`AUTH_SECRET`, 24h exp, single-use nonce) and returns a URL.
5. Skill emits `{status:"needs-auth",consent_url,...}` and exits 10.
6. Agent pastes the URL verbatim into Chat; user clicks; `/agent-connect`
   verifies the JWT and redirects to Google (with `hd=psd401.net`).
7. Google redirects back to `/agent-connect/callback?code=...&state=<nonce>`.
8. Callback re-verifies the nonce, exchanges the code, **verifies the granted
   id_token's email matches the owner** (#1234 — a wrong-account grant stores
   nothing and is retryable), writes the refresh token to
   `psd-agent-creds/{env}/user/{email}/google-workspace-user`, upserts the
   manifest row `active`, and consumes the nonce.
9. User retries. The trusted broker refreshes the user token and executes
   `gws`; the model runtime receives command output, never the credential.

## Agent-slot flow — DWD broker (no consent)

1. User asks the agent to act AS itself (`--scope agent`).
2. Skill submits the allowlisted argv to `/api/agent/workspace-execute` through
   the owner-bound signed broker context.
3. The trusted route invokes the **mint Lambda**, which derives
   `agnt_<owner-localpart>@psd401.net` server-side and mints a ~1h access token
   via WIF → service-account signJwt → jwt-bearer exchange. The route injects
   the token only into its child `gws` process. Only the mint Lambda's role can
   perform the WIF leg (the frontend and model runtime cannot).
4. If the agnt_ account doesn't exist yet, the mint boundary returns
   `account-not-provisioned`; the skill emits `{status:"account-provisioning"}`
   exit 14 (the router has already kicked off auto-provisioning, #1233). No
   consent link — the user just retries in ~30 min.

Outbound Google Chat messages are agent-slot-only. The trusted executor
allowlists both the `chat +send` helper and the raw
`chat spaces messages create` method, while rejecting both on the human user
slot. The DWD assertion already carries `chat.messages`, which authorizes
`spaces.messages.create` with user authentication; `chat.bot` is for Chat-app
authentication and is not the credential mode used by the `agnt_*` identity.
The skill still requires explicit user confirmation before posting, and the
broker refuses Chat message creation from scheduled invocation mode, where no
live confirmation can exist. Scheduled job output continues through the
router's existing configured delivery path rather than calling `chat +send`.

The destination is bounded by Chat membership rather than by the turn that
triggered the send. The agent cannot widen that boundary itself: `chat spaces
create`, `chat spaces setup` and `chat spaces members create` are all absent
from the write allowlist, so the reachable set is the spaces the `agnt_*`
identity already belongs to. Completed interactive sends are logged with their
resolved destination space and message length (never the body) so posts are
auditable after the fact.

## Runtime error contract

The skill emits a single JSON line on stdout (or a stderr message for exit 12)
and a non-zero exit code when auth isn't ready:

| Exit | Status | Slot | Meaning |
|---|---|---|---|
| 10 | `needs-auth` | user | No refresh token yet — consent URL in payload |
| 11 | `token-revoked` | user | `invalid_grant` from Google — consent URL in payload |
| 12 | (stderr) | both | Broker, policy, CLI, or Google failure; inspect the error text and request ID |
| 13 | `phase1-forbidden` | both | A Phase-1 hard gate refused the command |
| 14 | `account-provisioning` | agent | agnt_ account being auto-created — retry later, nothing to click |

User-slot 10/11 payloads carry `consent_url`; `SOUL.md` instructs the agent to
paste it verbatim into Chat and stop the turn. Exit 14 carries **no** URL.

## Deployment checklist

1. **GCP Console** (one-time): create the OAuth client per the Epic spec —
   Internal + In Production, redirect URIs for dev and prod, all seven
   scopes.
2. Populate Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id psd-agent/dev/google-oauth-client \
     --secret-string '{"client_id":"...","client_secret":"..."}'
   ```
3. The invocation-signing key is auto-generated by CDK. Router and frontend
   receive its Secrets Manager ID automatically; do not copy it into the agent
   image or a request body. For local development only, use the environment
   override documented in `lib/agent-workspace/invocation-context.ts`.
4. ECS loads the OAuth client lazily from
   `GOOGLE_WORKSPACE_OAUTH_SECRET_ID`. Local development may instead set
   `GOOGLE_WORKSPACE_CLIENT_ID` / `GOOGLE_WORKSPACE_CLIENT_SECRET`.
5. **DWD broker + provisioning (#1232/#1233)** — IT provisions a Google service
   account with domain-wide delegation + a workload-identity-federation trust,
   then populate ONE Secrets Manager secret (no CDK context flags — aistudio is a
   public repo):
   ```bash
   aws secretsmanager create-secret \
     --name psd-agent/dev/gcp-dwd-config \
     --tags Key=Environment,Value=dev Key=ManagedBy,Value=aistudio \
     --secret-string '{"projectNumber":"…","wifPoolId":"…","wifProviderId":"…","serviceAccountEmail":"…@….iam.gserviceaccount.com","provisioningSheetId":"…"}'
   ```
   The mint Lambda reads it lazily (5-min cached); until it exists the broker
   fails closed (503 / `not-configured`) and provisioning is skipped. (Local dev
   may instead set the `GCP_*` / `AGENT_PROVISIONING_SHEET_ID` env vars.)

   **WIF trusts the mint role, NOT the frontend role (#1232 hardening).** The WIF
   provider condition and the SA `principalSet` bindings must reference the mint
   Lambda's role, whose ARN is stable and deterministic:
   - Role ARN: `arn:aws:iam::<account>:role/psd-agent-mint-execution-role-{env}`
   - Assumed-role principal (what Google's STS sees): `arn:aws:sts::<account>:assumed-role/psd-agent-mint-execution-role-{env}/*`

   Reese, when wiring (or re-pointing off the old frontend-role trust) the
   Google side against the mint role:
   1. Set the WIF provider (`mint-service`) attribute condition to accept the
      mint role's assumed-role ARN above (replacing the frontend ECS task role).
   2. Move the `roles/iam.workloadIdentityUser` **and**
      `roles/iam.serviceAccountTokenCreator` `principalSet` bindings on the DWD
      service account to the mint role's WIF principal.

   The mint Lambda authenticates keylessly (google-auth-library `AwsClient`
   resolves the Lambda role's ambient credentials via the Fargate/Lambda
   container-credentials endpoint the same way it did for the ECS task role — see
   the `credential_source` note in `lib/agent-workspace/gcp-wif.ts`); no
   service-account key is downloaded.
6. **Agent workflow gateway (#1230/#1403)** — populate ONE JSON secret with
   both the n8n MCP Server Trigger URL and its bearer token (again, no CDK
   context flag):
   ```bash
   aws secretsmanager create-secret \
     --name psd-agent/dev/agent-gateway \
     --tags Key=Environment,Value=dev Key=ManagedBy,Value=aistudio \
     --secret-string '{"url":"https://n8n.psd401.net/mcp/…/sse","token":"…"}'
   ```
   The `psd-workflows` skill discovers the gateway's live MCP `tools/list`
   roster through the signed web broker; an absent/incomplete secret → exit 11
   `not-configured`. Every gateway parameter that represents the verified
   caller must be a top-level string property actually consumed by the workflow
   and include `[caller-bound]` in that property's `inputSchema` description.
   The broker replaces all marked values with the signed owner. Only lowercase
   `get_*` and `list_*` names are treated as read-only; every other tool fails
   closed without a marker, regardless of case or naming style. For one release,
   `list_supervised_employees.evaluator_email` and
   `submit_classified_evaluation.evaluator_email` are also owner-bound
   explicitly so older gateway schemas remain safe during the marker rollout.
7. Deploy infra (AgentPlatformStack + FrontendStack) and the new agent image. No
   `-c` context flags are needed for the gateway or DWD config.
8. **Remediation (one-off, run manually):**
   - `scripts/agent-workspace/purge-agent-slot-tokens.ts` — delete all
     agent-slot refresh tokens (retired by the broker; one is known to hold a
     human's token). Dry-run by default; `--apply` to execute.
   - `scripts/agent-workspace/audit-user-slot-token-identity.ts` — audit
     user-slot tokens for identity mismatch (#1234) and purge the bad ones.

## Operator runbook — run and verify the complete integration

This is the start-to-finish checklist for Epic #912 and its DWD,
auto-provisioning, Drive-access, and Chat-send follow-ups. The commands below
match the current Phase 1 policy: Gmail writes stop at drafts, destructive
operations remain blocked, user-slot file content creation is blocked, and
interactive Chat sends use the agent slot.

### 1. Run the automated contract

From the repository root:

```bash
bun install --frozen-lockfile

# Skill-side parsing, payload files, Phase 1 gates, and Chat-send pass-through
bun run test:skill:workspace

# Trusted broker, DWD minting, provisioning, OAuth identity, and route modes
bunx jest --runInBand --runTestsByPath \
  tests/unit/lib/agent-workspace/command-executor.test.ts \
  tests/unit/lib/agent-workspace/command-executor-runtime.test.ts \
  tests/unit/dwd-token-broker.test.ts \
  tests/unit/agent-mint-client.test.ts \
  tests/unit/agent-mint-lambda-handler.test.ts \
  tests/unit/agent-provisioning-sheet.test.ts \
  tests/unit/agent-account-request-route.test.ts \
  tests/unit/agent-workspace-token-route.test.ts \
  tests/unit/agent-consent-link-route.test.ts \
  tests/unit/agent-workspace-callback-identity.test.ts \
  tests/unit/agent-workspace-user-slot-scopes.test.ts \
  tests/unit/agent-email-task-route.test.ts

bun run lint
bun run typecheck

# In another shell: bun run db:up && bun run dev:local
# Public consent-page and API-auth guards; no live Google grant required.
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  bunx playwright test tests/e2e/agent-workspace-connect.spec.ts
```

The full Google OAuth happy path, DWD exchange, OneSync account creation, and
Chat delivery need dev credentials and are intentionally a live smoke test,
not a hermetic CI test.

### 2. Deploy the runnable pieces

Follow the [Agent Platform Setup Guide](../operations/agent-platform-setup.md)
for the GCP Chat app, AWS stacks, bridge, and image order. Follow the
[Agent Image Build-Time Eval Gate](../operations/agent-image-build-gate.md)
when building or promoting the image. The Workspace-specific order is:

1. Complete the GCP OAuth, DWD, WIF, OU/app-policy, and OneSync setup in the
   deployment checklist above. The WIF principal must be the mint Lambda role,
   never the frontend role.
2. Populate `google-oauth-client` and `gcp-dwd-config` without printing secret
   values to logs. CDK creates the invocation-signing key; do not manually
   retrieve or copy it.
3. From `infra/`, run `bunx cdk synth` before any deploy, then deploy the
   AgentPlatform and Frontend stacks for the target environment.
4. From `infra/agent-image/`, run `./build-and-push.sh <immutable-tag>` and
   redeploy the AgentPlatform stack with that image tag as described in the
   setup guide.
5. Run both one-off remediation scripts in dry-run mode, review their output,
   then use their documented apply flags only for confirmed stale or
   mismatched tokens.

Safe configuration checks:

```bash
aws secretsmanager describe-secret \
  --secret-id psd-agent/dev/gcp-dwd-config

aws lambda get-function-configuration \
  --function-name psd-agent-mint-dev \
  --query '{State:State,LastUpdateStatus:LastUpdateStatus,Role:Role}'

aws logs tail /aws/lambda/psd-agent-mint-dev --since 30m
```

These commands verify presence and runtime state without retrieving secret
contents.

### 3. Exercise the live flows in dev

Use a staff pilot account and its `agnt_<uniqname>@psd401.net` identity.
Confirm the Workspace tab under `/admin/agents` first shows the expected user
slot and agent-slot state.

The commands below run **inside the agent image during an active, signed
invocation**; a standalone shell without invocation context is correctly
rejected. In normal operation, send the equivalent request to the agent in
Google Chat; the agent invokes the same entrypoint. For more examples and
payload-file rules, see the bundled
[`psd-workspace` skill contract](../../infra/agent-image/skills/psd-workspace/SKILL.md).

```bash
WORKSPACE_RUNNER=/opt/psd-skills/psd-workspace/run.js
PILOT_EMAIL=someone@psd401.net

# User-slot consent/read path. First run may return exit 10 with a consent URL.
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope user \
  --command "gmail users messages list --params '{\"userId\":\"me\",\"q\":\"is:unread\",\"maxResults\":5}'"

# User-slot safe writes.
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope user \
  --command "gmail +draft --to someone@psd401.net --subject 'Workspace smoke test' --body 'Draft only'"
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope user \
  --command "tasks tasks insert --params '{\"tasklist\":\"@default\"}' --json '{\"title\":\"Workspace smoke test\"}'"
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope user \
  --command "drive files list --params '{\"pageSize\":5}'"

# Agent-slot DWD path. A missing account returns exit 14 while OneSync creates it.
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope agent \
  --command "drive files list --params '{\"pageSize\":5}'"

# Chat send: use a disposable dev space and obtain explicit confirmation first.
node "$WORKSPACE_RUNNER" --user "$PILOT_EMAIL" --scope agent \
  --command "chat +send --space spaces/DEV_SPACE_ID --text 'Workspace smoke test'"
```

For the Chat-send regression, also exercise the raw
`chat spaces messages create` form, verify the message appears in the
designated space, and confirm the completion log records
`outboundSpace`/`outboundTextLength` without the body. Re-run both forms with
`--scope user` and verify the broker refuses them. Scheduled and email-task
invocations must also refuse Chat writes; only an interactive owner invocation
may post.

Complete the remaining lifecycle checks:

- **Provisioning:** use a staff pilot with no `agnt_` account. The first
  interaction requests exactly one OneSync sheet row, returns exit 14 while
  pending, and succeeds after OneSync creates the account. Numeric-prefix
  student identities must never reach the sheet.
- **Delegation:** delegate Gmail and Calendar to the `agnt_` identity using
  Google settings, then verify the agent can read the delegated data. Without
  delegation it should see only its own account.
- **Revocation:** revoke the user-slot OAuth grant, retry a user-slot command,
  and verify exit 11 supplies a new consent link without affecting the DWD
  agent slot.
- **Policy boundaries:** verify Gmail send, deletes, permission changes without
  provenance, and user-owned document creation remain refused. Do not weaken a
  gate to make a smoke test pass.

### 4. Diagnose a failed run

1. Map the skill exit code using the runtime error contract above.
2. Check the router, frontend broker, and `/aws/lambda/psd-agent-mint-<env>`
   logs with the shared request ID.
3. Exit 12 with `Workspace operation is not allowed` is a trusted broker
   allowlist rejection; exit 13 is a Phase 1 policy rejection. They are not
   interchangeable.
4. A Google error saying the organization restricts the **Chat app** belongs
   to the router's `chat.bot` identity and Workspace app policy. It is separate
   from the DWD-backed `agnt_` user identity; use the OU/app-policy checks in
   the Agent Platform Setup Guide.
5. After deployment, repeat the live smoke with at least two agent identities.
   A single passing account does not prove the server-side derivation and
   OneSync path work fleet-wide.

## Delegation (user-side)

Once connected, users who want the agent to act on *their* inbox/calendar
delegate from Gmail/Calendar settings to `agnt_<uniqname>@psd401.net`.
Without delegation, the agent only sees its own inbox/calendar.

## Limits (explicit)

- **No automated Gmail/Calendar delegation** — users do it via Google's UI.
- **No progressive scope consent** — v1 grants all scopes at bootstrap.
- **No agent-to-agent workspace actions** — deferred.
- **Missing-scope exit (12) is reserved** — `gws` does not currently emit
  structured missing-scope errors; revocation (11) is the primary
  re-consent path.
