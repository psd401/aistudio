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
| `CONTENT_RETRIEVAL_RERANK_ENABLED` | `true` | Bedrock reranking after deterministic rank fusion; fails open to fusion |
| `CONTENT_RETRIEVAL_RERANK_MODEL_ID` | `cohere.rerank-v3-5:0` | Bedrock reranking model |
| `CONTENT_RETRIEVAL_CANDIDATE_LIMIT` | `40` | Lexical/dense/visual candidates considered before reranking |
| `CONTENT_RETRIEVAL_NEIGHBOR_COUNT` | `1` | Adjacent segments expanded on each side of a selected result |
| `CONTENT_RETRIEVAL_CONTEXT_TOKENS` | `4000` | Tokenizer-counted context budget per retrieval request |
| `CONTENT_RETRIEVAL_RRF_K` | `60` | Reciprocal-rank-fusion smoothing constant |
| `CONTENT_RETRIEVAL_MAX_PER_SOURCE` | `3` | Selected segments allowed per immutable source version |
| `CONTENT_VISUAL_EMBEDDING_MODEL_ID` | `cohere.embed-v4:0` | Bedrock Cohere multimodal embedding model |
| `CONTENT_VISUAL_EMBEDDING_DIMENSIONS` | `1536` | Visual vector width, fixed to the database schema |
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

The active Retrieval v2 branch is `codex/unified-content-retrieval-v2` in the
isolated worktree:

```text
/private/tmp/aistudio-unified-content-retrieval-v2
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
- [x] Retrieval v2 and visual search
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

### Retrieval v2 checkpoint (2026-07-22)

Implemented on `codex/unified-content-retrieval-v2`:

- Migration 121 adds tokenizer-aware hierarchy/context fields, segment ACLs, a
  generated PostgreSQL full-text index, optional `vector(1536)` visual
  embeddings, immutable segmentation/embedding descriptors, and bounded
  database-first retrieval settings.
- The shared retrieval service resolves each repository's active generation
  once, revalidates the executing user's repository and segment access, runs
  lexical, dense, and visual retrieval without mixing embedding spaces, fuses
  ranks deterministically, optionally reranks through Bedrock, diversifies by
  source, expands parent/neighbor context, enforces tokenizer-counted budgets,
  and emits exact immutable-version citations. Bedrock failures and the bounded
  five-second reranker deadline fail open to reciprocal-rank fusion.
- Repository Manager, Assistant Architect, and repository AI tools now share
  the `CONTENT_READ_V2_ENABLED` cutover boundary. While it is off, all three
  retain their legacy read path; while it is on, all three use Retrieval v2, so
  rollout and rollback are a single settings change. Assistant ownership never
  elevates the executing user's data access, and system-managed Atrium
  repositories remain isolated behind their specialized retrieval path.
- PDF, Office, image, and media processors emit structure-aware contextual
  segments. Image chunks can use Cohere Embed v4 interleaved thumbnail +
  caption/OCR inputs; media visual segments use BDA frame/on-screen semantics.
  Visual indexing remains independently controlled by
  `CONTENT_VISUAL_INDEX_ENABLED`.
- Generations requiring embeddings stay non-serving until every required text
  and visual vector exists. The embedding worker atomically supersedes the prior
  active generation, swaps the repository pointer, and marks included items
  embedded; late completion of a superseded generation is a safe no-op.
- The frontend ECS role grants Bedrock model invocation only on Bedrock model,
  inference-profile, and provisioned-model ARNs. The separate
  `bedrock:Rerank` action uses `Resource: "*"` because AWS does not support
  resource-level permissions for that API; a synthesis assertion guards both
  halves of this contract.
- A checked-in golden retrieval corpus measures recall@k, MRR, nDCG, citation
  validity, authorization leakage, p95 latency, and estimated average cost.

Verification evidence:

- Application CI suite: 268 suites and 3,059 tests passed; 5 suites and 60 tests
  intentionally skipped by the repository configuration.
- Infrastructure/Lambda suite: 33 suites and 348 tests passed, including the
  real ARM64 unified-content bundle, rerank IAM assertion, and read-only visual
  artifact access assertion.
- Authenticated Playwright: 248 tests passed and 58 intentionally skipped, with
  no failures or flakes. Content settings and canonical PDF, Office, image,
  audio, and video upload contracts passed through the real UI.
- Real PostgreSQL smoke passed exact citations, current-version and inspection
  filters, repository/segment ACLs, pre-activation invisibility, atomic
  generation switching, the single-active-generation constraint, and cleanup.
- Full lint completed with zero errors. Application, infrastructure,
  unified-content worker, and embedding-worker typechecks passed. The production
  Next.js build, complete infrastructure build, and all-stack synthesis of 29
  dev/prod templates passed.

The remaining rollout check is a dev deployment followed by real Bedrock Cohere
rerank/visual-embedding validation before visual indexing is enabled broadly.

### Retrieval v2 live-hardening checkpoint (2026-07-22)

The first dev cutover exposed two migration gaps that were not reproducible with
new canonical file uploads alone: pre-cutover URL/text chunks disappeared when
the v2 read flag was enabled, and newly created inline text still wrote only the
legacy item/chunk rows. The hardening slice closes both gaps without weakening
the single read-cutover boundary:

- Completed legacy-only chunks remain available through an explicit,
  repository-authorized lexical compatibility query until the same item appears
  in the repository's active canonical generation. Canonical content then wins
  automatically, so stale duplicate chunks cannot leak into results.
- Inline text is stored as an immutable repository-scoped S3 source, registered
  as a canonical version/job, and dispatched through the unified processor.
  Plain text, Markdown, and CSV now receive strict UTF-8 validation,
  tokenizer-aware segmentation, stable hashes, heading-aware locators, normal
  publication, embedding, generation activation, and exact citations.
- Both the direct legacy upload action and the presigned upload action now use
  the same fail-open canonical shadow-write helper for every supported canonical
  content type. A dispatch outage leaves an observable pending job for scheduled
  recovery instead of hiding the user's successful legacy upload.
- Retrieval diagnostics count repositories authorized by ACL even while they
  have no active canonical generation, making the compatibility window visible
  rather than reporting those repositories as unauthorized.

Verification evidence for the hardening slice:

- Application CI suite: 270 suites passed, 5 skipped; 3,070 tests passed and 60
  intentionally skipped. Infrastructure/Lambda suite: 33 suites and 348 tests
  passed.
- The real PostgreSQL unified-content smoke passed canonical inline-text
  publication/retrieval/citation and legacy compatibility, including automatic
  legacy suppression after canonical activation and cleanup.
- Full authenticated Playwright passed 248 tests with 58 environment-gated
  skips. The new inline-text workflow and canonical PDF, Office, image, audio,
  and video upload contracts all passed. One unrelated Atrium editor timing test
  passed on retry 2 and was reported as flaky; there were no genuine failures.
- Full lint completed with zero errors; root and worker typechecks, the complete
  infrastructure build, the production Next.js build, and all-stack no-lookup
  CDK synthesis passed.

The remaining rollout check is deployment of this hardening slice, followed by
live confirmation that the pre-cutover marker is searchable and that a new
inline-text item advances through version, job, generation, embedding, and
citation state in dev.

### Unified-content runtime recovery checkpoint (2026-07-22)

The first live hardening deployment exposed several related runtime gaps rather
than one isolated upload bug: inline text used a source namespace the worker
rejected, legacy completion could mask canonical failure, processor retries
could remain failed or invisible for hours, embedding failures could strand a
building generation, and Retrieval v2 could stop serving the last active
version while its replacement was still indexing. This corrective slice treats
the entire upload-to-retrieval lifecycle as one recoverable state machine:

- Every direct, multipart, and inline source now uses the single strict
  `repositories/{repositoryId}/{uuid}/{filename}` contract. Registration rejects
  cross-repository, nested, traversal-like, and artifact keys before a job is
  created. A bounded retry action copies legacy files into that namespace and
  creates a fresh immutable version for legacy inline text.
- Repository Manager projects the current canonical version, inspect job, and
  index generation instead of trusting legacy item status. Users see Pending,
  Processing, Retrying, Generating Embeddings, Embedded, or a terminal Failed
  state with its reason and an authorized Retry control.
- The processor distinguishes permanent source/contract failures from transient
  service failures, uses a five-attempt exponential retry budget, persists a
  pending database outbox before every SQS send, recovers pending and expired
  leases on the minute sweep, and bounds external security/OCR/media waits.
- Embedding work acknowledges stale generations, exposes a failure only on its
  terminal SQS receive, fails only the current building generation, and leaves
  the previous active generation serving. Activation requires all required text
  and visual vectors.
- Retrieval treats the repository's active generation as the immutable serving
  snapshot, fits the selected hit before neighbors, keeps text/citations paired,
  and bounds assistant tool payloads. Deletion now fails closed until source and
  derivative cleanup succeeds for documents, images, audio, video, and inline
  text.
- Migration 122 automatically retires pre-hardening stranded embedding
  generations and requeues recoverable current processor jobs. Content and
  embedding DLQ, oldest-message, and worker-error alarms make future stalls
  visible; queue-level processor redrive is bounded to five receives.

Verification evidence for the runtime recovery slice:

- Application CI suite: 275 suites passed, 5 skipped; 3,103 tests passed and 60
  intentionally skipped. Full lint has zero errors, and application,
  infrastructure, unified-content worker, and embedding-worker typechecks pass.
- Infrastructure/Lambda suite: 35 suites and 359 tests passed. The production
  Next.js build, complete infrastructure build, and synthesis of all 29 dev/prod
  stacks pass with the real ARM64 worker bundles and migration asset.
- Real PostgreSQL migration and smoke tests pass canonical status projection,
  terminal failure, a fresh manual retry budget, managed-service wait metadata,
  text/visual activation guards, active-generation retrieval/citations, and
  cleanup.
- Authenticated Playwright passed 255 tests with 53 intentional environment
  skips, covering the full application and the repository contract for direct,
  PDF, Office, image, audio, video, inline-text, canonical failure visibility,
  and Failed → Retry → Pending recovery.

The remaining rollout check is deployment of migration 122 and the corrected
workers, followed by a fresh live PDF/image/inline-text matrix through Embedded
and cited retrieval. No manual AWS CLI or database mutation is required.

### Post-deployment handoff hardening checkpoint (2026-07-22)

Live validation of the runtime-recovery rollout exposed a deployment-order race:
migrations run before the new Lambda code is active, so migration 122 released
recoverable jobs while the previous worker was still able to consume them. The
same validation also showed that terminal failed and cancelled jobs could be
presented as non-terminal, and a clean-database smoke exposed a nondeterministic
partial-unique-index conflict during generation activation. This hardening slice
closes the complete set before another deployment:

- Migrations 122 and 123 now quarantine eligible current inspect jobs as
  `cancelled` with an infinite availability time and a versioned handoff marker.
  Migration 123 safely repairs environments where the earlier form of migration
  122 already ran, but only for its marker, its explicit recovery error, the
  observed deployment-disabled state, or the legacy embedding-failure state.
  Unrelated terminal user failures, already-serving generations, noncanonical
  source keys, superseded versions, and security-blocked content are never
  reprocessed.
- The new unified-content worker releases quarantined jobs in bounded,
  transactionally claimed batches during its scheduled sweep, after a 20-minute
  drain window longer than the previous Lambda's maximum execution time. It can
  reclaim a marked row whose status was overwritten by an invocation already in
  flight when the migration committed. Release resets attempts, leases,
  timestamps, errors, and provider metrics before normal dispatch, so the
  previous worker cannot win the migration-to-code deployment gap and stale
  Textract/BDA state cannot influence the retry.
- Failed and cancelled inspect jobs are terminal in repository status
  projection. Authorized manual retry accepts either state and creates a fresh
  five-attempt budget with cleared inspection/provider state; only genuinely
  pending work with prior attempts is shown as Retrying.
- Generation activation now uses an ordered four-statement transaction: lock the
  repository, supersede its current generation, activate the fully embedded
  target, then publish the repository pointer and included items. The target is
  rechecked at activation time and duplicate completion messages remain
  idempotent, eliminating the partial unique-index ordering race.
- The repository E2E fixture reproduces the exact live failed-job shape
  (`attempt=1`, `max_attempts=20`, stale provider metrics), and the Assistant
  Architect persistence test now opens its named deterministic fixture instead
  of whichever architect happened to sort first.

Verification evidence for the handoff hardening slice:

- Application CI suite: 275 suites passed, 5 skipped; 3,108 tests passed and 60
  intentionally skipped. Infrastructure/Lambda suite: 35 suites and 359 tests
  passed, including the real ARM64 worker bundle.
- Full authenticated Playwright passed 257 tests with 51 intentional
  environment-gated skips and zero failures. The repository matrix covers inline
  text, PDF, Office, image, audio, video, terminal failure visibility, and
  Failed/Cancelled -> Retry -> Pending recovery.
- Real PostgreSQL smoke passed the exact migration-before-worker handoff,
  preservation of unrelated terminal failures, old-worker exclusion, the
  20-minute drain guard, bounded new-worker release, noncanonical-source
  exclusion, retry-state reset, PDF/Office/image publication and citations,
  ordered generation activation, duplicate activation, the single-active-
  generation constraint, and cleanup.
- Full lint completed with zero errors. Application, infrastructure,
  unified-content worker, and embedding-worker typechecks pass. The production
  Next.js build, complete infrastructure build, and all-stack no-lookup CDK
  synthesis of 29 dev/prod templates pass.

The remaining rollout check is one dev deployment followed by a single live
inline-text/PDF/image matrix and verification that migration 123 jobs are
released only by the new scheduled worker after the drain window. Recovery can
therefore remain visibly quarantined for up to 20 minutes after the migration.
No manual AWS CLI or database mutation is part of the rollout.
