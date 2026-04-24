---
name: psd-credentials
summary: Retrieve API keys and secrets from AWS Secrets Manager — never log, echo, or store credential values.
description: Safe credential access for agent skills. Retrieve shared (district-wide) or per-user secrets, list available credentials, or request provisioning of new ones. All reads are logged to telemetry (name only, never values). Credential values are cached in-memory for the session only — never written to workspace, S3, or conversation.
allowed-tools: Bash(node:*)
---

# psd-credentials

Retrieve API keys and secrets from AWS Secrets Manager for use in agent skills. This is the ONLY approved way for an agent to access credentials. Never hardcode secrets, never log credential values, never echo them back to the user.

**Identity.** All commands require `--user <caller-email>`. The caller's email appears in the `[caller: Name <email>]` line at the top of the user turn. Pass it verbatim.

## Commands

### `get` — retrieve a credential value

```bash
node /home/node/.openclaw/skills/psd-credentials/get.js \
  --user <email> \
  --name "<credential-name>"
```

Returns the credential value to stdout as JSON: `{"name":"...","value":"..."}`. Use the value in your skill logic. **Never** include the value in your response to the user. **Never** write it to a file. **Never** log it.

### `list` — list available credentials (names only, no values)

```bash
node /home/node/.openclaw/skills/psd-credentials/list.js \
  --user <email>
```

Returns `{"credentials":[{"name":"...","scope":"shared|user"},...]}`.

### `request_new` — request provisioning of a new credential

```bash
node /home/node/.openclaw/skills/psd-credentials/request_new.js \
  --user <email> \
  --name "<desired-credential-name>" \
  --reason "<why this credential is needed>" \
  [--skill-context "<which skill needs it>"]
```

Files a request in the admin queue. Does NOT create the credential — an admin must provision it. Returns `{"requestId":"...","status":"pending"}`.

## Naming Convention

Credentials are stored in AWS Secrets Manager with this path structure:

| Scope | Path | Who can read |
|-------|------|-------------|
| Shared (district-wide) | `psd-agent-creds/{env}/shared/{name}` | Any agent |
| Per-user | `psd-agent-creds/{env}/user/{email}/{name}` | Only the owning agent |

For per-user credentials, `{email}` is the caller email passed via `--user`, used verbatim as the path component.

When calling `get`, use just the `name` portion. The skill resolves the full path based on scope priority: user-specific first, then shared.

## Rules

1. **Never echo credential values** to the user in chat.
2. **Never write credential values** to workspace files, S3, or memory.
3. **Never log credential values** — the skill logs the name and user to telemetry, never the value.
4. **Cache in memory only** — the skill caches values for the session. Credential values do not persist across sessions.
5. **If a credential is not found**, suggest the user ask an admin to provision it, or use `request_new` to file a request.

## Examples

**Using an API key in a skill:**

```bash
# Get the credential
CRED=$(node /home/node/.openclaw/skills/psd-credentials/get.js --user hagelk@psd401.net --name "openai_api_key")
# Extract the value (in your skill logic, not in chat)
API_KEY=$(echo "$CRED" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).value)")
# Use it in an API call (the key never appears in your response)
curl -s -H "Authorization: Bearer $API_KEY" https://api.openai.com/v1/models
```

**Listing available credentials:**

```bash
node /home/node/.openclaw/skills/psd-credentials/list.js --user hagelk@psd401.net
```

**Requesting a new credential:**

```bash
node /home/node/.openclaw/skills/psd-credentials/request_new.js \
  --user hagelk@psd401.net \
  --name "google_workspace_api_key" \
  --reason "Needed for the psd-google-integration skill to access Calendar API" \
  --skill-context "psd-google-integration"
```
