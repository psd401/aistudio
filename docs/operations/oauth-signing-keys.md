# OIDC Signing-Key Operations

Issue #1285 establishes a production-safe signing boundary for the AI Studio
OAuth2/OIDC provider.

## Architecture and threat model

AI Studio deliberately uses two signing systems:

| Token class | Signer | Private-key property |
|---|---|---|
| OIDC access and ID tokens | RSA-3072 JWK set in AWS Secrets Manager | Exportable to the ECS task because `oidc-provider` requires a private JWK |
| Atrium delegated-agent tokens | AWS KMS asymmetric key | Non-exportable; signing occurs inside KMS |

The OIDC provider also uses a separate symmetric
`OIDC_COOKIE_SECRET` for its interaction, session, and state cookies. It must
not reuse `AUTH_SECRET` in production. `FrontendStackEcs` creates the cookie
secret and injects only its value into the ECS task at startup.

The OIDC key is not a fallback for the KMS signer. It is a separate,
OIDC-only key with a narrower purpose. Secrets Manager encrypts it at rest,
CloudTrail records reads and writes, and IAM grants `GetSecretValue` only to the
environment's ECS task role. The one-shot bootstrap Lambda has exact-secret
`PutSecretValue` and no ongoing application role. Never copy the secret into an
ECS environment variable, log it, or use it for session/delegation signing.

All ECS tasks read the same secret. Active and retiring public keys are exposed
through JWKS, while the active private key is first in the provider key set.
Provider state (interaction, session, grant, code, access token, and refresh
token) is database-backed, so ALB routing and task restarts do not break a flow.

## Provisioning and deployment

`AIStudio-FrontendStack-ECS-{environment}` creates and tags:

- `aistudio/{environment}/oauth/oidc-signing-jwks`
- `aistudio/{environment}/oauth/oidc-cookie-secret`
- `aistudio-oidc-key-bootstrap-{environment}`

The custom resource generates the first RSA-3072 key only when the secret does
not already contain a valid version-1 key set. It never overwrites an initialized
secret. The ECS service depends on the bootstrap resource, so a first deployment
cannot start against the placeholder.

Deploy in this order:

1. Apply database migration `129-oauth-production-hardening.sql`.
2. Run `cd infra && bunx cdk synth AIStudio-FrontendStack-ECS-Dev --context baseDomain=<domain>` (or Prod).
3. Deploy the frontend stack.
4. Check `/api/health`; `checks.oauthSigning.status` must be `healthy`. This
   verifies both the dedicated cookie key and the shared signing-key set.
5. Check `/.well-known/openid-configuration` and `/api/oauth/jwks`.
6. Complete a public-client S256 authorization-code flow and call one read and
   one write endpoint with the access JWT.

The OAuth route fails closed with HTTP 500 if the signing secret is absent,
unreadable, malformed, or lacks exactly one active private RSA/RS256 key.
There is no production local-key fallback.

On the first deployment that introduces the dedicated cookie secret, any
interactive OIDC authorization flow already in progress still carries cookies
protected by the former session secret. Those short-lived flows must restart
after deployment; issued access/ID tokens and future authorization flows are
unaffected. Schedule the rollout accordingly and verify a fresh S256 flow.

## Rotation

Rotation is staged to avoid a multi-task unknown-`kid` window. The new public
key is published as `standby` for six minutes (longer than the five-minute task
cache); only then do all tasks deterministically place it first for signing.
The default retiring-key overlap is two hours, exceeding the one-hour ID-token
and 15-minute access-token TTLs.

Dry-run and validate:

```bash
OIDC_SIGNING_JWKS_SECRET_ARN='arn:aws:secretsmanager:...' \
  bun run oauth:rotate-signing-keys
```

Apply:

```bash
OIDC_SIGNING_JWKS_SECRET_ARN='arn:aws:secretsmanager:...' \
  OIDC_KEY_OVERLAP_HOURS=2 \
  OIDC_KEY_ACTIVATION_DELAY_MINUTES=6 \
  bun run oauth:rotate-signing-keys --apply
```

Then:

1. Confirm the secret has one `active` key and one `standby` key with an
   `activateAfter` at least six minutes in the future. Do not print private JWK
   fields.
2. Before `activateAfter`, confirm JWKS contains both kids from multiple
   requests/tasks and newly issued JWTs still carry the old active kid.
3. After `activateAfter` plus one cache interval, confirm newly issued JWTs carry
   the staged kid and pre-rotation JWTs still verify.
4. On the next rotation, the former active key is normalized to `retiring`.
5. After `retireAfter`, a later rotation prunes expired retiring keys. It is
   also safe to remove them manually only after the maximum token lifetime,
   cache interval, and clock-skew allowance have all elapsed.

Do not delete the old key immediately. A JWKS overlap shorter than the maximum
issued-token lifetime causes valid in-flight tokens to fail.

## Incident response

### Health reports missing/unreadable OIDC cryptographic configuration

1. Confirm the task definition injects `OIDC_COOKIE_SECRET` from
   `aistudio/{environment}/oauth/oidc-cookie-secret`.
2. Inspect the ECS task log for `OIDC provider cryptographic health check
   failed` or `OIDC signing key set unavailable`.
3. Verify `OIDC_SIGNING_JWKS_SECRET_ARN` points to the environment's secret.
4. Verify the ECS task/execution roles have `secretsmanager:GetSecretValue` for
   the corresponding secret ARNs.
5. Verify tags are `Environment={environment}` and `ManagedBy=cdk`.
6. Validate the signing-key JSON structure without logging private fields.
7. Restore the most recent known-good secret version, then force a new ECS
   deployment or wait for the five-minute cache.

### Suspected OIDC private-key compromise

1. Rotate immediately with a short operationally safe overlap.
2. Revoke affected OAuth clients and grants; JWT middleware checks persisted
   token revocation and client activation on every request.
3. Review CloudTrail `GetSecretValue`/`PutSecretValue` events and ECS task access.
4. Replace compromised task credentials and force an ECS deployment.
5. Once all affected access/ID tokens have expired, remove the compromised
   retiring key.

### Refresh-token replay

Public-client refresh tokens rotate on every successful use. A replayed token is
rejected and its grant family is revoked by `oidc-provider`. Investigate the
client/device for token theft and require a new authorization flow.
