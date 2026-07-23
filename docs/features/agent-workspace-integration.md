# Agent-Owned Google Workspace Integration (#912)

Per-user agents operate as their own Google Workspace identity
(`agnt_<uniqname>@psd401.net`). Humans delegate to the agent the same way
they would delegate to a real executive assistant. The agent's
`psd-workspace` skill wraps the `gws` CLI and obtains per-session access
tokens for two slots:

- **User slot (`--scope user`)** — the human's own identity. Still uses a
  per-user OAuth **consent** flow; the refresh token lives in Secrets Manager
  and is exchanged for an access token at runtime.
- **Agent slot (`--scope agent`)** — the `agnt_*` identity. As of **#1232**
  there is **no consent flow and no stored refresh token**: a short-lived
  access token is minted on demand by a **domain-wide-delegation (DWD) token
  broker** (`POST /api/agent/workspace-token`). Agent accounts are created
  automatically via the OneSync sheet (**#1233**); interactive sign-in on
  `agnt_*` accounts is blocked at the Google layer.
  - **Confused-deputy isolation (#1232 hardening):** the DWD broker and the
    OneSync sheet writer do **not** run in the Next.js app. They run in a
    dedicated **mint Lambda** (`psd-agent-mint-{env}`) with its own least-
    privilege role, which is the **sole AWS principal the Google WIF provider
    trusts**. The `/api/agent/workspace-token` and `/api/agent/account-request`
    routes are thin proxies that reach the mint Lambda via an IAM-authed
    `lambda:InvokeFunction`. So a frontend RCE/SSRF can at most *invoke* the mint
    Lambda — which always derives `agnt_<owner>` server-side — and can never
    reach the WIF credential to `signJwt(sub=<arbitrary human>)`. Blast radius of
    a frontend compromise: **any `agnt_` account** (agent-generated content), not
    any psd401.net mailbox. (When `AGENT_MINT_LAMBDA_NAME` is unset — local dev —
    the routes run the broker in-process; there is no real WIF locally.)

## Components

| Layer | Where | Purpose |
|---|---|---|
| DB | `psd_agent_workspace_tokens`, `psd_agent_workspace_consent_nonces` (migration 071) | Token manifest (user slot lifecycle; agent slot shows "Auto (DWD)") + one-time consent nonces |
| API | `POST /api/agent/consent-link` | Agent→app, mints signed consent URLs (**user slot only** — agent_account is rejected, #1232) |
| API | `POST /api/agent/workspace-token` | Agent→app; **thin proxy** to the mint Lambda; mints a ~1h agent-slot access token (#1232). 404 `account-not-provisioned` when the agnt_ account isn't made yet |
| API | `POST /api/agent/account-request` | Router→app; **thin proxy** to the mint Lambda (probe + OneSync `agents` sheet append) to auto-provision the agnt_ account (#1233) |
| Lambda | `psd-agent-mint-{env}` (AgentPlatformStack, role `psd-agent-mint-execution-role-{env}`) | **#1232 isolation** — the sole WIF principal. Houses the DWD broker + provisioning-sheet writer; derives `agnt_<owner>` server-side. Role grants only `secretsmanager:GetSecretValue` on `psd-agent/{env}/*` + logs; the frontend holds only `lambda:InvokeFunction` on it. |
| UI | `/agent-connect`, `/agent-connect/callback` | Public OAuth bootstrap (off-nav) |
| Admin | "Workspace" tab in `/admin/agents` | Per-user status dashboard |
| Skill | `infra/agent-image/skills/psd-workspace/` | Agent-side `gws` wrapper |
| Binary | `gws` (pinned in `Dockerfile`) | Google Workspace CLI |
| Upstream skills | `gws-gmail`, `gws-calendar`, `gws-sheets`, … (cloned at image build, same tag as the binary) | Per-API guidance for the agent |
| Rules | `infra/agent-image/skills/psd-rules/SKILL.md` | Tier 1 progressive-disclosure rules (think silently, never fabricate URLs/memory, no empty promises, Chat formatting) |
| Formatter | `infra/agent-image/chat_format.py` | Markdown → Google Chat transform applied at the harness boundary |
| Secrets | `psd-agent/{env}/google-oauth-client`, `psd-agent/{env}/internal-api-key`, `psd-agent/{env}/gcp-dwd-config` (#1232/#1233), `psd-agent/{env}/agent-gateway` (#1230), `psd-agent-creds/{env}/user/{email}/google-workspace-user` (user slot) | OAuth client, PSK, GCP DWD config JSON, gateway URL+token JSON, per-user refresh tokens. The agent slot no longer stores a refresh token (#1232). |
| DWD config | `psd-agent/{env}/gcp-dwd-config` JSON: `{projectNumber, wifPoolId, wifProviderId, serviceAccountEmail, provisioningSheetId}` (Secrets Manager, IT-supplied; env-var overrides for local dev) | Keyless WIF → service-account impersonation for the broker + OneSync provisioning-sheet id. Read lazily (5-min cached); broker fails closed until populated. |
| Cedar | `psd-agent-governance.cedar` | Allowlists for oauth2.googleapis.com + n8n gateway (`n8n.psd401.net/mcp/*`, #1230) + consent-link + workspace-token + account-request, secret.read on `psd-agent/*` |

## Bootstrap flow — user slot (consent)

1. User DMs agent with a request needing THEIR mailbox/calendar (`--scope user`).
2. Skill checks Secrets Manager for a per-user refresh token; finds none.
3. Skill POSTs `/api/agent/consent-link` (`kind:"user_account"`) with a
   shared-secret Bearer.
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
9. User retries. Skill fetches the token, refreshes it, and execs `gws`.

## Agent-slot flow — DWD broker (no consent)

1. User asks the agent to act AS itself (`--scope agent`).
2. Skill POSTs `/api/agent/workspace-token` (`{ownerEmail}`, PSK Bearer).
3. The route (thin proxy) invokes the **mint Lambda**, which derives
   `agnt_<owner-localpart>@psd401.net` server-side and mints a ~1h access token
   via WIF → service-account signJwt → jwt-bearer exchange. Only the mint
   Lambda's role can perform the WIF leg (the frontend cannot).
4. If the agnt_ account doesn't exist yet, the mint Lambda returns 404
   `account-not-provisioned`; the skill emits `{status:"account-provisioning"}`
   exit 14 (the router has already kicked off auto-provisioning, #1233). No
   consent link — the user just retries in ~30 min.

## Runtime error contract

The skill emits a single JSON line on stdout (or a stderr message for exit 12)
and a non-zero exit code when auth isn't ready:

| Exit | Status | Slot | Meaning |
|---|---|---|---|
| 10 | `needs-auth` | user | No refresh token yet — consent URL in payload |
| 11 | `token-revoked` | user | `invalid_grant` from Google — consent URL in payload |
| 12 | (stderr) | agent | Transport error reaching the broker/Google (transient) |
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
3. The internal API key is auto-generated by CDK. Capture it into the
   Next.js app's `AGENT_INTERNAL_API_KEY` env var so the app can authenticate
   incoming skill requests.
4. Set `GOOGLE_WORKSPACE_CLIENT_ID` / `GOOGLE_WORKSPACE_CLIENT_SECRET` in the
   Next.js environment (same values as step 2).
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
6. **Agent gateway (#1230)** — populate ONE JSON secret with both the n8n MCP
   Server Trigger URL and its bearer token (again, no CDK context flag):
   ```bash
   aws secretsmanager create-secret \
     --name psd-agent/dev/agent-gateway \
     --tags Key=Environment,Value=dev Key=ManagedBy,Value=aistudio \
     --secret-string '{"url":"https://n8n.psd401.net/mcp/…/sse","token":"…"}'
   ```
   The psd-classified-evaluation skill reads it lazily; an absent/incomplete
   secret → exit 11 `not-configured`.
7. Deploy infra (AgentPlatformStack + FrontendStack) and the new agent image. No
   `-c` context flags are needed for the gateway or DWD config.
8. **Remediation (one-off, run manually):**
   - `scripts/agent-workspace/purge-agent-slot-tokens.ts` — delete all
     agent-slot refresh tokens (retired by the broker; one is known to hold a
     human's token). Dry-run by default; `--apply` to execute.
   - `scripts/agent-workspace/audit-user-slot-token-identity.ts` — audit
     user-slot tokens for identity mismatch (#1234) and purge the bad ones.

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
