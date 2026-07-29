-- Migration 155: Unified-content backfill, reconciliation, and retirement gates
-- (Epic #1261, Issue #1267).
--
-- This migration is deliberately additive. Legacy rows and infrastructure stay
-- intact until an administrator has completed a dry run, verified every
-- recoverable source, exercised rollback, and allowed the recovery/quiet window
-- to expire. The application and CDK retirement mode enforce those gates.

CREATE TABLE IF NOT EXISTS repository_migration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode VARCHAR(24) NOT NULL
    CHECK (mode IN ('dry_run', 'backfill', 'reconcile', 'rollback')),
  status VARCHAR(32) NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'running',
        'completed',
        'completed_with_errors',
        'failed',
        'blocked',
        'rolled_back'
      )
    ),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_kinds JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_kinds) = 'array'),
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(cursor) = 'object'),
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(snapshot) = 'object'),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metrics) = 'object'),
  recovery_window_ends_at TIMESTAMPTZ,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_migration_runs_status_created
  ON repository_migration_runs(status, created_at);

DROP TRIGGER IF EXISTS trg_repository_migration_runs_updated_at
  ON repository_migration_runs;
CREATE TRIGGER trg_repository_migration_runs_updated_at
  BEFORE UPDATE ON repository_migration_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS repository_migration_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL
    REFERENCES repository_migration_runs(id) ON DELETE CASCADE,
  origin_run_id UUID NOT NULL
    REFERENCES repository_migration_runs(id) ON DELETE CASCADE,
  source_kind VARCHAR(32) NOT NULL
    CHECK (
      source_kind IN (
        'repository_item',
        'nexus_document',
        'assistant_pdf_job'
      )
    ),
  source_id BIGINT NOT NULL CHECK (source_id > 0),
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_repository_id INTEGER
    REFERENCES knowledge_repositories(id) ON DELETE SET NULL,
  canonical_repository_id INTEGER
    REFERENCES knowledge_repositories(id) ON DELETE SET NULL,
  canonical_item_id INTEGER REFERENCES repository_items(id) ON DELETE SET NULL,
  canonical_version_id UUID
    REFERENCES repository_item_versions(id) ON DELETE SET NULL,
  source_object_key TEXT,
  canonical_object_key TEXT,
  source_record_count INTEGER
    CHECK (source_record_count IS NULL OR source_record_count >= 0),
  canonical_record_count INTEGER
    CHECK (canonical_record_count IS NULL OR canonical_record_count >= 0),
  source_content_sha256 CHAR(64),
  canonical_content_sha256 CHAR(64),
  source_object_sha256 CHAR(64),
  canonical_object_sha256 CHAR(64),
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'migrating',
        'migrated',
        'verified',
        'mismatch',
        'failed',
        'unrecoverable',
        'rolled_back'
      )
    ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code VARCHAR(128),
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  migrated_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_repository_migration_source UNIQUE (source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_repository_migration_items_run_status
  ON repository_migration_items(run_id, status, source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_repository_migration_items_origin_run
  ON repository_migration_items(origin_run_id, status);
CREATE INDEX IF NOT EXISTS idx_repository_migration_items_canonical_item
  ON repository_migration_items(canonical_item_id)
  WHERE canonical_item_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_repository_migration_items_updated_at
  ON repository_migration_items;
CREATE TRIGGER trg_repository_migration_items_updated_at
  BEFORE UPDATE ON repository_migration_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS repository_retrieval_shadow_observations (
  id BIGSERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL
    REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  product VARCHAR(32) NOT NULL
    CHECK (product IN ('repository_manager', 'nexus', 'assistant_architect')),
  search_mode VARCHAR(16) NOT NULL
    CHECK (search_mode IN ('vector', 'keyword', 'hybrid')),
  legacy_result_count INTEGER NOT NULL CHECK (legacy_result_count >= 0),
  canonical_result_count INTEGER NOT NULL CHECK (canonical_result_count >= 0),
  overlapping_item_count INTEGER NOT NULL CHECK (overlapping_item_count >= 0),
  legacy_duration_ms INTEGER NOT NULL CHECK (legacy_duration_ms >= 0),
  canonical_duration_ms INTEGER NOT NULL CHECK (canonical_duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_retrieval_shadow_created
  ON repository_retrieval_shadow_observations(created_at);
CREATE INDEX IF NOT EXISTS idx_repository_retrieval_shadow_repository
  ON repository_retrieval_shadow_observations(repository_id, created_at);

-- Immutable evidence written by the explicit post-cutover finalizer. Keeping
-- this outside the legacy tables preserves the last verified row counts after
-- those tables are removed.
CREATE TABLE IF NOT EXISTS repository_legacy_retirement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_by TEXT NOT NULL DEFAULT CURRENT_USER,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  (
    'CONTENT_REPOSITORY_CUTOVER_ENABLED',
    'false',
    'Serve Repository Manager uploads and retrieval from the canonical content platform.',
    'Content Platform',
    false
  ),
  (
    'CONTENT_NEXUS_CUTOVER_ENABLED',
    'false',
    'Serve Nexus attachments from private canonical repositories without legacy document processing fallback.',
    'Content Platform',
    false
  ),
  (
    'CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED',
    'false',
    'Serve Assistant Architect document ingestion from canonical repositories and retire legacy PDF conversion writes.',
    'Content Platform',
    false
  ),
  (
    'CONTENT_RETRIEVAL_SHADOW_ENABLED',
    'false',
    'Compare legacy and canonical Repository Manager retrieval while legacy reads remain authoritative.',
    'Content Platform',
    false
  ),
  (
    'CONTENT_LEGACY_RETIREMENT_ENABLED',
    'false',
    'Disable legacy content mutation routes after verified migration and the recovery window.',
    'Content Platform',
    false
  ),
  (
    'CONTENT_MIGRATION_RECOVERY_DAYS',
    '7',
    'Minimum verified rollback and quiet window before legacy content retirement.',
    'Content Platform',
    false
  )
ON CONFLICT (key) DO NOTHING;
