# Unified Content Migration and Legacy Retirement

This runbook operates the final migration described by
[ADR-007](../architecture/adr/ADR-007-unified-content-and-repositories.md) and
issue [#1267](https://github.com/psd401/aistudio/issues/1267). It covers
inventory, resumable backfill, reconciliation, independent product cutovers,
rollback drills, the recovery window, and irreversible legacy retirement.

## Safety contract

- Deploy migration `155-unified-content-migration-retirement.sql` before the
  application or worker. Deploy migrations
  `159-unified-content-concurrency-recovery.sql` and
  `160-unified-content-migration-source-eligibility.sql` before resuming a
  backfill that was interrupted by database connection exhaustion.
- Keep every new setting at its default until the dry run and backfill evidence
  are reviewed.
- Never approve a reconciliation mismatch without comparing the immutable
  source and canonical object hashes, extraction counts/hashes, and recorded
  processor state.
- Do not set `CONTENT_LEGACY_RETIREMENT_ENABLED=true` until all product
  cutovers have been observed in the target environment.
- Do not use the CDK retirement context or database finalizer before a
  successful rollback drill and the complete recovery window.
- The finalizer is intentionally irreversible. Restore after it requires the
  normal Aurora/S3 backup procedure, not a settings rollback.

Migration control is restricted to application administrators. API-key scopes
do not grant UI administration, and Repository Manager/Nexus/Assistant
Architect cutovers do not change repository ACLs or capability checks.

## Controls and evidence

The Repository administration page contains the migration control panel. It
shows:

- discovered and already tracked source counts for Repository Manager items,
  Nexus legacy documents, and Assistant Architect `pdf-to-markdown` jobs;
- migration run status and durable cursor progress;
- canonical processing state and stale repositories;
- verified, mismatch, failed, and unrecoverable counts;
- legacy/canonical retrieval overlap and latency observations;
- the recovery-window deadline, rollback-drill state, and exact retirement
  blockers.

The `aistudio-<environment>-unified-content` CloudWatch dashboard contains the
same operational boundary:

- pending jobs, 24-hour failures, stale repositories, and estimated processing
  cost;
- verified/mismatched/failed/unrecoverable migration totals;
- 24-hour retrieval-shadow observations and average overlap;
- canonical processing, embedding, and Google connector queue depth/age,
  DLQs, worker errors, and duration.

Metrics use namespace `AIStudio/UnifiedContent` with the exact `Environment`
dimension. Logs contain IDs, hashes, status, duration, and error classes; they
must not contain source text, credentials, raw URLs, or signed URLs.

## 1. Deploy and inventory

1. Deploy the database migration first and verify the exact filename in
   `migration_log`.
2. Deploy the application and processing stack with every cutover and
   retirement setting still `false`.
3. In Repository administration, refresh the inventory. Record the three
   discovered counts in the change record.
4. Start a dry run for all source kinds. A dry run snapshots per-kind maximum
   IDs and counts but writes no canonical objects.
5. Refresh and confirm the dry run is `completed`. Retirement remains
   fail-closed without this durable record.

## 2. Backfill and reconciliation

1. Start a backfill for all source kinds. The scheduled unified-content worker
   advances bounded batches and persists each cursor.
2. If deployment or worker execution is interrupted, leave the existing run in
   place. The next scheduled invocation resumes after its durable cursor.
3. Observe canonical processing until the run completes and no active job is
   left in an intermediate state.
4. Run reconciliation. Each mapping compares:
   - source and canonical object SHA-256 when source bytes exist;
   - the complete canonical-text artifact SHA-256;
   - extraction record counts as segmentation telemetry, not a parity
     predicate, because the canonical tokenizer intentionally resegments
     legacy extracts;
   - canonical processing completion.
5. Reprocess retryable failures. Mark a source unrecoverable only when the
   original bytes and recoverable job input are genuinely absent.
6. For a deliberate accepted difference, record the approving administrator,
   time, and reason. Approval makes the row verified without deleting the
   original mismatch evidence.
7. Do not continue while any failure, unrecoverable source, or unapproved
   mismatch remains.

The migration worker has bounded database pressure. In dev the embedding
generator reserves five concurrent invocations and its SQS mapping has the same
maximum; production uses ten. The unified-content worker reserves one
invocation for scheduled maintenance in addition to its SQS maximum, so
outbox recovery and bounded migration batches cannot be starved by queue load.
Migration publication sets a four-minute PostgreSQL statement timeout inside a
270-second application transaction deadline for large repositories.

If a pre-cap deployment exhausted Aurora connections, migration 159 fences only
the exact exhausted generation and failed inspect rows carrying the known
connection-establishment errors. This includes a generation whose vectors were
fully written but whose final activation transaction failed. The scheduled
worker releases that marker after the old Lambda runtime has drained, and the
bounded recovery path either fills missing vectors or performs activation only.
It never re-arms arbitrary processing failures.

Repository connector sources explicitly classified `unsupported`, and
canonical targets created by the migration itself, are excluded from migration
inventory without deleting their audit rows. A missing legacy S3 object is
recoverable only when ordered legacy segments are present; the worker writes a
deterministic text source and records `recoveredFromLegacySegments`. Access
denials, network errors, and a source with neither bytes nor segments remain
fail-closed.

The route gate and irreversible finalizer use the same inventory and metric
denominators as the operator dashboard: excluded connector sources are reported
separately, not counted as discovered work requiring verification, and never
make a destructive retirement gate easier to satisfy for a supported source.

Repository items that already had a canonical version are shadow-audited
without replacing that version. Newly created migration repositories, items,
versions, jobs, and S3 objects are recorded separately so rollback never
deletes preexisting canonical data. Replaying a pre-hash canonical publication
first verifies the immutable item, processor, payload locator, and any existing
inline bytes. Object-backed producers send the expected SHA-256 checksum to S3,
then the transaction conditionally backfills a missing canonical-text hash
before returning the existing generation.

## 3. Shadow retrieval and product cutover

Enable `CONTENT_RETRIEVAL_SHADOW_ENABLED=true` while legacy Repository Manager
search remains authoritative. Compare overlap, result counts, and latency for a
representative traffic window. Shadow failures are observable but fail open and
never change the served result.

Cut over one product at a time:

1. `CONTENT_REPOSITORY_CUTOVER_ENABLED=true`
2. `CONTENT_NEXUS_CUTOVER_ENABLED=true`
3. `CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED=true`

The global `CONTENT_PLATFORM_ENABLED` and `CONTENT_READ_V2_ENABLED` settings
must also be enabled. After each product setting:

- execute its authenticated browser workflow;
- verify current repository access is enforced before retrieval;
- create a source and confirm no legacy processor/queue receives new work;
- verify canonical job completion, exact citation, and dashboard health;
- leave the other two product settings unchanged until the observation is
  accepted.

To roll back during this phase, disable only the affected product setting. The
legacy route remains available and canonical records remain for diagnosis.

## 4. Rollback drill and recovery window

Before the recovery deadline, start a rollback drill against the completed
backfill. The drill verifies the deletion plan and records
`snapshot.rollbackDrill=true`; it does not delete canonical data. A full
rollback, if needed, fences processing jobs, deletes only migration-created
canonical objects/rows, preserves preexisting canonical versions, and marks
the mappings rolled back. Explicitly excluded sources are retained as audit
evidence, skipped because they created no canonical data, and reported in the
completed rollback metrics instead of preventing the run from finishing.

After a successful drill:

1. restore/confirm all three product cutovers;
2. confirm every migrated mapping is verified;
3. confirm no migration run is queued/running;
4. wait until `recovery_window_ends_at` has elapsed;
5. repeat the authenticated regression workflows and dashboard review.

The recovery duration is controlled by
`CONTENT_MIGRATION_RECOVERY_DAYS` (default `7`). The effective deadline is the
latest of the completed backfill deadline, the most recent source verification,
and the most recent enablement of any product cutover. Reconciliation,
mismatch approval, reprocessing, or a cutover change therefore restarts the
quiet window instead of consuming it while work is still underway.

## 5. Retire routes and infrastructure

Set `CONTENT_LEGACY_RETIREMENT_ENABLED=true`. Legacy document and PDF-job
endpoints return authenticated `410 LEGACY_CONTENT_RETIRED` only when the
service independently confirms every safety gate. Before that, the setting
fails closed and legacy behavior remains available.

Validate the retirement infrastructure before deployment:

```bash
cd infra
bunx cdk synth --context retireLegacyContent=true
```

Deploy the resulting stacks through the normal reviewed deployment workflow in
two phases: first deploy both retirement-mode Frontend stacks so their task
definitions stop importing legacy CloudFormation exports, then deploy the
retirement-mode Processing and DocumentProcessing stacks that remove those
exports and resources. Do not deploy all retirement templates concurrently;
CloudFormation will reject deletion of an export that the previously deployed
Frontend stack still imports.

The retirement context keeps both legacy `DocumentProcessingStack` instances
in the assembly but conditions all of their queues, workers, roles, tables, and
exports out of the deployed templates. Keeping the empty stacks deployable is
important: merely omitting an existing CloudFormation stack from a CDK assembly
would leave its resources running. The same context conditions the old
ProcessingStack file/URL/Textract queues, workers, roles, topic, table, and
exports out of that template and removes their imports from the frontend task
definition. Canonical processing, embedding, Google sync, and the unified
dashboard remain. The same retirement assembly removes the temporary
whole-documents-bucket read grant used by the migration worker; canonical
`repositories/*` object access remains.

## 6. Finalize legacy PostgreSQL storage

Run the read-only preflight against the target database:

```bash
bun run db:finalize-content-retirement
```

It prints redacted connection identity, all durable gate evidence, and the
legacy row counts. It makes no changes unless both execution arguments are
present. After the retirement infrastructure deployment and final observation
window, execute:

```bash
bun run db:finalize-content-retirement -- \
  --execute --confirmation=RETIRE_LEGACY_CONTENT
```

The finalizer acquires the migration advisory lock and exclusive table locks,
rechecks every gate inside one transaction, deletes only legacy
`pdf-to-markdown` job rows, drops `document_chunks` and `documents` without
`CASCADE`, and writes the final counts to
`repository_legacy_retirement_events`. Any new run, mismatch, failure, missing
dry run, missing rollback drill, unelapsed recovery window, disabled cutover,
unexpected dependency, or missing audit evidence aborts the transaction.

The Nexus conversation-retention worker uses the same advisory lock and
detects the table retirement, so canonical repository cleanup continues after
the drop.

## 7. Post-retirement verification

- Run the finalizer preflight again; it must report the evidenced prior
  finalization and make no changes.
- Confirm every legacy mutation, read, query, link, delete, and job-status route
  returns `410` for an authenticated user and `401` for an unauthenticated
  caller.
- Confirm Repository Manager, Nexus attachments/Decision Capture, and Assistant
  Architect uploads and retrieval pass their authenticated workflows.
- Confirm no legacy CloudFormation resources or exports remain and no frontend
  environment value imports them.
- Confirm migration, canonical queue, embedding, connector, stale-index, cost,
  and retrieval-parity widgets are healthy.
- Preserve migration mappings, run records, retrieval observations according to
  operations retention, and `repository_legacy_retirement_events`
  indefinitely as retirement evidence.

If a problem is found after finalization, stop new ingestion with the
product-specific setting, preserve evidence, and use the standard Aurora/S3
restore process. Do not recreate empty compatibility tables or re-enable old
workers against a partially restored database.

## Dev readiness evidence (2026-07-27)

The dev backfill and reconciliation discovered 45 eligible legacy sources.
Forty-four migrated and verified, three unsupported connector records were
explicitly excluded, and no failed or unapproved mismatch remained. Nine
Assistant Architect PDF rows retained byte-identical immutable PDF hashes but
had expected legacy-markdown versus `pdf-text-v2` plain-text extraction drift;
an administrator approval recorded the processor evidence, both hashes, time,
and reason without deleting the mismatch history. A final reconciliation run
completed with `verified=44`, `mismatched=0`, and `failed=0`.

The rollback drill temporarily selected the legacy chunks for one verified
Repository item, proved the legacy read source existed, restored the exact
canonical version in the same transaction, and recorded
`snapshot.rollbackDrill=true`.

Retirement is not approved. One Nexus document is genuinely unrecoverable
because both its legacy object and chunks are absent. Retrieval shadowing and
all three product cutovers remain disabled, so the required observation and
seven-day quiet windows have not started. Restore or formally disposition the
missing source, complete the live shadow/cutover matrix, and let the full
recovery window elapse before enabling retirement or running the finalizer.
