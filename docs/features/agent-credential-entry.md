# Agent credential entry — one-time secure links

Issue #1887. Agents collect user-held secrets (vendor API keys, personal
tokens) through a one-time entry page instead of asking the user to paste the
value into chat.

## Why

A read of 375 staff members' agent use (Aug–Oct 2026) found:

- ~15 people pasted Freshservice API keys into chat during first-time setup,
  because `psd-freshservice`'s missing-key prompt told the agent to ask for a
  paste and handed it a `psd-credentials put.js --value <pasted>` command.
- One agent asked a staff member to type a vendor single-sign-on password into
  chat, and they did.
- Pasted values land in `agent_message_content.content_text` with no redaction,
  so the secret outlives the conversation.

`SOUL.md` already forbade asking for a raw key in chat; the skill contradicted
it, and both prompts still pointed at `credentials.get` / `credentials.list`,
which were removed in #1353. Pre-existing pasted keys are out of scope — they
need rotating at the vendor, not redacting here.

## Shape

| Layer | Where | Purpose |
|---|---|---|
| Grammar | `lib/agent-credentials/name-grammar.ts` | The one definition of what a credential name may contain. Imported by the broker, the token layer, and the mint route — it carries no AWS SDK import, so sharing it costs the route nothing. A hand-copied regex would drift, and the drift surfaces as a failed write *after* the user has typed their secret. |
| Token | `lib/agent-workspace/consent-token.ts` | `kind: "credential_entry"` with a `cred` claim (the slot name). **15-minute** expiry, vs 24h for the OAuth kinds. Refuses to sign or verify without a slot name matching that grammar. |
| DB | `psd_agent_workspace_consent_nonces` (migration 187) | Widens the `token_kind` CHECK. Supplies the single-use nonce and the per-owner 20/hour rate limit. No PKCE verifier — there is no OAuth round trip. |
| API | `POST /api/agent/consent-link` (`kind:"credential_entry"`, `name:"<slot>"`) | Mints the link. Owner comes from the router-signed invocation context; `name` is required for this kind and rejected for every other. |
| Logic | `lib/agent-workspace/credential-entry.ts` | `inspectCredentialEntry` (read-only, for the GET render) and `submitCredentialEntry` (claim-then-write). |
| Action | `actions/agent-credential-entry.actions.ts` | The secret arrives as a server-action argument — i.e. in a POST body. |
| UI | `/agent-connect-credential` (public, off-nav) | Single password-type input. |
| Skill | `psd-credentials/request_entry.js` | Agent-side command that returns the link. `--value` is rejected. |

## Flow

1. A skill needs a secret only the user has (e.g. `psd-freshservice` exits 2
   with `freshservice_key_missing`).
2. The agent runs `psd-credentials/request_entry.js --name <slot>`, which POSTs
   `/api/agent/consent-link` with `kind:"credential_entry"`.
3. The agent sends the returned `url` on a line by itself — no markdown, no
   parens, no trailing period (markdown corrupts the JWT in Google Chat,
   incident 2026-04-27).
4. The user opens it, signs in if needed, and types the value into the
   password field.
5. The server action claims the nonce, then writes through
   `AgentCredentialBroker.put` to
   `psd-agent-creds/{env}/user/{email}/{slot}`.
6. The user re-asks; the skill now finds the credential.

## Security properties

- **Bound to one person.** The page compares the session email to the token's
  `sub` (case-insensitively) and refuses anyone else. The write always uses the
  token's owner, never the session's address.
- **Single-use.** The nonce is claimed with `UPDATE … WHERE consumed_at IS
  NULL RETURNING`, so concurrent submits have exactly one winner.
- **Claim before write.** The opposite ordering to `/agent-connect-data`, and
  deliberate: a replayable secret-entry form is worse than a user having to
  ask for a second link. A failed write therefore spends the link and says so.
- **The value never leaves the POST body.** Not in the URL, not in a log line,
  not in the action's return value. A value the broker would reject is caught
  *before* the claim, so a typo does not cost the user their link.
- **A failed audit row does not become a failed save.** `AgentCredentialBroker.put`
  writes the secret to Secrets Manager and the audit row to Postgres; they
  cannot be one transaction. An audit-insert failure is now logged rather than
  thrown, because reporting it as a failed write told the user their credential
  was not saved when it was — and cost them a one-time link for nothing.
- **A misconfigured deployment stops burning links.** If `ENVIRONMENT` is
  unset, nothing can be stored, so the submit path checks that *before*
  claiming the nonce and says plainly that this is our problem, not their link.
- **No secret in chat, ever — including after the fact.** `SOUL.md`, `USER.md`,
  `psd-credentials/SKILL.md`, `psd-freshservice/SKILL.md`, `psd-aistudio/SKILL.md`
  and `psd-github/SKILL.md` all state the rule, and the Freshservice prompt no
  longer carries a `--value` slot the agent could splice into. Critically, the
  "user pasted it anyway" fallback does **not** tell the agent to store the
  pasted value with `put.js`: doing so would copy the plaintext into the
  agent's own tool-call arguments and the session transcript, which is the same
  leak in a different table. The agent tells the user to rotate the key at the
  vendor and sends a fresh link.
- **A refusal does not leak the owner.** The wrong-user page says the link
  belongs to another account without naming it — whoever opened it was not the
  intended recipient.

## Tests

```bash
# Unit (jest)
bunx jest --config=jest.config.ci.js \
  tests/unit/agent-credential-entry.test.ts \
  tests/unit/credential-entry-form.test.tsx \
  tests/unit/agent-consent-link-route.test.ts

# Real sign/verify incl. the 15-minute expiry (Bun — consent-token imports
# pure-ESM jose, which next/jest cannot transform)
bun run test:smoke:agent-credential-entry

# Agent-side prompt contract
(cd infra/agent-image/skills/psd-freshservice && bun run test)

# E2E guard tier (no session, no seeded data)
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  bunx playwright test tests/e2e/agent-credential-entry.spec.ts

# E2E functional tier — see docs/guides/e2e-authenticated-testing.md
```

Submitting a **valid** value is not exercised by the E2E: the broker writes to
AWS Secrets Manager, which a local dev server does not have, and the one
environment where it would succeed is dev AWS — a green run would litter real
secrets. The success render is pinned by
`tests/unit/credential-entry-form.test.tsx` and the claim/write ordering by
`tests/unit/agent-credential-entry.test.ts`. The valid-value path is verified
agent-executed after deploy, like the Canva consent round-trip.
