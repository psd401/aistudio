# Google Workspace Content Synchronization

Issue [#1262](https://github.com/psd401/aistudio/issues/1262) adds Google Drive
as a synchronized source for the unified repository platform in
[ADR-007](../architecture/adr/ADR-007-unified-content-and-repositories.md).
Repository ACLs remain authoritative: a Drive grant allows the connector to
read source bytes, but it never grants an AI Studio user access to the target
repository.

## Authorization boundaries

Personal Drive uses OAuth authorization-code flow with S256 PKCE and requests
exactly:

```text
https://www.googleapis.com/auth/drive.readonly
```

The callback validates an encrypted, HTTP-only, five-minute state cookie before
examining provider-controlled parameters. Refresh tokens are encrypted with the
existing AES-256-GCM token DEK and stored separately from connector/source
metadata. Picker access tokens are short lived, returned only to the connector
owner, sent with `Cache-Control: no-store`, and never logged.

Shared Drives use the fixed keyless identity delivered by
`psd401/psd-gcp-infra#1`:

| Contract               | Value                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Service account        | `unified-content-sync@psd-aistudio-broker.iam.gserviceaccount.com`                       |
| GCP project number     | `1022506104054`                                                                          |
| Workload Identity Pool | `aws-agent-broker`                                                                       |
| Provider               | `content-sync`                                                                           |
| Trusted AWS roles      | `unified-content-sync-execution-role-dev` and `unified-content-sync-execution-role-prod` |

The worker uses ambient Lambda credentials for AWS-to-GCP federation and service
account impersonation. It has no service-account key and no domain-wide
delegation. A Shared Drive administrator must add the service account as a
Viewer before an AI Studio administrator configures the Drive ID in Repository
Manager. Because WIF uses a shared application identity, Shared Drive creation
is restricted to the AI Studio `administrator` role; this prevents a repository
owner from using that identity to read a Drive they cannot access directly.

A repository owner or administrator with the `knowledge-repositories` UI
capability may configure personal OAuth, choose personal sources, retry, and
disconnect. Shared Drive setup additionally requires the `administrator` role
and is hidden from other managers. The repository management check is repeated
on list, Picker, selection, retry, and disconnect routes. This is a human UI
capability boundary, not an API key scope.

## Synchronization model

Migration 136 adds separate credential, connector, selection, source, and sync
run records. A connector stores its durable Drive changes page token and watch
channel health. A source maps one stable Drive file ID to one stable repository
item. Each Drive revision creates a new immutable
`repository_item_versions` row and canonical inspection job; the current item
pointer advances without overwriting prior versions.

Initial reconciliation records a start page token before walking the configured
file, folder tree, or Shared Drive. Scheduled polling of `changes.list` is the
authoritative log. Webhook notifications only move `next_sync_at` forward, so a
missed or duplicated notification cannot lose a change. The webhook validates
channel ID, resource ID, a constant-time token hash, and a monotonic arbitrary
precision message number.

Workers persist a page cursor only after every change in that page is durable.
Duplicate delivery is safe because the source revision and processing job keys
are idempotent, and a durable lease coalesces overlapping schedule, webhook, and
manual requests. Replacing a selection increments a durable generation; source,
version, cursor, watch, and completion writes that can publish stale work from an
older in-flight generation fail closed without overwriting the reset cursor. An
expired Drive cursor triggers a complete selection snapshot from a newly
acquired start token. Folder changes also complete a selection snapshot before
advancing the page cursor because Drive may not emit a separate change for every
descendant moved with the folder.

The five-minute EventBridge dispatcher only identifies due connectors and puts
one message per connector on the isolated SQS queue. Synchronization therefore
inherits the queue event source's bounded concurrency instead of starting up to
25 Drive crawls inside one scheduler invocation. A snapshot is limited to
10,000 unique files and 10,000 folder visits. Crossing either bound fails the
run with `GOOGLE_DRIVE_SNAPSHOT_LIMIT_EXCEEDED` before a partial snapshot can
advance the cursor or mark unseen sources missing; durable page-level traversal
is required before raising these limits.

A failed download or export degrades only that source; the remainder of the
cursor page still commits and the failed source is retried on the next run.
The worker rejects advertised source sizes and response lengths above
`CONTENT_MAX_FILE_SIZE_GB`, and an authoritative byte-counting transform aborts
multipart upload if an export exceeds that limit in flight. Oversized sources
remain visible with `GOOGLE_DRIVE_SOURCE_SIZE_LIMIT_EXCEEDED` and never receive
a repository version. Completed source uploads are initially tagged
`aistudio-upload-state=temporary`; canonical inspection promotes registered
versions to `permanent`, while the documents-bucket lifecycle removes an object
left unregistered by a selection race or database failure.
Files moved outside a selected folder, deleted files, and lost access enter a
recoverable missing state. Their last immutable versions remain stored, but
active retrieval is disabled after
`CONTENT_DELETION_GRACE_DAYS`. Reappearance during the grace window reactivates
the same stable item. If the administrator who configured a connector is
deleted, a database cleanup trigger marks its retained repository items
unavailable before connector/source cascades remove the reconciliation link.

Google Docs, Sheets, Slides, and Drawings export to DOCX, XLSX, PPTX, and PDF.
Drive blobs retain their supported MIME type. Google Vids and other Drive
long-running downloads persist the operation name and resume later instead of
holding a Lambda invocation open. Unsupported native types remain visible with
an `unsupported` source status instead of silently disappearing.

## Infrastructure and rollout

Deploy in this order:

1. apply additive migration `136-google-content-connectors.sql`;
2. deploy the Processing stack (queue, DLQ, isolated worker/WIF role, schedule,
   alarms, and queue exports);
3. deploy the Frontend stack so ECS receives
   `GOOGLE_CONTENT_SYNC_QUEUE_URL`; and
4. enable `CONTENT_PLATFORM_ENABLED` and
   `GOOGLE_CONTENT_SYNC_ENABLED` for the intended environment.

The scheduled next-run delay is controlled by
`GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES`; deferred long-running downloads retry
after one minute.

Create `aistudio/{environment}/google-content-oauth` in Secrets Manager with:

```json
{
  "clientId": "google-oauth-client-id",
  "clientSecret": "google-oauth-client-secret",
  "pickerApiKey": "browser-key-restricted-to-the-ai-studio-origin",
  "appId": "1022506104054"
}
```

Register this exact callback for each environment:

```text
https://<ai-studio-origin>/api/repositories/connectors/google/callback
```

Restrict the Picker browser key to the corresponding HTTPS origin and Google
Picker/Drive APIs. The OAuth client, consent screen, domain verification, and
callback registration are administrator-controlled console steps; no secret
value belongs in CDK, source control, a connector row, or a worker message.

The worker alarms on Lambda errors, messages older than 30 minutes, and any DLQ
record. Repository Manager shows connector status, last success, last error,
selection count, tracked source count, manual retry, and disconnect. Operational
logs correlate connector, sync run, and request/trace IDs without source text,
tokens, signed URLs, or downloaded bytes.

Rollback is a settings change. Disable `GOOGLE_CONTENT_SYNC_ENABLED` to stop new
authorization and synchronization while retaining additive schema and immutable
versions. Do not remove migration 136 or delete connector records as a rollback.

## Verification

- `tests/unit/lib/repositories/google-drive-client.test.ts` covers exact scope,
  Drive metadata/cursor contracts, export mappings, and resumable Vids
  operations.
- `tests/unit/lib/repositories/google-drive-oauth.test.ts` covers PKCE and
  fail-closed scope validation.
- `tests/unit/lib/repositories/google-drive-route-access.test.ts` proves the
  common WIF identity can only be configured by an AI Studio administrator.
- `tests/unit/lib/repositories/google-drive-selections-route.test.ts` and
  `google-drive-bounded-concurrency.test.ts` prove per-user throttling, bounded
  provider fanout, and stable selection ordering.
- `tests/unit/lib/repositories/google-drive-callback.test.ts` proves forged or
  mismatched callback state cannot select or consume another in-progress state
  cookie while valid denial and PKCE success behavior remains intact.
- `tests/smoke/google-content-connectors.smoke.ts` runs against real PostgreSQL
  and verifies selection-generation fencing, isolated source failure/recovery,
  cursor, immutable-version, sync-run, deletion-grace state, and fail-closed
  creator-deletion cleanup.
- `infra/lambdas/google-content-sync/__tests__/safety.test.ts` proves metadata,
  response, and in-flight byte limits plus finite snapshot budgets.
- `infra/test/unit/google-content-sync.test.ts` synthesizes the exact WIF role,
  least-privilege object/queue policies, scheduled queue dispatch, queue/DLQ,
  and alarms.
- `tests/e2e/unified-content-product-migration.functional.spec.ts` covers
  unauthenticated route guards, public token-authenticated webhook reachability,
  and the authenticated personal/Shared Drive Repository Manager UI without
  requiring live Google credentials.

After deployment, complete a labeled live matrix for create, edit, move into and
out of a selected folder, delete/restore, Shared Drive permission loss/restore,
notification loss followed by scheduled cursor resume, and one native export of
each supported Workspace type.
