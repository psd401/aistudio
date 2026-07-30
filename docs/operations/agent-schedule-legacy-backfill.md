# Agent schedule legacy backfill

This runbook repairs schedule records and EventBridge Scheduler targets created
before the owner-bound schedule-reference contract. It applies to
`psd-agent-schedules-{dev,prod}` and the `psd-agent-{dev,prod}` Scheduler
groups.

The migration is additive and idempotent:

- schedule rows gain `version`, `ownerEmail`, `schedulerExpression`,
  `workspacePrefix`, and a missing `dmSpaceName`;
- Scheduler target input becomes only `ownerEmail`, `scheduleId`, `version`,
  and the `<aws.scheduler.scheduled-time>` context token;
- existing Scheduler expressions, time zones, state, flexible time windows,
  and delivery settings are preserved.

Do not manually run schedules or change their cadence while performing this
repair. In particular, keep the dev forklift schedules disabled and preserve
Morning Dispatch schedule `5123b45b` at `0 6 * * MON-FRI`.
The runtime accepts this preserved eight-character hexadecimal ID for
invocation, update, and deletion; newly created schedules continue to use
UUIDs.

## Deployment order

1. Run the full infrastructure build and synth before deploying:

   ```bash
   cd infra
   bun run build
   bunx cdk synth --all --no-lookups --context baseDomain=example.com
   ```

2. Deploy the Agent Platform stack before the Frontend stack. The Agent
   Platform stack publishes the corrected worker and IAM policy. The Frontend
   stack's versioned custom resource invokes it after the lock-aware ECS
   service is steady.

3. Migrate and verify dev before prod.

The worker starts with DynamoDB records, follows paginated continuations, and
then migrates Scheduler targets. It retries IAM `AccessDeniedException` with
exponential backoff for eight attempts; Lambda asynchronous retries and the
alarm-backed DLQ remain the outer safety net.

## Remove stale pre-fix DLQ invocations

The old dev and prod backfill payloads failed before the IAM fix and must not be
redriven. For each environment, inspect the messages in
`psd-agent-async-dlq-{env}`, confirm the message is the stale
`psd-agent-schedule-target-backfill` invocation, and delete that exact message
by receipt handle. Do not redrive it and do not purge unrelated agent failures
from the shared queue.

After deletion, verify the queue contains no stale backfill invocation. Preserve
and triage any unrelated message according to the normal agent DLQ procedure.

## Explicit fresh invocation

The versioned Frontend custom resource invokes the worker on both create and
update. If an operator must repeat the idempotent migration, invoke the
corrected function with a fresh records-phase payload:

```bash
aws lambda invoke \
  --function-name psd-agent-schedule-target-backfill-dev \
  --invocation-type Event \
  --cli-binary-format raw-in-base64-out \
  --payload '{"RequestType":"Update","phase":"records","migrationVersion":"legacy-schedule-records-and-targets-v4"}' \
  /tmp/agent-schedule-backfill-dev.json
```

Repeat for prod only after dev verification, changing both `dev` occurrences
to `prod`. A `202` status confirms acceptance, not completion.

## Verification

For each environment:

1. Inspect `/aws/lambda/psd-agent-schedule-target-backfill-{env}` until the
   final targets-phase page reports `continuationQueued=false`.
2. Confirm every user schedule row has:
   - `version >= 1`;
   - `ownerEmail` equal to the `userId` partition key;
   - `schedulerExpression` derived from the unchanged `cronExpression`;
   - a trusted `workspacePrefix` and valid `dmSpaceName`.
3. Confirm every Scheduler target input contains only the owner-bound reference
   and scheduled-time token. Confirm the schedule's expression, time zone, and
   state are unchanged.
4. Confirm no new message entered `psd-agent-async-dlq-{env}` and no
   `schedule_record_backfill_invalid_record` or
   `schedule_target_backfill_invalid_target` marker remains unexplained.
5. From the agent, run `psd-schedules list`. It must return the owner's
   schedules without HTTP 409 and without a degraded flag after migration.

For prod, additionally wait for the next weekday 6:00 AM PT Morning Dispatch
fire. Confirm `Scheduled task completed` in
`/aws/lambda/psd-agent-cron-prod` and confirm Chat delivery.

## Rollback

The row changes add missing authoritative fields, and the target changes use a
minimal input understood by the hardened cron Lambda. Do not remove migrated
fields as an operational rollback. Revert and redeploy the application/Lambda
code if required; retain the migrated data and investigate any per-record
failure before another fresh invocation.
