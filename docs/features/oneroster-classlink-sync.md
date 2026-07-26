# ClassLink OneRoster synchronization

Status: v1 ingestion foundation and administrator control surface implemented by Epic
[#1308](https://github.com/psd401/aistudio/issues/1308), Issue
[#1310](https://github.com/psd401/aistudio/issues/1310), and Issue
[#1311](https://github.com/psd401/aistudio/issues/1311). Role mapping, room
provisioning, and reporting are separate workstreams.

## Scope and data boundary

The nightly Lambda imports one tenant's complete `orgs`,
`academicSessions`, `courses`, `classes`, `users`, and `enrollments`
collections into the dedicated `oneroster_*` tables. It also normalizes class
terms and OneRoster user roles into their relationship tables.

- The stored model follows the OneRoster 1.2 schema introduced by migration
  141. API requests default to the widely deployed OneRoster 1.1 REST path;
  `v1p2` is reserved behind `ONEROSTER_API_VERSION`.
- Demographics, metadata, resources, and other unnecessary student data are
  neither requested nor persisted.
- Roster email is normalized to lowercase for the later cross-system user join.
- This Lambda never writes application users, application role grants,
  capabilities, API-key scopes, rooms, or assistants. In particular, ingestion
  cannot grant or revoke the administrator role.
- The Lambda modifies only the dedicated OneRoster tables and its internal
  `ONEROSTER_LAST_PERM_REV` setting.

The implementation follows ClassLink's guidance to pull the bulk collections
with a 10,000-record page size and verify `x-count` and `x-total-count`.
[ClassLink's current best-practices article](https://help.classlink.com/articles/Knowledge/rs-data-best-practices)
is the protocol source of truth.

## Architecture

`ProcessingStack` deploys `psd-oneroster-sync-{environment}` as an isolated
Node.js 20 ARM64 Lambda in private subnets with NAT egress:

1. EventBridge invokes it nightly at 10:00 UTC. A future admin action can invoke
   the same function asynchronously through `lib/roster/trigger.ts`.
2. Runtime configuration is read from the `settings` table. Credentials are
   read from a separately managed Secrets Manager secret.
3. The HTTP client stages each complete collection in memory, using only the
   requested fields.
4. Each collection reconciles in its own PostgreSQL transaction. Upserts and
   absence-driven deactivation commit together.
5. The persistent `x-perm-rev` checkpoint advances only after all six
   collections apply successfully.

Reserved concurrency is one so manual and scheduled full snapshots cannot race.
Database writes are chunked at 4,000 rows, below the required 5,000-row maximum.

## Authentication modes

`ONEROSTER_AUTH_MODE` has exactly two valid values. There is no generic OAuth2
client-credentials flow or token endpoint.

### Direct OAuth1 (`oauth1`)

The Lambda signs each complete request URL, including `fields`, `limit`, and
`offset`, with OAuth1 HMAC-SHA1. The secret JSON shape is:

```json
{
  "consumerKey": "...",
  "consumerSecret": "..."
}
```

Set `ONEROSTER_BASE_URL` to the district Roster Server origin supplied by
ClassLink, without `/ims/oneroster/...`.

### ClassLink OAuth2 Proxy (`proxy`)

The Lambda sends the static, non-expiring Partner Portal access token as a
Bearer token. The secret JSON shape is:

```json
{
  "bearerToken": "..."
}
```

Set `ONEROSTER_BASE_URL` to the application-specific proxy prefix, for example:

```text
https://oneroster-proxy.apis.classlink.com/proxy/v1p0/{applicationId}
```

Use the hostname and application ID currently shown by ClassLink rather than
copying the example literally. The Lambda appends the selected OneRoster API
path. ClassLink documents both the Partner Portal credential workflow and the
static Bearer behavior in
[Accessing Roster Server Data](https://help.classlink.com/articles/Knowledge/pp-access-rs-data);
its published API definition exposes the application-prefixed
[proxy collection routes](https://oneroster-proxy.apis.classlink.com/docs/index.html).

### Obtain credentials

For either mode:

1. Sign in to the ClassLink Partner Portal and choose **Clients** →
   **View By Tenant**.
2. Open the PSD tenant, select the connected application, and select the key
   icon.
3. For OAuth1, capture the district endpoint, key, and secret. For proxy mode,
   capture the application ID, proxy host, and access token.
4. Put the corresponding JSON object in an AWS secret named with the deployment
   pattern `aistudio-{environment}-oneroster-*`. Tag it
   `Environment={environment}` and `ManagedBy=manual`. Do not place credentials
   in the settings table, source control, shell history, or logs.
5. Store that secret's full ARN in
   `ONEROSTER_CREDENTIALS_SECRET_ARN`.

The Lambda IAM role can read only the Aurora credential secret and the
environment-specific `aistudio-{environment}-oneroster-*` secret family; the
credential read also requires the matching `Environment` resource tag.

## Settings

All values are database-first. The Next.js accessors in
`lib/roster/settings.ts` and the isolated Lambda keys in
`infra/lambdas/oneroster-sync/config.ts` must remain synchronized.

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ROSTER_SYNC_ENABLED` | yes for scheduled runs | `false` | Exact value `true` enables the nightly rule's work. Manual invocation can run while disabled. |
| `ONEROSTER_BASE_URL` | yes | none | HTTPS direct-server origin or application-specific proxy prefix. |
| `ONEROSTER_AUTH_MODE` | yes | none | `oauth1` or `proxy`. |
| `ONEROSTER_CREDENTIALS_SECRET_ARN` | yes | none | Full ARN of the scoped secret described above. |
| `ONEROSTER_API_VERSION` | no | `v1p1` | `v1p1` or `v1p2`. |
| `ONEROSTER_PAGE_SIZE` | no | `10000` | Integer from 1 through 10,000. |
| `ONEROSTER_LAST_PERM_REV` | internal | none | Last fully applied ClassLink revision; do not edit during normal operation. |
| `ONEROSTER_SYNC_STATUS` | internal | none | Sanitized queued/running/terminal status used by `/admin/rosters`; do not edit during normal operation. |

Set the URL, auth mode, secret ARN, version, and page size before enabling the
schedule. A missing or incomplete configuration safely skips the invocation.

## Administrator control surface

`/admin/rosters` is administrator-only at both the page and server-action
layers. It has three tabs:

- **Settings** stores the six operator-managed values above in one database
  transaction. The base URL must use HTTPS, the auth mode is limited to
  `oauth1` or `proxy`, the API path is limited to `v1p1` or `v1p2`, the page
  size is 1–10,000, and the secret ARN must match the current deployment's
  environment, region, account, and `aistudio-{environment}-oneroster-*`
  family. There is intentionally no token URL or generic client-credentials
  configuration.
- **Sync** shows active/inactive totals and last-sync timestamps for all six
  collections. **Sync now** writes a unique queued run ID, invokes the same
  Lambda used by EventBridge, and polls `ONEROSTER_SYNC_STATUS` until that run
  succeeds, fails, skips, or times out. Nonterminal status rows older than the
  one-hour Lambda dispatch-and-execution window are shown as timed out and no
  longer block a manual retry. Lambda's implicit asynchronous retries are
  disabled so a persisted terminal failure is final; operators retry manually,
  and the nightly schedule remains the unattended retry path. A client-side
  in-flight ref prevents two same-tick clicks from dispatching duplicate runs.
- **Roster browser** lazily reads schools, their classes (including active term,
  teacher-of-record, and student count), and each class's student enrollments.
  It never edits sync-owned rows.

The status value contains timestamps, state, collection counts, and a bounded
sanitized error message only. It never contains credentials, response bodies,
or roster records. Failure to write dashboard status does not fail an otherwise
safe roster reconciliation; Lambda error and staleness alarms remain the
fallback.

## Consistency and deletion invariants

These are operational safety contracts, not best-effort behaviors:

- Absence deactivation happens only after a complete, internally consistent,
  non-empty collection pull.
- An upstream error, invalid response, premature page ending, inconsistent
  count, unexpectedly empty collection, or DB failure preserves that
  collection's last-known-good rows.
- `status: tobedeleted` is deactivated explicitly. Records absent from a
  confirmed-complete collection are then deactivated in the same transaction.
- A changed `x-perm-rev` anywhere in the batch discards every staged collection
  and restarts from the beginning. The retry is bounded at three full attempts.
- If the first collection returns the last fully applied persistent revision,
  the run is a successful no-op.
- A partial run does not advance the revision checkpoint, even when other
  collections succeeded.

ClassLink documents `x-perm-rev` as a batch-wide persistent consistency signal
and recommends discarding already pulled data if it changes. The same guidance
notes that delta-only syncs can miss purged records, which is why this
implementation intentionally performs full nightly pulls.

The integration does not currently send OneRoster `filter` expressions. If a
future change adds them, ClassLink's non-parenthesized Boolean grouping must be
tested explicitly: operations are split into `AND` groups separated by `OR`
operators.

## Retries and failure behavior

HTTP 429 and 502 responses retry with capped exponential backoff starting at one
second, up to one second of jitter, a maximum 32-second base delay, and at most
five retries. A valid `Retry-After` delay wins when it is longer. Other
non-success responses fail the collection without logging the response body.
This follows ClassLink's
[429/502 guidance](https://help.classlink.com/articles/Knowledge/oneroster-api-request-limits).

A partial run publishes collection metrics and then throws. This preserves the
per-collection data that succeeded while ensuring Lambda's built-in `Errors`
metric and alarms reflect the incomplete snapshot.

## Monitoring and operation

CloudWatch namespace: `AIStudio/RosterSync`

- Run metrics: `SyncRunSucceeded`, `SyncRunFailed`, `RevisionRestarts`
  (`Environment` dimension).
- Collection metrics: `RecordsSynced`, `CollectionsFailed`,
  `RecordsDeactivated`, `RecordsTotal` (`Environment` and `Collection`
  dimensions).
- `psd-oneroster-sync-failure-{environment}` alarms on any errored invocation
  during a day.
- `psd-oneroster-sync-staleness-{environment}` alarms after approximately 48
  hours without a successful run, including missing metrics.
- Both alarms route to the shared
  `aistudio-{environment}-monitoring-alarms` topic.
- Logs are in `/aws/lambda/psd-oneroster-sync-{environment}`. Structured log
  records contain collection names and counts, never credentials or raw roster
  records.

Manual invocation uses an asynchronous event:

```json
{
  "trigger": "manual",
  "requestedByUserId": 123,
  "runId": "3a67d19e-..."
}
```

Use `triggerOneRosterSyncNow()` from application code so the deterministic
function name, run ID, and audit payload stay consistent. The ECS task role has
invoke permission only for that named function (alongside its existing explicit
Lambda grants).

## Verification

The integration requires no live PSD credential for normal CI:

```bash
cd infra/lambdas/oneroster-sync
bun install --frozen-lockfile
bun test
bun run build

# Optional local PostgreSQL transaction/rollback coverage
ONEROSTER_DB_TEST_URL=postgresql://... bun test db.integration.test.ts

cd ../../..
bun run lint
bun run typecheck
bun run build

cd infra
bun test -- --runInBand
bunx cdk synth
```

The mocked HTTP suite covers both auth modes, bulk paging and headers, revision
no-op/change behavior, retries, deletion normalization, empty/error
preservation, transaction isolation at the sync boundary, changed fields, and
checkpoint behavior.

## Rollout and rollback

Roll out disabled:

1. Deploy the Processing stack and confirm the Lambda, nightly rule, alarms,
   IAM policy, VPC configuration, and log group.
2. Create the scoped credential secret and populate the non-secret settings.
3. Run a manual sync. Compare per-collection totals with ClassLink and inspect a
   sample of lowercased emails and sourced-ID relationships.
4. Confirm no `users`, application role, room, assistant, or demographics data
   changed.
5. Set `ROSTER_SYNC_ENABLED=true`.

To stop ingestion, set `ROSTER_SYNC_ENABLED=false` in `/admin/rosters`.
Existing roster rows remain
as the last-known-good snapshot. For a code rollback, deploy the previous
Processing stack version; migration 141 and the `oneroster_*` tables are
additive and may remain in place. Do not clear rows or the revision checkpoint
as part of routine rollback. If a credential may be exposed, rotate it in
ClassLink and Secrets Manager before re-enabling the integration.

To remove only the administrator UI, remove its `ADMIN_SECTIONS` registry entry
and route. The settings and last-known-good roster snapshot can remain. Older
Lambda versions ignore `ONEROSTER_SYNC_STATUS`; removing that internal settings
row is optional and must not be coupled to roster-row deletion.
