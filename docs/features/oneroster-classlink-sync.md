# ClassLink OneRoster synchronization

Status: v1 ingestion, administrator controls, optional role reconciliation,
teacher-managed rooms, student enforcement, and promotion reporting are
implemented by Epic [#1308](https://github.com/psd401/aistudio/issues/1308) and
its linked workstreams, including reporting Issue
[#1315](https://github.com/psd401/aistudio/issues/1315).

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
- Collection ingestion never writes application users, role grants,
  capabilities, API-key scopes, rooms, or assistants. A separate, default-off
  post-sync pass may write source-owned `student` and `staff` role grants as
  described below; it cannot grant or revoke the administrator role.
- Collection reconciliation modifies only the dedicated OneRoster tables and
  internal sync settings. The optional role pass additionally modifies
  `user_roles.source='oneroster'` rows and bumps `users.role_version` for users
  whose grants changed.

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
| `ROSTER_ROLE_SYNC_ENABLED` | no | `false` | Exact value `true` enables the best-effort application-role pass after a fully successful scheduled sync. Manual sync never changes roles. |
| `ONEROSTER_BASE_URL` | yes | none | HTTPS direct-server origin or application-specific proxy prefix. |
| `ONEROSTER_AUTH_MODE` | yes | none | `oauth1` or `proxy`. |
| `ONEROSTER_CREDENTIALS_SECRET_ARN` | yes | none | Full ARN of the scoped secret described above. |
| `ONEROSTER_API_VERSION` | no | `v1p1` | `v1p1` or `v1p2`. |
| `ONEROSTER_PAGE_SIZE` | no | `10000` | Integer from 1 through 10,000. |
| `ONEROSTER_LAST_PERM_REV` | internal | none | Last fully applied ClassLink revision; do not edit during normal operation. |
| `ONEROSTER_SYNC_STATUS` | internal | none | Sanitized queued/running/terminal status used by `/admin/rosters`; do not edit during normal operation. |

Set the URL, auth mode, secret ARN, version, and page size before enabling the
schedule. A missing or incomplete configuration safely skips the invocation.

## Optional roster-driven application roles

`ROSTER_ROLE_SYNC_ENABLED` is deliberately default-off. When its exact value is
`true`, a fully successful **scheduled** roster sync runs one additional
transaction:

- Active OneRoster `student` roles map to AI Studio `student`.
- Active OneRoster `teacher`, `aide`, `proctor`, and `administrator` roles map
  to AI Studio `staff`. Recognized vendor staff/administrator spellings also
  map to `staff`; family roles and unknown values fail closed and grant nothing.
- Roster email joins application users with
  `lower(users.email) = lower(oneroster_users.email)`. Roster people who have
  never signed in are skipped without error.
- New grants use `user_roles.source='oneroster'`. The transaction removes only
  stale `oneroster` rows; `manual` and `group-sync` rows are invisible to it.
- A mapped role already held from another source is left under that source.
  Because `(user_id, role_id)` is unique, if that owner's eligibility later
  disappears while the other provider still computes the role, the current
  owner atomically transfers its own row to the surviving provider instead of
  dropping access. Provenance-only transfers do not bump `role_version`;
  effective grant/revoke changes increment it once per affected user.
- The application `administrator` role is not a possible mapping and is
  structurally excluded from deletion. This path therefore cannot invoke the
  last-administrator case. Any future change that could remove administrator
  must use the shared `LAST_ADMIN_GUARD_LOCK_KEY` advisory-lock discipline.

The pass runs only after all six roster collections are confirmed successful,
including a successful unchanged-revision night. It does not run for manual
syncs. Its own failure is logged and rolled back but does not fail or undo the
good roster snapshot. Disable the flag to stop future role changes immediately.

## Roster email-match readiness report

After a complete manual sync, run the read-only promotion report against the
target database:

Provide `DATABASE_URL` through the approved environment/secret-injection
mechanism rather than typing credentials into shell history, then run:

```bash
DB_SSL=true bun run scripts/db/report-roster-email-match.ts
```

The report uses a single-connection `postgres.js` client and issues only
`SELECT` statements. It reports:

- the active OneRoster-user match rate against `users` with
  `lower(oneroster_users.email) = lower(users.email)`, split between the
  `@edtools.psd401.net` student domain and `@psd401.net` staff domain;
- a bounded, identifier-redacted sample of unmatched roster email domains and
  primary roles;
- case-insensitive duplicate active roster emails; and
- active enrollments that reference a missing or inactive roster user or class.

Exit `0` means there are active roster users and the report found no unmatched
emails, unexpected/missing domains, duplicate roster emails, or referential
drift. Exit `1` means findings need an operator decision. Exit `2` means the
report itself failed and its output is not valid promotion evidence.

### Promotion decision rule

Application users are provisioned lazily, so a roster-wide match rate below
100% can consist entirely of people who have never signed in. Treat the
percentage as a readiness signal, not an automatic deletion or remediation
instruction:

- **Investigate** either student or staff match rate below **95%**, or a drop of
  more than **5 percentage points** from the accepted dev/manual-sync baseline.
  Before proceeding, confirm sampled unmatched people are expected
  never-signed-in users rather than a domain, casing, whitespace, or sync
  defect. Record only aggregate counts and the explanation in delivery
  evidence.
- **Block role-sync and room-enforcement promotion** if any unexpected/missing
  email domain, duplicate roster email, or active-enrollment referential drift
  remains. Correct the upstream/configuration problem, run another confirmed
  complete sync, and rerun the report.
- A sub-95% cohort may proceed only with an explicit, documented operator
  exception showing that the gap is expected lazy provisioning and that the
  sampled domains/roles align with the district roster. Never weaken the
  lowercase join or manufacture application users to improve the number.

Sample emails and sourced IDs are redacted by default. If an identifier-level
investigation is necessary, rerun from a private, non-captured operator session
with `ROSTER_REPORT_INCLUDE_PII=true`. That opt-in output contains student or
staff identifiers and is FERPA-sensitive: do not paste it into issues, pull
requests, CI artifacts, or shared logs. Promotion evidence should contain only
aggregate counts, exit code, investigation result, and any approved exception.

## Teacher-managed rooms

Migration 157 adds application-owned `rooms`, `room_classes`, `room_members`,
and `room_resources` tables. They do not change the ownership of sync data:

- A room is owned by its creator and is soft-deleted with `is_active=false`.
  Only that creator or an application administrator may update or delete it.
- `room_classes.class_sourced_id` deliberately has no FK to the sync-owned
  OneRoster tables. A ClassLink refresh or soft deletion cannot cascade into an
  application-owned room.
- Section membership is dynamic. `lib/rooms/membership.ts` resolves the union of
  active students in linked active sections and explicit room-member emails.
  It lowercases both sides of email comparisons.
- Explicit students are stored by lowercased email, not by `users.id`, so a
  teacher can compose a room before a student first signs in.
- `room_resources` admits only `resource_type='assistant'` in v1. The resource
  ID uses the same text representation as `resource_access_grants`.

The teacher surface is `/rooms/manage`, gated at both the layout and server
action layers by the `rooms-manage` human UI capability. The code-managed
capability is initially granted to `staff` and `administrator`; it is not an
API-key scope.

The section picker is server-filtered to active teacher enrollments whose
OneRoster user email matches the signed-in teacher with
`lower(roster_email) = lower(application_email)`. A submitted class sourced ID
that was not already on the room must be in that server-derived set. The
individual-student search is limited to active students in the signed-in
teacher's schools (administrators may search the full active roster), and every
submitted explicit-member email is revalidated against that same server-side
scope before it is stored. The
assistant picker lists only approved assistants admitted by
`filterAccessibleResourceIds`, and every create/update re-runs the same
existence, approval, and access checks before writing. A crafted client cannot
assign another teacher's section or an inaccessible assistant.

Room mutations full-replace their class, explicit-member, and assistant link
sets in one `executeTransaction` call. Ownership is rechecked while the room
row is locked, and child rows cascade if a room is manually hard-deleted.
Neither room management nor membership resolution writes users, roster rows,
roles, capabilities, API scopes, resource grants, or administrator access.

## Student room access and assistant enforcement

Migration 158 adds a student-role navigation entry for `/rooms`. The page calls
the reverse membership accessors in `lib/rooms/membership.ts`, which resolve the
signed-in application user's current email against both active linked-section
enrollments and explicit room members. `/rooms/[id]` uses the same boundary and
returns not found for nonexistent and nonmember room IDs. Only approved
room-assigned assistants are rendered, and their launch links use the normal
`/tools/assistant-architect/{id}` execution experience.

Assistant room authorization is part of the existing shared resource access
layer, not a new capability or API-key scope:

- Membership in any active room grants access to an assistant assigned to that
  room, even when `resource_access_grants` would otherwise deny it.
- A user whose complete AI Studio role set is exactly `student` and who belongs
  to at least one active room may see and execute only assistants assigned to
  their active rooms. Ownership, an unrestricted resource, and a direct
  role/group resource grant do not bypass this restriction.
- Administrators and users with any non-student role are never room-restricted.
  Students with no active rooms keep the pre-room ownership and resource-grant
  behavior.
- Model and repository authorization remains independent. Room assignment
  grants the assistant only; every model/repository used by a run must still
  pass its existing access checks.

The browser execution route normally requires the `assistant-architect` human
feature capability. An assignment to the exact requested assistant is the one
narrow alternative for a room member: it is evaluated only after session
authentication and assistant visibility, and it does not grant the broad
capability or any API-key scope. The exported assistant-detail server actions
also resolve the session and shared resource gate before returning input fields
or prompt contents, so invoking the action RPC directly cannot bypass room
visibility. Trusted REST/MCP loaders are marked server-only and continue to
apply their route-level authentication, scope, visibility, and resource checks.

`userCanAccessResource` is the single-assistant execution/detail gate and
`filterAccessibleResourceIds` is the batch list gate. The web catalog and
gallery, v1 REST list/detail/execution routes, and MCP list/execution handlers
all flow through those helpers. Direct-ID surfaces perform base assistant
existence/status visibility first; an assistant hidden by the room policy is
reported as `404`, while an execution that passed visibility but fails a
current assistant/model permission returns `403`.

Membership and assignments take effect dynamically. Deactivating a room,
removing a member/section, or unassigning an assistant changes the next
authorization decision without copying or deleting application users. To stop
the student UI while preserving data, deactivate the `/rooms` navigation item
or apply migration 158's rollback statement. To disable room enforcement
entirely, roll back the #1314 application deployment before removing migration
157 data; dropping room tables while room-aware code is deployed fails closed
with database errors rather than silently widening access.

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
- Role metrics, emitted only when the optional pass succeeds:
  `RolesGranted`, `RolesRevoked`, `RoleUsersChanged` (`Environment`
  dimension).
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

## Production promotion checklist

Promote with ingestion and authorization flags disabled:

1. Deploy the application and Processing stack. Confirm migrations 141, 156,
   157, and 158 are applied; the Lambda, disabled-until-configured nightly rule,
   alarms, IAM policy, VPC configuration, and log group exist; and rollback
   owners are identified.
2. Create the production credential secret with the
   `aistudio-prod-oneroster-*` name pattern, `Environment=prod` and
   `ManagedBy=manual` tags, and exactly the credential shape for the selected
   `oauth1` or `proxy` mode. Keep all secret values out of settings, shell
   history, logs, issues, and pull requests.
3. While `ROSTER_SYNC_ENABLED=false` and
   `ROSTER_ROLE_SYNC_ENABLED=false`, set the five manual-sync configuration
   rows: `ONEROSTER_BASE_URL`, `ONEROSTER_AUTH_MODE`,
   `ONEROSTER_CREDENTIALS_SECRET_ARN`, `ONEROSTER_API_VERSION`, and
   `ONEROSTER_PAGE_SIZE`.
4. Run one manual sync from `/admin/rosters`. Require a terminal success for all
   six collections, stable `x-perm-rev`, plausible ClassLink-comparable totals,
   and no Lambda failure alarm. An empty, partial, inconsistent, or failed pull
   is not promotion evidence and must not be followed by absence deactivation.
5. Confirm the manual run did not change application roles, rooms, assistants,
   capabilities, API-key scopes, or demographics. Inspect lowercased email and
   sourced-ID relationships without exporting unnecessary roster data.
6. Run `scripts/db/report-roster-email-match.ts` against production. Apply the
   decision rule above; retain only aggregate counts, exit code, and the
   documented investigation/exception as evidence.
7. Set `ROSTER_SYNC_ENABLED=true`, observe the first scheduled success and both
   alarms, and verify the revision checkpoint advances only after a complete
   run.
8. Enable `ROSTER_ROLE_SYNC_ENABLED=true` only after the report decision is
   accepted and the fixed student/staff mapping is approved. Before teachers
   create active rooms, confirm the same accepted roster snapshot is still
   current. Keep either authorization path disabled/unpopulated if its evidence
   needs investigation.

No live ClassLink credential test is implied by CI or the mocked protocol suite.
The production manual sync in step 4 is the credentialed validation boundary.

To stop ingestion, set `ROSTER_SYNC_ENABLED=false` in `/admin/rosters`.
Existing roster rows remain
as the last-known-good snapshot. For a code rollback, deploy the previous
Processing stack version; migration 141 and the `oneroster_*` tables are
additive and may remain in place. Do not clear rows or the revision checkpoint
as part of routine rollback. If a credential may be exposed, rotate it in
ClassLink and Secrets Manager before re-enabling the integration.

To stop authorization reconciliation without stopping collection ingestion,
set `ROSTER_ROLE_SYNC_ENABLED=false`. Existing `oneroster` grants remain as the
last successfully reconciled state. If rollback requires removing them, first
disable the flag, then run:

```sql
WITH deleted AS (
  DELETE FROM user_roles
   WHERE source = 'oneroster'
  RETURNING user_id
)
UPDATE users
   SET role_version = coalesce(role_version, 0) + 1,
       updated_at = now()
 WHERE id IN (SELECT DISTINCT user_id FROM deleted);
```

That statement is intentionally source-scoped and leaves manual, group-sync,
and administrator grants unchanged. The version bump invalidates cached role
state for every affected user. It changes authorization immediately; use the
normal production change and audit process.

To remove only the administrator UI, remove its `ADMIN_SECTIONS` registry entry
and route. The settings and last-known-good roster snapshot can remain. Older
Lambda versions ignore `ONEROSTER_SYNC_STATUS`; removing that internal settings
row is optional and must not be coupled to roster-row deletion.

To roll back only teacher room management, revoke the `rooms-manage`
capability or deploy the previous application version. The additive migration
may remain. If the room data itself must be removed, migration 157 documents
the child-first manual drop order; export or confirm that the room definitions
are disposable before running those destructive statements.
