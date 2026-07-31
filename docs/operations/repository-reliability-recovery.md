# Repository Reliability Recovery

This runbook restores one deployable state across development and production
without making ad hoc production changes.

## Non-negotiable deployment boundary

- All source, migrations, infrastructure, tests, and settings validation are
  committed first.
- The operator deploys the branch to development.
- Development migration, ingestion, retrieval, Nexus, Assistant, API, MCP, and
  rollback checks must pass before production promotion.
- Production inspection is read-only outside the normal deployment pipeline.
- Never run a migration file, update a Lambda package, redrive/purge a queue, or
  edit repository/model rows directly in production.

## Known emergency drift to reconcile

An earlier emergency intervention created temporary production drift:

- Migration `168-repository-item-cancelled-status.sql` was applied and recorded
  directly.
- Both legacy document-processor Lambdas were updated directly to a temporary
  package.
- Four stranded document-processing jobs were redriven and completed.
- Historical document-processing DLQ messages were audited and purged. That
  purge removed 149 messages and is irreversible; CloudWatch and job records
  are the remaining evidence.

Do not roll the working Lambda package backward before a normal deployment.
The safe reconciliation is a forward deployment from this repository:

1. Deploy this branch to development through the normal pipeline.
2. Confirm the migration runner applies 168 when absent, then 169 and 170.
3. Confirm both document processors synthesize from
   `infra/lambdas/document-processor-v2/index.ts` with the processor-local
   lockfile and handler `index.handler`.
4. Run the acceptance suite below in development.
5. Promote the exact tested commit and immutable build artifacts to production.
6. The production migration runner must recognize 168 as completed and apply
   only later pending migrations.
7. The production infrastructure deployment replaces the emergency Lambda code
   with the source-controlled package, eliminating drift.
8. Verify deployed Lambda code hashes against the promoted manifest using
   read-only inspection. Do not upload or mutate from the inspection session.

## Development gate

The health endpoint remains unhealthy while critical migrations, the
repository cancellation constraint, agentic model-admission columns, the
normalized Nexus binding table/constraint, or its skill foreign key are
missing. A new application revision must not receive traffic until this gate
passes.

Run:

```bash
bun run lint
bun run typecheck
cd infra && bunx tsc --noEmit
```

Then deploy development and verify:

1. `/api/healthz` returns 200 after migrations complete.
2. Model administration exposes explicit context-window, maximum-output, and
   Agentic Ready fields.
3. At least one accessible active Architect model in every enabled routing tier
   has authoritative pricing and limits and is marked Agentic Ready.
4. A direct-upload canary and a Google Drive canary each become `searchable`,
   with nonzero indexed-item and segment counts.
5. The canary unique fact is cited correctly through Repository Manager, Nexus,
   prompt-chain Assistant, agentic Assistant, API v1, MCP, and the service
   principal.

## Migration and cutover sequence

Raw content-platform settings are dependency-gated. Use this order:

1. `CONTENT_PLATFORM_ENABLED=true`
2. `CONTENT_DUAL_WRITE_ENABLED=true`
3. Complete migration dry run, backfill, reconcile, verification, and rollback
   drill. Every discovered legacy source must be accounted for.
4. `CONTENT_READ_V2_ENABLED=true`
5. `CONTENT_RETRIEVAL_SHADOW_ENABLED=true`; record representative successful
   shadow observations.
6. `CONTENT_REPOSITORY_CUTOVER_ENABLED=true`
7. `CONTENT_NEXUS_CUTOVER_ENABLED=true`
8. `CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED=true`
9. Keep dual-write during the recovery window.
10. Enable legacy retirement only after the recovery window has elapsed, the
    rollback drill is recorded, and all migration/readiness blockers are zero.

The server rejects an invalid order, uncovered sources, migration failures or
mismatches, stale indexes, and missing shadow evidence.

## Required acceptance tests

### Processing and publication

- Import 50 documents concurrently.
- Require one final active generation, complete embeddings, no false item
  failures, no generation older than 30 minutes in `building`, and empty
  processing/embedding DLQs.
- Replace and delete an item while extraction and embedding messages are in
  flight. Superseded messages must be acknowledged no-ops.
- Repeat deletion. It must succeed idempotently with pending/running work.

### Google Drive lifecycle

- Pause sync. The last verified snapshot must remain searchable.
- Resume. A reconciliation from the existing cursor must ingest a change.
- Destructive disconnect must require explicit confirmation, revoke the
  credential, make linked content unavailable, and block retrieval.

### Nexus and Assistants

- Select multiple repositories in Nexus, reload, and continue the conversation.
  Bindings and citations must persist.
- Revoke one repository ACL. The next turn must return
  `REPOSITORY_BINDING_INACCESSIBLE`.
- Start from a skill, project, and Assistant execution; reopen each conversation
  directly in Nexus and verify its durable repository context.
- An unready repository must return `REPOSITORY_NOT_READY`; a disconnected one
  must return `REPOSITORY_DISCONNECTED`.
- Agentic Assistant execution must fail with an actionable model-configuration
  error when no admitted model exists and must succeed when an eligible model
  is configured.

## Production promotion and verification

Promotion is performed by the operator only after development sign-off.

Immediately after deployment, use read-only checks to confirm:

- critical schema gate is healthy;
- migration inventory has no uncovered or mismatched source;
- canary repositories report a serving generation and nonzero segment count;
- agentic-ready model count is nonzero for every enabled route;
- document, canonical-processing, embedding, and Google sync DLQs are empty;
- no stalled building generations or active unsearchable repositories exist;
- Nexus binding rate and retrieval zero-result rate are being emitted;
- the same unique canary fact is returned with citations on every surface.

If a gate fails, stop the rollout and use the pipeline rollback to the previous
tested application artifact. Do not manually reverse migrations or patch
production resources.
