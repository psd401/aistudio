# Unified Repository Product Integration

Issue [#1268](https://github.com/psd401/aistudio/issues/1268) consolidates
Repository Manager, Assistant Architect, and Nexus onto the repository
application service defined by
[ADR-007](../architecture/adr/ADR-007-unified-content-and-repositories.md).
Repository Manager is the authoritative durable-management surface. Product
features may stage private ephemeral repositories, but they do not create
separate document stores.

## Shared source flow

`RepositoryPicker` lists only active durable repositories the current user may
read and identifies which ones they may manage. It supports single or multiple
selection and inline private repository creation. `RepositorySourcePicker`
continues into the shared source modal for a selected, newly created, or
preselected destination. The source modal currently supports:

- canonical direct-to-S3 single or multipart file upload;
- URL sources through the repository URL processor;
- inline text with a canonical immutable-version shadow write; and
- an explicit unavailable state for Google Drive while #1262 remains blocked on
  `psd401/psd-gcp-infra#1`.

The canonical browser helper uploads bytes directly to a signed object-storage
URL. Only bounded metadata, multipart ETags, and completion identifiers cross a
Next.js request. Repository detail views expose lifecycle and active-generation
state; item detail views expose immutable versions, inspection/processing state,
derived artifacts, jobs, and exact active-generation citation locators. Shared
readers never receive management controls or internal processing errors.

Repository ACLs remain distinct from product capabilities. The
`knowledge-repositories` capability admits the human management UI; repository
ownership, public visibility, direct-user grants, and role grants decide access
to each repository. Grant/revoke actions are owner/admin-only and accept exactly
one user or role principal. Administrator and staff roles receive the capability
by default. Migration 125 idempotently grants it to staff on existing
installations because manifest defaults apply only on first registration.

## Assistant Architect

Prompt authors select repositories through the shared picker. “Add repository
content” uses the same select/create/source flow as Repository Manager. System
instructions remain prompt behavior; uploaded source text is never appended to
that field. No live builder UI calls the historical Assistant Architect
PDF-to-Markdown job.

The server validates every repository ID against the author at prompt create and
update. Submission and approval compare the assistant's intended role/group
audience with every bound repository and fail closed when the repository
audience is narrower. Later assistant grant edits validate the proposed
replacement audience too, including clearing grants to unrestricted access;
post-approval role/group changes cannot advertise an assistant beyond its
repositories. Adding or replacing prompt repository bindings on an already
approved assistant evaluates the complete proposed binding set against the
current audience before persistence, so editing the prompt cannot bypass the
same invariant. Interactive, scheduled, and API execution revalidate the
current executor before creating an execution record, retrieving content, or
calling a model. Assistant ownership never lends repository access.

Runtime `file_upload` inputs use the same temporary canonical upload contract as
Nexus. The form receives an opaque repository marker, not extracted source text.
Execution resolves that marker for the current owner before recording the run,
then merges its repository into bounded retrieval and repository tools.
Both interactive app and v1 API conversation starts bind those references to
the new owned conversation before writing the first message and store only the
bounded server-resolved repository IDs in metadata. A failed first-message
write unbinds the references and removes the empty conversation. Follow-up and
history routes require that metadata's assistant ID to match the URL.
Follow-up turns recheck every static and runtime repository before parsing or
persisting the message, inject bounded retrieval context only into the model
copy, and retain the user's unmodified text in history.

The historical conversion routes remain readable for old job status and return
a migration response for new work when canonical cutover is active. The live
runtime upload control never falls back to that processor: when canonical
temporary staging is disabled it fails closed and directs authors to add the
source through Repository Manager. Rollback therefore remains repository-backed
and cannot recreate product-owned extracted-text storage.

## Nexus

Each canonical document/text/image attachment gets a private owner-bound ephemeral
repository and a server-owned draft binding. The default expiry comes from
`NEXUS_ATTACHMENT_RETENTION_DAYS` (30 days). The client performs:

1. authenticated metadata initiation;
2. direct signed single/multipart object upload;
3. owner-bound completion and durable processing dispatch; and
4. status polling until the canonical item is searchable.

Temporary upload initiation is an intentionally shared authenticated staging
service for Nexus and Assistant Architect. Its `purpose` field is telemetry,
not an authorization claim: callers cannot select a different owner, repository,
retention policy, or object prefix through it. Owner isolation, bounded file and
concurrent-upload limits, expiry cleanup, and pre-creation compensation constrain
storage use. The consuming Nexus and Assistant Architect routes separately
enforce conversation ownership and assistant execution access before content can
reach a model; changing `purpose` cannot grant either product capability.

Only an opaque `bindingId`/`itemId` marker enters a document/text chat request.
Images carry the same canonical marker; the server discards caller-carried
inline pixels for canonical references and reloads the exact inspected current
version from the owner-bound repository for the immediate vision or
image-editing turn. Persisted history retains only image-presence metadata and
the reference. The chat route preflights markers before routing or conversation
creation, atomically binds them to the owned conversation, replaces markers
with safe labels before safety/model handling, resolves active unexpired
repositories, and adds `searchNexusAttachments`. Retrieval v2
independently reapplies current repository and segment ACLs at final context
disclosure and returns immutable-version citation locators. Before a retrieved
chunk can enter the external model's tool loop, the attachment tool applies the
configured K-12 content-safety and PII input transform. Reversible mappings live
only in a request-scoped sink shared with that run's stream detokenizer; there is
no cross-request mapping state. Raw chunk bodies are removed from
persisted/replayed attachment tool results. A forged, foreign, or expired marker
receives the same non-disclosing not-found response and cannot leave an empty
first-turn conversation.

“Keep as a repository” promotes the exact ephemeral container in place. Item,
version, chunk, and citation identities therefore remain stable. Promotion
clears expiry and hidden state but does not make the repository public. The
button is derived from the authenticated capability catalog, and the promotion
route independently requires `knowledge-repositories`, so every promoted
repository has a management surface.

Upload reservation serializes quota decisions per uploader and Nexus owner.
At most ten active uploads may be in flight per uploader, while active
Nexus-managed storage (including promoted repositories that originated in
Nexus) is limited to 5 GiB and 100 repositories per owner. A quota denial is a
non-disclosing `429`; concurrent reservations cannot both pass a stale count.

The scheduled unified-content worker first marks expired repositories inactive
for retrieval. After the configured deletion grace period it leases purge work,
deletes every current/noncurrent object version and delete marker under the
validated repository prefix, and removes database state. Expired upload sessions
abort multipart work before cleanup. Upload cleanup is deliberately two-pass:
an initial sweep runs at expiry, the session remains leased through a one-hour
in-flight-request settle window, and a final sweep makes it terminal. Every
signed source is also tagged `aistudio-upload-state=temporary`; only a worker
that observes a clean/not-required malware decision replaces that value with
`permanent`, while preserving the complete GuardDuty tag set. A one-day S3
lifecycle rule therefore bounds even a PUT that finishes after both database
cleanup sweeps, without allowing completion to erase a malware result.
Interrupted purges are retryable and never claim a promoted durable repository.
Partial object-store deletion keeps the repository in `deleting` with a fresh
lease. Failed/cancelled external BDA work persists its terminal state and no
longer blocks deletion forever; unknown or active external work remains
fail-closed and pollable.

Durable repository and item deletion use the same producer-fence protocol.
Inside one transaction they lock repository then item rows, wait for every
issued upload URL plus its settle window, refuse running or deferred external
Textract/BDA work, cancel ordinary pending/queued jobs, and mark lifecycle state
`deleting`. Upload reservation/completion, worker claim, publication, and
embedding-generation activation acquire/recheck the same active lifecycle
locks. Only after that transaction commits does the action sweep S3 and
cascade database manifests. Storage or database failure leaves the resource
non-readable in `deleting`; owners and administrators still see it in
Repository Manager as “Deletion pending retry,” and the same delete action
repeats the idempotent sweep and finalization after reload. Scheduled ephemeral
purge applies the identical session/job fence before storage cleanup.

## Rollout and verification

Canonical temporary uploads activate only when the existing content-platform
cutover predicate passes (`CONTENT_PLATFORM_ENABLED`,
`CONTENT_DUAL_WRITE_ENABLED`, and `CONTENT_READ_V2_ENABLED`). A flag-off
initiation returns `mode: "legacy"` before creating an ephemeral repository.
Already initiated canonical uploads may complete safely during a flag change.

Coverage includes component/server-action tests, ACL and audience tests,
temporary-reference and direct-upload contracts, lifecycle and migration tests,
Retrieval v2 leakage checks, a real PostgreSQL ephemeral lifecycle smoke, CDK
IAM assertions/synthesis, and authenticated Playwright across all three product
surfaces, including inline-plus-canonical image input and forged-reference
preflight.
