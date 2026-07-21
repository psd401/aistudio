# ADR-007: Unify ingestion and retrieval around repositories

**Status:** Accepted
**Date:** 2026-07-21
**Decision owners:** AI Studio engineering and product
**Implementation plan:** [Unified Content and Repository Platform](../../plans/2026-07-21-unified-content-platform.md)

## Context

Nexus attachments, Assistant Architect PDF imports, and Repository Manager
uploads currently use separate storage, processing, job, and context-delivery
paths. They have different size ceilings and format support, perform expensive
work in web or legacy Lambda processes, and cannot consistently provide source
versioning, exact citations, synchronized external content, or multimodal
retrieval.

AI Studio also has two mature models that solve different parts of the problem:

- Atrium `content_objects` and immutable `content_versions` represent authored,
  publishable documents and artifacts with provenance and fine-grained
  visibility.
- `knowledge_repositories`, `repository_items`, chunks, access rows, and existing
  Assistant Architect bindings represent knowledge containers and retrieval.

Replacing either model would create a risky migration and erase useful domain
distinctions. Adding another independent asset model would deepen the current
fragmentation.

## Decision

Repository is the universal knowledge container and product interface.
`knowledge_repositories` and `repository_items` remain the stable backbone.
Additive, normalized records provide immutable item versions, derived artifacts,
processing attempts, external connectors, and atomic index generations.

Atrium remains the authored/published-content domain. Its existing
`content_index_links` explicitly links an authored object to a repository item;
future provenance links may point from authored versions to source item versions.
A raw upload is not automatically an Atrium document.

All ingestion surfaces call one repository application service. Processing is an
asynchronous, idempotent state machine over immutable source versions. Product
surfaces consume permission-aware retrieval results with citations instead of
injecting whole extracted documents into prompts.

The implementation is provider-neutral at the canonical boundary. AWS managed
services are preferred initially for operational consistency, while processor
name/version and artifacts are recorded so Bedrock Data Automation, Textract,
Docling, transcription, or embedding implementations can change independently.

## Security decisions

- UI capabilities, API-key scopes, and per-repository ACLs remain distinct and
  are all enforced at their proper boundary.
- Search applies repository authorization before disclosing candidates and
  re-checks current access before returning source content.
- Quarantined or partially processed versions cannot enter an active index.
- Connector credentials are stored by reference in an approved secret/token
  store, not in repository metadata.
- Nexus ephemeral repositories are private to their owner and expire by policy.
- Assistant execution uses the executing user's effective access and cannot gain
  content access merely because an assistant was configured by someone else.

## Consequences

### Positive

- One upload/sync path and one observable state model serve all product surfaces.
- Existing repository IDs and Assistant Architect bindings remain valid.
- Immutable versions make synchronization, citations, reproducibility, rollback,
  and reprocessing reliable.
- Exact source anchors and modality-aware artifacts enable future visual and
  time-based retrieval without another migration.
- Additive dual-write rollout limits cutover risk.

### Costs

- Existing repository items need a backfill version before they fully use the new
  pipeline.
- Workers, UI, and retrieval must tolerate mixed legacy/canonical records during
  migration.
- A universal service increases the importance of strict authorization,
  idempotency, observability, and lifecycle testing.
- Google synchronization and delegated agent access require infrastructure and
  administrator consent outside the application repository.

## Alternatives rejected

### Make Atrium content objects the universal file model

Rejected because Atrium objects are authored/publishable content with different
lifecycle and visibility semantics. Treating every uploaded PDF, video, or Drive
file as an authored intranet object would conflate source material with a
publication.

### Replace repositories with a new asset service

Rejected because repository access, Assistant Architect bindings, pgvector
retrieval, UI, and MCP tooling already depend on stable repository identities. An
in-place additive evolution is safer and faster.

### Keep three pipelines and share only parsers

Rejected because parser reuse does not solve lifecycle, permissions, source
versioning, connector synchronization, citations, retries, or operational drift.

### Depend directly on a single managed knowledge-base product

Rejected as the system of record because it would couple permissions, citations,
and source history to provider-specific behavior. Managed processors and indexes
may be adapters, but AI Studio owns the canonical records and authorization.

## Rollout

1. Add canonical records and typed settings with all flags off.
2. Dual-write a Repository Manager PDF and compare legacy/canonical outputs.
3. Publish a canonical index generation and expose it to allowlisted dev users.
4. Migrate Assistant Architect uploads and Nexus ephemeral attachments.
5. Add formats, visual/media processing, Google synchronization, and agent tools.
6. Backfill existing data, progressively switch reads, observe a quiet period,
   and only then remove legacy routes and processors.

Rollback before retirement is a settings change that returns reads/writes to the
legacy path. Canonical records remain for diagnosis and safe replay.
