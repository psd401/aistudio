# Unified Content and Repository Platform

**Date:** 2026-07-21
**Status:** In progress
**GitHub epic:** [#1261](https://github.com/psd401/aistudio/issues/1261)
**Architecture decision:** [ADR-007](../architecture/adr/ADR-007-unified-content-and-repositories.md)

## Outcome

Build one durable, permission-aware ingestion and retrieval platform for Nexus,
Assistant Architect, Repository Manager, Nexus Projects, Atrium, Google Workspace,
and external agents. Users continue to call the durable container a
**Repository**. Every source is normalized, versioned, processed, indexed, and
authorized through the same backend services.

This document is the version-controlled execution ledger. GitHub issues track
delivery and review; this file records architectural decisions, sequencing,
acceptance gates, and migration state so implementation can move between Codex
tasks or worktrees without relying on conversation history.

## Confirmed product decisions

- Repository is the universal knowledge container and the user-facing term.
- Assistant Architect connects to repositories. A builder upload adds to an
  existing repository or creates one; it does not create a separate document
  store.
- Nexus one-off attachments use a private, ephemeral repository owned by the
  user. They expire after 30 days by default; administrators can change the
  retention period.
- Future Nexus Projects use durable project repositories and may attach other
  repositories.
- Google Workspace sources stay synchronized. A source edit creates a new
  immutable version; deletion or lost access removes it from the active index
  after a configurable recovery grace period.
- Google authorization should be a one-click delegated flow. Infrastructure is
  maintained in `psd401/psd-gcp-infra`; domain-wide delegation and OAuth consent
  remain explicit administrator steps documented by that repository.
- OpenClaw agents get permission-aware repository catalog and retrieval tools,
  using per-user delegated authorization by default.
- Visual retrieval is designed into the canonical model from the beginning,
  even while the first production slice indexes text from PDFs.
- Limits, retention, processing strategies, and connector policies are
  database-first administrator settings with safe defaults.
- An assistant never bypasses the executing user's repository access. Publishing
  an assistant is blocked when its intended audience is broader than any bound
  repository unless an administrator deliberately resolves the mismatch.

## Architecture at a glance

```text
Nexus / Assistant Architect / Repository UI / Projects / Agents
                              |
                    Repository application service
                              |
       +----------------------+-----------------------+
       |                      |                       |
 direct multipart       synchronized source      authored content
 S3 upload              (Google/web/etc.)         (Atrium/API)
       |                      |                       |
       +------------- canonical item/version --------+
                              |
 quarantine -> inspect -> normalize -> enrich -> segment -> embed -> publish
                              |
       immutable source + artifacts + segments + index generation
                              |
     permission-aware hybrid/multimodal retrieval with exact citations
```

### Reuse instead of replacement

The existing systems already contain important contracts and data:

- `knowledge_repositories`, `repository_items`, `repository_item_chunks`, and
  `repository_access` remain the repository and retrieval backbone.
- `content_objects` and `content_versions` remain Atrium's authored/published
  content model. `content_index_links` is the explicit bridge into repositories.
- Assistant Architect's existing `repository_ids` bindings remain compatible
  during migration and later move behind a normalized binding service.
- The existing documents bucket, queues, processing Lambdas, Textract support,
  pgvector index, API authentication, MCP server, settings manager, and audit
  conventions are evolved rather than bypassed.

Raw source files are not silently converted into Atrium documents. An upload is
a versioned repository item. A person or agent may derive an authored Atrium
object from that source, with a recorded provenance link.

## Canonical data model

The first additive migration extends the current repository tables rather than
introducing another top-level asset system.

| Record | Responsibility |
|---|---|
| `knowledge_repositories` | Durable or ephemeral container, ownership, policy, and lifecycle |
| `repository_items` | Stable logical item identity across source revisions |
| `repository_item_versions` | Immutable source version, checksum, object location, detected media, and source revision |
| `repository_processing_jobs` | Idempotent stage state, attempt history, lease, timing, and failure classification |
| `repository_artifacts` | Derived text, Markdown, layout, tables, images, thumbnails, transcript, captions, and other modalities |
| `repository_item_chunks` | Search segment linked to the exact item version and artifact, with page/time/region citation metadata |
| `repository_index_generations` | Atomic index publication and rollback boundary |
| `repository_connectors` | External source configuration, encrypted-credential reference, cursor, and sync health |
| `content_index_links` | Existing Atrium content-to-repository bridge |

All new tables use additive migrations. Existing migrations 001-005 and every
previous numbered migration remain immutable. During rollout, old readers can
continue using `repository_items.source`, metadata, and current chunks.

## Processing contract

Every ingestion request becomes a state machine with idempotent stage keys:

1. `received` — item and immutable version recorded.
2. `quarantined` — object cannot be retrieved or indexed yet.
3. `inspected` — size, MIME signature, archive limits, and malware policy pass.
4. `normalized` — canonical artifacts and structural metadata emitted.
5. `enriched` — OCR, tables, images, audio/video transcript, captions, and
   optional descriptions emitted according to policy.
6. `segmented` — structure-aware segments carry exact source anchors.
7. `embedded` — text and supported visual representations embedded in a named
   index generation.
8. `published` — one transaction switches the repository/item to the completed
   generation. Failed or partial generations never replace the active index.

A retry resumes at the first incomplete stage. Stage output keys include the
source checksum and processor version so duplicate deliveries and retries are
safe. A dead-letter replay creates another attempt, not another logical item.

## Processing strategy

- PDFs: use embedded text/layout when quality is sufficient; route scanned or
  structurally complex pages to Textract or Bedrock Data Automation; retain page
  images and bounding boxes for citations and visual retrieval.
- DOCX/PPTX/XLSX: preserve headings, sections, tables, speaker notes, sheet names,
  and cell/range anchors. A maintained open parser such as Docling is the
  portable fallback when managed extraction does not preserve enough structure.
- Images: retain the original, dimensions, OCR, safety output, thumbnail, and
  optional visual description/embedding.
- Audio/video: retain the original, extract metadata and keyframes, transcribe
  with timestamps and speaker labels when available, and create time-range
  segments. Media processing is asynchronous and never held in a web request.
- Text/code/data: parse with format-aware boundaries; do not flatten structured
  JSON, CSV, XML, or source code into arbitrary fixed character windows.

Processor selection is a policy decision recorded on each job. Managed AWS
services are preferred where they provide the required quality and operational
fit; the canonical model stays provider-neutral so a processor can be replaced
without changing product surfaces.

## Retrieval contract

- Hybrid retrieval combines lexical and vector candidates, then reranks and
  diversifies by source/section.
- Authorization filtering happens before result disclosure and is re-checked
  against current repository access before source content is returned.
- Results identify repository, item, immutable version, segment, artifact,
  page/slide/sheet or timestamp, and optional bounding region.
- The active index generation is resolved once per query, preventing a query
  from mixing old and partially built chunks.
- Context assembly uses token budgets, neighboring segments, deduplication, and
  source diversity. It does not concatenate entire documents into prompts.
- Deletion, expiry, source-access loss, and repository permission changes remove
  content from active retrieval promptly and are auditable.

## Product integration

### Repository Manager

Becomes the universal interface for uploads, synchronized sources, processing
status, source versions, permissions, retention, reprocessing, and retrieval
quality. It should support bulk operations and resumable multipart upload.

### Assistant Architect

- Replace builder-owned PDF conversion with repository selection and an
  "Upload to repository" path.
- A new upload either targets a chosen repository or creates a private repository
  through the same repository service.
- Prompts and assistants retain repository bindings; execution revalidates the
  caller's current access and uses the shared retrieval service.
- The legacy PDF-to-Markdown endpoint remains behind a migration flag until all
  stored builder jobs and UI paths have moved.

### Nexus

- One-off uploads are added to a hidden/private ephemeral repository for the
  conversation owner. The model receives retrieval tools and citations, not an
  unbounded extracted-text block.
- The default retention setting is `30` days. Cleanup first deactivates retrieval,
  then deletes derived artifacts and originals after a recovery grace interval.
- Durable work belongs in a Project repository rather than extending attachment
  retention indefinitely.

### Google Workspace

- Support Drive files and folders first, including Docs, Sheets, Slides, PDFs,
  Office files, images, and media reachable through Drive.
- Store stable Drive file ID, shared-drive ID, revision/version marker, modified
  time, content checksum where supplied, and last observed permissions.
- Drive `changes.list` with a durable page token is the authoritative sync log.
  Notifications/events accelerate polling but are not the sole source of truth.
- Exports of native Workspace files are versioned artifacts; unsupported or
  oversized exports produce an actionable item state rather than disappearing.
- Lost permission, deletion, or removal from a configured folder deactivates the
  item and its index generation, with configurable recovery before hard deletion.

### OpenClaw and other agents

Expose a small catalog rather than one tool per repository:

- `repositories.list`
- `repositories.describe`
- `repositories.search`
- `repositories.get_source`
- `repositories.list_changes`

Tools are backed by the same service and permission checks as the UI. API-key
scopes authorize the programmatic surface; repository ACLs authorize each
resource. The initial OpenClaw skill may wrap AI Studio's MCP endpoint, followed
by one-click per-user delegated OAuth when the consent flow is ready.

## Administration settings

The settings UI will validate and explain these database-first settings:

| Key | Default | Purpose |
|---|---:|---|
| `CONTENT_PLATFORM_ENABLED` | `false` | Global controlled-rollout flag |
| `CONTENT_DUAL_WRITE_ENABLED` | `false` | Write canonical records alongside a legacy path |
| `CONTENT_READ_V2_ENABLED` | `false` | Read from the canonical retrieval path |
| `NEXUS_ATTACHMENT_RETENTION_DAYS` | `30` | One-off Nexus source retention |
| `CONTENT_DELETION_GRACE_DAYS` | `7` | Recovery window before physical deletion |
| `CONTENT_MAX_FILE_SIZE_GB` | `10` | Maximum single-source upload |
| `CONTENT_MAX_PDF_SIZE_MB` | `500` | Canonical PDF/Textract ceiling |
| `CONTENT_MAX_OFFICE_SIZE_MB` | `100` | In-memory DOCX/XLSX/PPTX processor ceiling |
| `CONTENT_MAX_IMAGE_SIZE_MB` | `50` | In-memory image normalizer ceiling |
| `CONTENT_MAX_MEDIA_HOURS` | `4` | Maximum audio/video duration |
| `CONTENT_ALLOWED_MIME_TYPES` | managed allowlist | Accepted source formats |
| `CONTENT_MALWARE_SCAN_REQUIRED` | `true` | Quarantine release policy |
| `CONTENT_OCR_STRATEGY` | `auto` | Managed/fallback OCR policy |
| `CONTENT_IMAGE_CAPTION_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Bedrock Nova image-description model |
| `CONTENT_VISUAL_INDEX_ENABLED` | `false` | Visual embeddings rollout |
| `GOOGLE_CONTENT_SYNC_ENABLED` | `false` | Workspace connector rollout |
| `GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES` | `15` | Reconciliation cadence |

Values are bounded and fail closed. Feature flags can be enabled by environment,
repository, or allowlisted users during rollout; the database setting is never
the only permission check.

## Delivery workstreams and gates

### 1. Foundation and PDF walking skeleton — #1265

- Add the canonical version/job/artifact/index-generation contracts.
- Add typed settings and lifecycle helpers.
- Dual-write one Repository Manager PDF upload into the new records.
- Process through one idempotent PDF path and publish an active generation.
- Display processing state and exact PDF citations through the repository query
  boundary.
- Unit tests cover state transitions, idempotency, settings bounds, and access.
- Integration tests cover migration/schema and job publication.
- Focused E2E covers upload -> processing state -> searchable/cited result.

**Exit gate:** the PDF path works in dev behind flags; legacy behavior remains
available; rollback is a flag change, not a data rewrite.

### 2. Multimodal and scale — #1264

- Office and structured text, then images, then audio/video.
- Multipart/resumable upload, archive-bomb defenses, malware scanning, DLQ replay,
  quotas, cancellation, and bulk progress.
- Golden-corpus extraction tests and concurrency/load tests.

**Exit gate:** supported-format matrix meets quality thresholds, retries are
idempotent, and large content never traverses a Next.js request buffer.

### 3. Retrieval v2 — #1263

- Structure-aware segments, hybrid ranking, reranking, citation resolver, visual
  index, generation publication, and evaluation harness.
- Permission, leakage, recall, precision, citation, and latency tests.

**Exit gate:** retrieval evaluation meets the agreed quality and security budget;
no stale or unauthorized version can be returned.

### 4. Google synchronization — #1262 and psd-gcp-infra#1

- Terraform APIs, service account/WIF boundary, Pub/Sub, secrets references,
  monitoring, and runbook.
- AI Studio connector, delegated OAuth, folder/shared-drive selection, cursor
  reconciliation, permission-loss handling, and admin health UI.

**Exit gate:** create/update/move/delete/access-loss cases converge correctly
after notification loss and cursor resume.

### 5. Product consolidation — #1268

- Universal Repository UI, Assistant Architect migration, Nexus ephemeral
  repositories, admin settings, and legacy-path deprecation notices.

**Exit gate:** all three current upload surfaces use the repository service and
the legacy Assistant Architect job path has no active callers.

### 6. Agents and Projects — #1266

- Repository catalog MCP/API tools, scopes, delegated authorization, OpenClaw
  skill, change feed, and Nexus Project repository binding.

**Exit gate:** an authorized agent can discover/search/read only allowed sources,
and repository updates become visible without rebuilding the agent.

### 7. Migration and retirement — #1267

- Inventory/backfill existing Nexus jobs, Assistant Architect documents, and
  repository items; compare old/new outputs; progressive read cutover; lifecycle
  cleanup; dashboards, alarms, cost attribution, and runbooks.

**Exit gate:** parity checks and rollback drills pass, no orphaned source remains,
and old processors/routes/tables are removed only after an observed quiet period.

## Test strategy and required evidence

Every implementation PR must identify which cells it changes and include the
matching automated evidence.

| Layer | Required coverage |
|---|---|
| Pure domain | Unit tests for state machine, policy parsing, checksums, source identity, segmentation, citations, and retry keys |
| Database | Migration smoke test plus integration tests for constraints, transactions, current-version changes, generation publication, expiry, and access revocation |
| Processor | Contract fixtures and a checked-in golden corpus with text, scanned, malformed, encrypted, complex-layout, and oversized samples |
| API/actions | Authentication, capability/scope distinction, ACL enforcement, validation, idempotency, and non-disclosing errors |
| UI | Component tests for state/error/progress and focused authenticated Playwright workflows |
| Retrieval | Offline quality evaluation plus explicit cross-user/role/group leakage tests |
| Infrastructure | CDK synth/assertions, Terraform validate/plan, IAM least-privilege review, alarms, queue/DLQ and lifecycle assertions |
| Regression | Entire `bun run lint`, `bun run typecheck`, unit suite, relevant integration suite, and existing E2E tier per repository guidance |

Authenticated E2E tests use the established `:3100` local server and
`tests/e2e/helpers/session-auth.ts`. Guard specs remain unauthenticated and
CI-safe. Large-file, managed-AWS, Google, and malware-engine scenarios are
tagged integration tests with deterministic local contract substitutes; a
scheduled dev-environment suite validates the real services.

## Rollout and resilience

- Additive schema first; no destructive migration during feature construction.
- Shadow/dual writes and comparison metrics precede read cutover.
- Publish retrieval generations atomically; keep the previous generation for
  immediate rollback.
- Use an outbox/event record for database-to-queue handoff so an item cannot be
  committed without a recoverable processing signal.
- Workers use bounded leases, heartbeats, exponential backoff with jitter, DLQs,
  and stage-level idempotency.
- Store processor name/version, model ID, policy version, timings, token/pages,
  and estimated cost on every attempt.
- Never log source text, credentials, or signed URLs. Correlate UI request, item,
  version, job, and worker trace IDs.
- Lifecycle enforcement is observable and reversible during grace windows.

## Worktree and branch model

The active multimodal branch is `codex/unified-content-media-ingestion` in the
isolated worktree:

```text
/private/tmp/aistudio-unified-content-media-ingestion
```

The main checkout stays on `dev`, so other agents or projects can use separate
branches/worktrees without touching this work. PRs target `dev`. Each workstream
may split into its own `codex/` branch after the foundation contracts merge; no
two worktrees should edit the same migration or contract file concurrently.

## Progress ledger

- [x] Research and current-state audit
- [x] Architecture and product decisions confirmed
- [x] GitHub epic and workstream issues created
- [x] Dedicated worktree and branch created from current `origin/dev`
- [x] Foundation schema and typed contracts
- [x] Repository PDF dual-write/canonical-upload walking skeleton
- [x] Foundation unit/integration/E2E tests
- [x] Foundation/Office/image dev deployment and observability validation
- [ ] Multimodal processing (Office/image deployed; audio/video implementation
      and local verification complete, dev managed-service validation pending)
- [ ] Retrieval v2 and visual search
- [ ] Google Workspace sync
- [ ] Universal product UI migration
- [ ] OpenClaw and Projects integration
- [ ] Backfill, cutover, and legacy retirement

Update this checklist and the linked GitHub issues at every delivery boundary.
Do not mark a workstream complete solely because code exists: its exit gate and
test evidence must pass.

### Foundation checkpoint (2026-07-21)

Implemented on `codex/unified-content-platform`, ready for dev review/deployment:

- Additive migration 116 with immutable versions, resumable upload sessions,
  durable processing jobs, artifacts, exact-citation chunks, atomic index
  generations, lifecycle fields, and database-first rollout settings.
- Repository-scoped single/multipart PDF uploads with server-side ownership,
  size, type, object-namespace, completion, and replay validation.
- A deployable SQS worker and CDK construct with DLQ recovery, leases,
  GuardDuty quarantine decisions, embedded-text extraction, Textract OCR,
  bounded embedding messages, S3-backed large canonical artifacts, and atomic
  publication. The canonical PDF ceiling is 500 MiB because that is Textract's
  hard asynchronous limit; larger future formats require the scale workstream.
- The walking skeleton atomically publishes the exact-citation lexical
  generation, then enriches its chunks with bounded asynchronous embedding
  batches. Vector completion is generation-aware and cannot mark an item
  embedded while another batch is pending. Holding the prior generation active
  until all embeddings finish is deliberately tracked in Retrieval v2 (#1263),
  before canonical reads may be enabled broadly.
- Canonical retrieval filters out quarantined, superseded, incomplete, and
  inactive-generation content and returns stable item/version/page citations.
- Rollout remains off by default. Legacy upload behavior remains the fallback;
  the new upload contract activates only when platform, dual-write, and v2-read
  flags are all enabled.
- Existing infrastructure test defects encountered during the full regression
  pass were repaired: Lambda test dependencies, CommonJS-compatible Markdown
  runtime, hermetic OptimizedLambda synthesis tests, unsupported Node.js 20
  CodeGuru profiling, and a CDK metric assertion.

Verification evidence at this checkpoint:

- Application CI: 250 suites, 2,976 tests passed; 5 suites/60 tests skipped by
  the repository's CI configuration.
- Infrastructure: 29 suites, 324 tests passed, including a real worker bundle
  synthesis.
- Authenticated Playwright: 2/2 repository upload-contract workflows passed.
- Real PostgreSQL smoke: real two-page PDF extraction, upload completion/replay,
  quarantine, idempotent publication, atomic generation swap, and exact
  citations passed.
- Full lint (zero errors), application typecheck, infrastructure typecheck,
  dedicated worker typecheck, and production Next.js build passed.

The remaining foundation exit-gate item is a dev deployment with flags enabled
for an allowlisted test repository, followed by CloudWatch/GuardDuty/Textract
observability validation. Do not enable v2 reads broadly before that check.

### Office ingestion checkpoint (2026-07-21)

Implemented on `codex/unified-content-office-ingestion`:

- The canonical upload contract accepts DOCX, XLSX, and PPTX in addition to PDF,
  while unsupported formats continue through the legacy fallback.
- A shared, provider-neutral Office normalizer produces deterministic text,
  hashes, token estimates, and exact Word paragraph, Excel sheet/cell-range, and
  PowerPoint slide locators. The default adapters parse real OOXML package bytes
  and reject archive entry-count, per-entry expansion, and total-expansion bombs
  before a document parser expands the package.
- The worker applies the same S3 quarantine, GuardDuty decision, durable job,
  artifact, atomic generation, and embedding flow to Office sources.
- `CONTENT_MAX_OFFICE_SIZE_MB` is database-first, visible through the generic
  Content Platform admin settings category, bounded to 1–500 MiB, and defaults
  to 100 MiB independently of the 10 GiB object-storage ceiling.
- The admin settings page now renders the migration-seeded `Content Platform`
  category, exposes every content setting as a common preset, wraps the expanded
  tab list, and keeps the add/edit form scrollable within a small viewport.
- Failed SQS deliveries are no longer also selected by the scheduled pending-job
  sweep. SQS remains the single retry owner for failed records, preventing the
  duplicate delivery observed during the first live PDF validation.
- Repository result citations now render PDF pages, Word paragraphs, Excel
  ranges, PowerPoint slides, headings, and media time ranges through one labeler.

Verification evidence so far:

- The full application suite passes (252 suites, 2,994 tests; 5 suites and 60
  tests intentionally skipped), including generated DOCX/XLSX/PPTX package
  bytes, ZIP-expansion limits, admin visibility, and retry-ownership coverage.
- The infrastructure suite passes (29 suites, 325 tests), both application and
  dedicated worker typechecks pass, lint has zero errors, and the production
  build completes successfully.
- Authenticated Playwright repository upload contract: 3/3 workflows passed,
  including the canonical DOCX browser flow. The full browser regression passed
  246 tests with 58 intentional skips; the final Content Platform admin spec
  also passes against the authenticated local application.
- Real PostgreSQL smoke passed for PDF plus XLSX normalization, immutable
  publication, generation carry-forward, retrieval, and `Directory!A1:B2`
  citation resolution.
- All-stack CDK synthesis produced 31 CloudFormation stack artifacts with the
  real Office-capable worker bundle.

### Image ingestion checkpoint (2026-07-21)

Implemented on `codex/unified-content-image-ingestion`:

- The canonical repository upload contract and file picker accept JPEG, PNG,
  WebP, GIF, and TIFF. Source signatures are verified with Sharp, animated
  sources use a deterministic first frame, orientation is normalized, and the
  processor rejects decompression beyond its 100-megapixel safety ceiling.
- The worker produces bounded JPEG derivatives for previews, Amazon Nova image
  descriptions, and Textract OCR. It indexes caption and visible-text segments
  with normalized image-region citations and persists source, thumbnail,
  caption, layout/OCR, and canonical-text artifacts atomically.
- Image captioning defaults to the US cross-region Nova 2 Lite inference profile.
  The model and independent 50 MiB image ceiling are database-first admin
  settings. The Lambda role can invoke only US Amazon Nova profiles/models, and
  the Linux ARM64 Sharp/libvips package is pinned into the Lambda asset.
- Migration 118 adds the image repository-item type and seeds the two image
  settings. Processing telemetry records the caption model, token usage,
  latency, dimensions, thumbnail size, OCR job/object identity, and OCR lines.
- Legacy attachment storage no longer reads the documents bucket during module
  import. It resolves `S3_BUCKET` from the settings table at request time and
  falls back to `DOCUMENTS_BUCKET_NAME`, so production builds and live requests
  use the same database-first storage configuration.
- Canonical upload signing and repository image downloads now use that same
  database-first `S3_BUCKET` resolution instead of reading the infrastructure
  environment directly. Removing a document, image, or entire repository also
  deletes every source version and paginates through each canonical artifact
  namespace; non-current S3 versions remain governed by the bucket retention
  lifecycle.

Verification evidence:

- The full application CI suite passes (257 suites, 3,016 tests; 5 suites and
  60 tests intentionally skipped). Lint has zero errors and the application,
  infrastructure, and dedicated worker typechecks pass.
- The infrastructure suite passes (29 suites, 327 tests), the full infra build
  passes, and all-stack dev/prod CDK synthesis packages the real Linux ARM64
  Sharp worker with the bounded Bedrock IAM policy.
- The production Next.js build completes without a placeholder bucket
  environment variable, proving route imports no longer bypass the settings
  table.
- Focused lifecycle and configuration coverage verifies paginated artifact
  deletion, single-item and whole-repository image cleanup, image downloads,
  and canonical upload resolution through `Settings.getS3()`.
- Authenticated Playwright passes 245 tests with 58 intentional skips. Two
  unrelated live-collaboration/graph UI tests passed on retry; the canonical
  PDF, Office, and image upload browser contracts all passed.
- Real PostgreSQL smoke passed PDF, Office, and image publication, image
  artifacts, caption/OCR retrieval and citations, replay idempotency,
  quarantine, carry-forward, and active-generation guards.

### Media ingestion and embedding resilience checkpoint (2026-07-22)

Implemented on `codex/unified-content-media-ingestion`:

- The canonical upload contract and Repository Manager picker accept bounded
  audio (AMR, FLAC, M4A, MP3, Ogg, WAV) and video (MP4, MOV, AVI, MKV, WebM).
- One tagged Amazon Bedrock Data Automation project asynchronously produces
  transcripts, speaker/channel labels, topics, summaries, chapters, frame OCR,
  and exact timestamp/bounding-box citations. Large source media never enters
  Lambda memory, and deferred BDA polling does not consume the job retry budget.
- Canonical media publication persists source, BDA layout, transcript, summary,
  and searchable time-range segments. The upload contract enforces both the
  administrator storage policy and BDA's modality-specific byte ceilings.
- Repository embeddings default to IAM-authenticated Bedrock Titan Embeddings
  G1 so the existing `vector(1536)` schema remains nondestructively compatible.
  Migration 120 repairs only the broken legacy OpenAI default and exposes the
  provider/model/dimension settings in the admin UI.
- Index generations record a provider-qualified embedding descriptor. A model
  change clears carried-forward vectors in the new generation and queues every
  missing chunk, preventing mixed semantic spaces. Hybrid retrieval degrades to
  lexical results when an embedding provider is unavailable.
- The migration automatically replays one completed publication per affected
  repository when its active generation contains only null vectors. Embedding
  messages resolve the immutable generation descriptor before invocation, so an
  administrator changing the global setting cannot mix vector spaces in flight.
- Browser uploads normalize blank or generic `application/octet-stream` media
  declarations from the file extension before signing and persistence. BDA
  output discovery is paginated and namespace-bound, and the worker has only
  repository-prefix list access in addition to object-level access.
- The dev and prod permission boundaries allow only the two BDA runtime calls
  used by the worker (`InvokeDataAutomationAsync` and
  `GetDataAutomationStatus`); the worker policy further restricts invocation to
  its project, US cross-region profile, and generated invocation ARNs.

Local verification evidence:

- Application CI-safe suite: 260 suites and 3,029 tests passed; 5 suites and 60
  tests intentionally skipped. The unfiltered Jest command additionally proved
  why `test:ci` excludes live performance specs: those require a running server.
- Infrastructure/Lambda suite: 31 suites and 339 tests passed, including the
  real ARM64 worker bundle and BDA/IAM assertions.
- Authenticated Playwright upload contract: 5/5 workflows passed, including
  canonical audio and video plus generic-MIME MP4 normalization. Migrations 119
  and 120 applied successfully to a real local PostgreSQL database.
- Full lint has zero errors, and application, infrastructure worker, and
  standalone embedding-worker typechecks pass. The production Next.js build
  and all-stack dev/prod CDK synthesis also pass.

Live validation of the previously deployed image slice confirmed that the PNG
source reached canonical publication and embedding dispatch. The embedding
worker then received a provider `403` because the configured OpenAI project did
not have access to `text-embedding-3-small`; the Bedrock default, immutable
generation routing, lexical fallback, and automatic replay in this slice close
that observed failure mode.

The remaining checkpoint gate is a dev deployment and real BDA audio/video
validation.
