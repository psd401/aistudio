# Decommission runbook: scheduled assistant executions (#1322)

Persisted teardown steps for the legacy AI Studio scheduling feature (schedule an
Assistant Architect run → EventBridge → Lambda → internal API → email + in-app
notification). The application code, DB tables, CDK stacks, and Lambdas were removed
in PR #1323; superseded by the OpenClaw agent platform's `psd-schedules` skill.

**Why this doc exists:** removing the `SchedulerStack` / `EmailNotificationStack`
registrations from `infra/bin/infra.ts` only stops *future* synthesis from including
them. The already-deployed CloudFormation stacks (`AIStudio-SchedulerStack-{Env}`,
`AIStudio-EmailNotificationStack-{Env}`) — and their EventBridge schedules, Lambdas,
SQS queue, and ongoing cost — are **not** touched by `cdk deploy --all`. They must be
deleted explicitly, in order, after this PR merges.

> **Use `aws cloudformation delete-stack`, NOT `cdk destroy`.** Because the two stacks
> are no longer registered in the CDK app, `cdk destroy AIStudio-SchedulerStack-{Env}`
> matches **no** stack in the synthesized assembly and silently exits without deleting
> the deployed CloudFormation stack — an operator would believe teardown happened while
> the Lambdas, SQS queue, schedules, and cost remain. Delete them by name through the
> CloudFormation API instead (step 3). (Alternatively, `cdk destroy` from a checkout of
> the pre-removal commit would also work, but the AWS CLI path is simpler and has no
> dependency on CDK app state.)

Run these steps per environment (`Dev` shown; repeat for `Prod` with the `-Prod`
suffix and a fresh pre-flight).

## Order matters

### 1. Pre-flight (awareness only)
Count active legacy schedules so you know what you are retiring:
```sql
SELECT count(*) FROM scheduled_executions WHERE active;
```
All schedules are Hagel-owned and are re-created as OpenClaw agent schedules by hand
(decision 1.1). No owner notification is required. Prod counts were unknown at
authoring time — run this against prod before the prod teardown.

### 2. Deploy `FrontendStack-ECS` FIRST
This drops the `{env}-NotificationQueueUrl` CloudFormation import. CloudFormation
blocks deleting an export while it is still imported, so the frontend stack must land
**before** the two stacks are destroyed. The migration Lambda drops the three tables
(`user_notifications`, `execution_results`, `scheduled_executions`) in the same deploy
via migration `132-decommission-scheduled-executions.sql`.

```bash
cd infra
bunx cdk deploy AIStudio-FrontendStack-ECS-Dev --context baseDomain=<domain>
# For a real release use the canonical full deploy command, not this single stack.
```

### 3. Delete the two retired stacks (explicit — `deploy --all` will NOT do this)
They are removed from `infra/bin/infra.ts`, so `cdk deploy --all` no longer targets
them — and `cdk destroy <name>` no longer finds them either (see the warning above).
Delete them by name via the CloudFormation API, then wait for completion. Resources
with `DeletionPolicy: Retain` (the SES identity, the internal-api-secret) survive the
delete and are handled in step 4:
```bash
REGION=us-east-1   # the deployment region

aws cloudformation delete-stack --region "$REGION" \
  --stack-name AIStudio-SchedulerStack-Dev
aws cloudformation delete-stack --region "$REGION" \
  --stack-name AIStudio-EmailNotificationStack-Dev

# Block until each delete finishes (surfaces DELETE_FAILED if an export is still in use —
# if so, confirm step 2 landed and re-run):
aws cloudformation wait stack-delete-complete --region "$REGION" \
  --stack-name AIStudio-SchedulerStack-Dev
aws cloudformation wait stack-delete-complete --region "$REGION" \
  --stack-name AIStudio-EmailNotificationStack-Dev
```

### 4. Manual cleanup (NOT CloudFormation-managed)
- **Orphaned EventBridge schedules.** The executor Lambda created runtime entries
  `aistudio-{env}-schedule-{id}` in the **default** scheduler group; stack destroy does
  not remove them:
  ```bash
  aws scheduler list-schedules --group-name default
  # delete every aistudio-<env>-* entry, e.g.:
  aws scheduler delete-schedule --group-name default --name aistudio-dev-schedule-<id>
  ```
- **SES identity — KEEP IT.** The SES identity has `RemovalPolicy.RETAIN` and survives
  the destroy. Do **not** delete it (decision 1.3 — used by other systems outside this
  repo). Only the stack-owned config set `aistudio-{env}-email-config` goes away with
  the stack.
- **Retained Secrets Manager secret.** `aistudio-{env}-internal-api-secret` was removed
  from CDK (decision 1.4) but is retained on destroy; delete it manually:
  ```bash
  aws secretsmanager delete-secret --secret-id aistudio-dev-internal-api-secret \
    --force-delete-without-recovery
  ```

### 5. Prod promote
Prod inherits all of the above. Re-run the pre-flight count and the manual cleanup
against prod after the prod deploy + destroy.

## Explicitly out of scope (do NOT touch)
The OpenClaw agent scheduling stack is a fully independent system and stays:
`agent_scheduled_runs` / `agent_failures` / `agent_identities` tables, the
`psd-agent-schedules-{env}` DynamoDB table, the EventBridge group `psd-agent-{env}`,
the `psd-agent-scheduler-invoke-{env}` role, the `agent_cron` Lambda, and the
`psd-schedules` skill. The retained SES identity is likewise shared and must survive.
