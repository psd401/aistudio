# Shared Secret Provisioning

Admin workflow for creating and rotating district-wide shared secrets used by agent skills.

## Overview

Shared secrets (e.g., API keys for external services) are stored in AWS Secrets Manager at:

```
psd-agent-creds/{env}/shared/{name}
```

The admin UI at `/admin/agents/credentials` replaces the previous manual `aws secretsmanager put-secret-value` workflow.

## Access

- **Route**: `/admin/agents/credentials` > "Provision" tab
- **Role required**: `administrator`
- **IAM**: The ECS frontend task role has `secretsmanager:CreateSecret`, `PutSecretValue`, and `TagResource` on `psd-agent-creds/{env}/*`

## Provisioning a New Shared Secret

1. Navigate to `/admin/agents/credentials`
2. Click the **Provision** tab
3. Enter the credential name (lowercase, alphanumeric, hyphens, underscores; must start with a letter)
4. Paste the secret value
5. Click **Provision Secret**

If the secret does not exist, it is created with these tags:
- `Environment`: current deploy environment (dev/staging/prod)
- `ManagedBy`: `aistudio`
- `Scope`: `shared`

If the secret already exists, the value is overwritten (rotation).

## Audit Trail

Every provision/rotation writes an audit row to `psd_agent_credentials_audit` with:
- `credential_name`: the short name (e.g., `openai-api-key`)
- `scope`: `shared`
- `action`: `created` or `rotated`
- `actor_user_id`: the authenticated admin's user ID
- `details`: JSON with `secretId` and `environment`

View the audit log on the **Audit Log** tab.

## Credential Request Fulfillment

When an agent calls `credentials.request_new()`, a row is inserted into `psd_agent_credential_requests` and a Freshservice ticket is filed. To fulfill:

1. On the **Requests** tab, review pending requests
2. Provision the secret using the **Provision** tab (use the credential name from the request)
3. Return to **Requests** and click the checkmark to mark as fulfilled

## Naming Conventions

| Pattern | Example | Use Case |
|---------|---------|----------|
| `{service}-api-key` | `openai-api-key` | External API keys |
| `{service}-{purpose}` | `freshservice-webhook-secret` | Service-specific credentials |
| `{tool}-{qualifier}` | `web-fetch-allowlist-token` | Skill-specific secrets |

## Security Notes

- Secret values are **never** logged, returned to the client, or displayed after submission
- The ECS task role is already scoped to `psd-agent-creds/{env}/*` — no cross-environment access
- AgentCore execution role has **read-only** access to shared secrets; only the frontend admin action can write them
- All operations require an authenticated admin session verified server-side

## Deprecation of Manual AWS CLI Path

The previous workflow of running `aws secretsmanager put-secret-value` from the CLI is deprecated. Use the admin UI instead. Benefits:
- Audit trail with actor identity
- Consistent tagging
- No local AWS credential exposure
- Integrated with the request fulfillment queue
