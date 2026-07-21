-- Migration 116: Unified repository content foundation (Epic #1261, #1265)
--
-- Evolves the existing knowledge-repository spine into the canonical ingestion
-- and retrieval substrate used by Repository Manager, Nexus, Assistant
-- Architect, Atrium, synchronized sources, and external agents.
--
-- IMPORTANT:
--   * This migration is additive. Existing repository reads/writes continue to
--     work when all CONTENT_* rollout settings are false.
--   * VARCHAR + CHECK constraints are used instead of PostgreSQL enums so later
--     stages/modalities can be extended without enum-ownership problems.
--   * Existing repository_items and chunks remain valid with NULL canonical
--     references until the backfill/cutover workstream.
--   * updated_at columns have database triggers as a backstop. Application code
--     still updates them explicitly on state transitions.
--   * No DO $$ blocks: the migration runner's statement splitter cannot safely
--     process them (see migrations 079 and 085).

-- ---------------------------------------------------------------------------
-- 1. Repository lifecycle: durable, ephemeral, or system-managed containers.
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_repositories
  ADD COLUMN IF NOT EXISTS repository_kind varchar(16) NOT NULL DEFAULT 'durable';
ALTER TABLE knowledge_repositories
  ADD COLUMN IF NOT EXISTS lifecycle_status varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE knowledge_repositories
  ADD COLUMN IF NOT EXISTS retention_days integer;
ALTER TABLE knowledge_repositories
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE knowledge_repositories
  DROP CONSTRAINT IF EXISTS chk_knowledge_repositories_kind;
ALTER TABLE knowledge_repositories
  ADD CONSTRAINT chk_knowledge_repositories_kind
  CHECK (repository_kind IN ('durable', 'ephemeral', 'system'));
ALTER TABLE knowledge_repositories
  DROP CONSTRAINT IF EXISTS chk_knowledge_repositories_lifecycle;
ALTER TABLE knowledge_repositories
  ADD CONSTRAINT chk_knowledge_repositories_lifecycle
  CHECK (lifecycle_status IN ('active', 'expired', 'deleting', 'deleted'));
ALTER TABLE knowledge_repositories
  DROP CONSTRAINT IF EXISTS chk_knowledge_repositories_retention;
ALTER TABLE knowledge_repositories
  ADD CONSTRAINT chk_knowledge_repositories_retention
  CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650);

-- Preserve the existing Atrium retrieval repository's system boundary.
UPDATE knowledge_repositories
   SET repository_kind = 'system'
 WHERE metadata ->> 'systemManaged' = 'true'
   AND repository_kind <> 'system';

CREATE INDEX IF NOT EXISTS idx_knowledge_repositories_lifecycle
  ON knowledge_repositories (repository_kind, lifecycle_status, expires_at);

-- ---------------------------------------------------------------------------
-- 2. Stable logical item identity and lifecycle.
-- ---------------------------------------------------------------------------
ALTER TABLE repository_items
  ADD COLUMN IF NOT EXISTS stable_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE repository_items
  ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE repository_items
  ADD COLUMN IF NOT EXISTS lifecycle_status varchar(20) NOT NULL DEFAULT 'active';
ALTER TABLE repository_items
  ADD COLUMN IF NOT EXISTS source_external_id text;
ALTER TABLE repository_items
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE repository_items
  DROP CONSTRAINT IF EXISTS chk_repository_items_lifecycle;
ALTER TABLE repository_items
  ADD CONSTRAINT chk_repository_items_lifecycle
  CHECK (lifecycle_status IN ('active', 'unavailable', 'expired', 'deleting', 'deleted'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_items_stable_id
  ON repository_items (stable_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_items_external_source
  ON repository_items (repository_id, source_external_id)
  WHERE source_external_id IS NOT NULL AND lifecycle_status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_repository_items_lifecycle
  ON repository_items (repository_id, lifecycle_status, expires_at);

-- ---------------------------------------------------------------------------
-- 3. Immutable source versions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repository_item_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id integer NOT NULL REFERENCES repository_items(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  source_kind varchar(24) NOT NULL,
  source_revision varchar(512),
  object_key text,
  declared_content_type varchar(255),
  detected_content_type varchar(255),
  byte_size bigint,
  sha256 char(64),
  storage_status varchar(20) NOT NULL DEFAULT 'quarantined',
  inspection_status varchar(20) NOT NULL DEFAULT 'pending',
  inspection_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status varchar(20) NOT NULL DEFAULT 'pending',
  processor_version varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_repository_item_version_number CHECK (version_number > 0),
  CONSTRAINT chk_repository_item_version_source_kind
    CHECK (source_kind IN ('upload', 'url', 'text', 'google_drive', 'atrium', 'api', 'migration')),
  CONSTRAINT chk_repository_item_version_byte_size CHECK (byte_size IS NULL OR byte_size >= 0),
  CONSTRAINT chk_repository_item_version_sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_repository_item_version_storage
    CHECK (storage_status IN ('quarantined', 'available', 'blocked', 'deleted')),
  CONSTRAINT chk_repository_item_version_inspection
    CHECK (inspection_status IN ('pending', 'clean', 'blocked', 'error', 'not_required')),
  CONSTRAINT chk_repository_item_version_processing
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT uq_repository_item_version_number UNIQUE (item_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_item_source_revision
  ON repository_item_versions (item_id, source_revision)
  WHERE source_revision IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repository_item_versions_item_created
  ON repository_item_versions (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_item_versions_processing
  ON repository_item_versions (processing_status, created_at);

ALTER TABLE repository_items
  DROP CONSTRAINT IF EXISTS fk_repository_items_current_version;
ALTER TABLE repository_items
  ADD CONSTRAINT fk_repository_items_current_version
  FOREIGN KEY (current_version_id) REFERENCES repository_item_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 4. Secure resumable-upload sessions. The multipart upload id is server-side
--    coordination data and is never returned by repository read APIs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repository_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id integer NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  item_version_id uuid REFERENCES repository_item_versions(id) ON DELETE SET NULL,
  created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  multipart_upload_id text,
  upload_method varchar(16) NOT NULL,
  part_size bigint,
  part_count integer,
  item_name varchar(500) NOT NULL,
  original_file_name varchar(500) NOT NULL,
  declared_content_type varchar(255) NOT NULL,
  expected_byte_size bigint NOT NULL,
  expected_sha256 char(64),
  status varchar(20) NOT NULL DEFAULT 'initiated',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_repository_upload_size CHECK (expected_byte_size > 0),
  CONSTRAINT chk_repository_upload_method CHECK (upload_method IN ('single', 'multipart')),
  CONSTRAINT chk_repository_upload_parts CHECK (
    (upload_method = 'single' AND part_size IS NULL AND part_count IS NULL)
    OR
    (upload_method = 'multipart' AND part_size >= 5242880 AND part_count BETWEEN 2 AND 10000)
  ),
  CONSTRAINT chk_repository_upload_sha256 CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_repository_upload_status
    CHECK (status IN ('initiated', 'uploading', 'uploaded', 'completed', 'aborted', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_upload_object_key
  ON repository_upload_sessions (object_key);
CREATE INDEX IF NOT EXISTS idx_repository_upload_expiry
  ON repository_upload_sessions (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_repository_upload_owner
  ON repository_upload_sessions (created_by, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Durable, idempotent stage jobs. A pending job is the durable handoff
--    record; dispatchers may safely retry queue delivery using idempotency_key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repository_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_version_id uuid NOT NULL REFERENCES repository_item_versions(id) ON DELETE CASCADE,
  stage varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  idempotency_key varchar(255) NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(255),
  lease_expires_at timestamptz,
  trace_id varchar(128),
  last_error_code varchar(128),
  last_error_message text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_repository_processing_stage
    CHECK (stage IN ('inspect', 'normalize', 'enrich', 'segment', 'embed', 'publish', 'purge')),
  CONSTRAINT chk_repository_processing_status
    CHECK (status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT chk_repository_processing_attempt CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT uq_repository_processing_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_repository_processing_dispatch
  ON repository_processing_jobs (status, available_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_repository_processing_lease
  ON repository_processing_jobs (status, lease_expires_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_repository_processing_version
  ON repository_processing_jobs (item_version_id, created_at);

-- ---------------------------------------------------------------------------
-- 6. Derived multimodal artifacts with exact source ranges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repository_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_version_id uuid NOT NULL REFERENCES repository_item_versions(id) ON DELETE CASCADE,
  artifact_key varchar(255) NOT NULL,
  kind varchar(32) NOT NULL,
  media_type varchar(255) NOT NULL,
  object_key text,
  text_inline text,
  sha256 char(64),
  page_from integer,
  page_to integer,
  time_start_ms bigint,
  time_end_ms bigint,
  source_regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processor_name varchar(128) NOT NULL,
  processor_version varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_repository_artifact_kind
    CHECK (kind IN ('source', 'canonical_text', 'markdown', 'layout', 'table', 'image', 'thumbnail', 'audio', 'transcript', 'caption')),
  CONSTRAINT chk_repository_artifact_payload CHECK (object_key IS NOT NULL OR text_inline IS NOT NULL),
  CONSTRAINT chk_repository_artifact_sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_repository_artifact_pages
    CHECK ((page_from IS NULL AND page_to IS NULL) OR (page_from > 0 AND page_to >= page_from)),
  CONSTRAINT chk_repository_artifact_time
    CHECK ((time_start_ms IS NULL AND time_end_ms IS NULL) OR (time_start_ms >= 0 AND time_end_ms >= time_start_ms)),
  CONSTRAINT uq_repository_artifact_key UNIQUE (artifact_key)
);

CREATE INDEX IF NOT EXISTS idx_repository_artifacts_version_kind
  ON repository_artifacts (item_version_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- 7. Atomic repository index generations. Only one active generation is
--    allowed for a repository. Failed builds never replace the active one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repository_index_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id integer NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'building',
  embedding_model varchar(255),
  embedding_dimensions integer,
  processor_version varchar(128) NOT NULL,
  source_version_count integer NOT NULL DEFAULT 0,
  segment_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT chk_repository_index_generation_status
    CHECK (status IN ('building', 'active', 'superseded', 'failed')),
  CONSTRAINT chk_repository_index_generation_dimensions
    CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0),
  CONSTRAINT chk_repository_index_generation_counts
    CHECK (source_version_count >= 0 AND segment_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_active_generation
  ON repository_index_generations (repository_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_repository_index_generations_history
  ON repository_index_generations (repository_id, created_at DESC);

ALTER TABLE knowledge_repositories
  ADD COLUMN IF NOT EXISTS active_index_generation_id uuid;
ALTER TABLE knowledge_repositories
  DROP CONSTRAINT IF EXISTS fk_knowledge_repositories_active_generation;
ALTER TABLE knowledge_repositories
  ADD CONSTRAINT fk_knowledge_repositories_active_generation
  FOREIGN KEY (active_index_generation_id) REFERENCES repository_index_generations(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 8. Extend existing chunks into source-anchored multimodal segments. Nullable
--    references preserve all legacy chunks until backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS item_version_id uuid;
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS artifact_id uuid;
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS index_generation_id uuid;
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS modality varchar(16) NOT NULL DEFAULT 'text';
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS content_hash char(64);
ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS source_locator jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS fk_repository_chunks_item_version;
ALTER TABLE repository_item_chunks
  ADD CONSTRAINT fk_repository_chunks_item_version
  FOREIGN KEY (item_version_id) REFERENCES repository_item_versions(id) ON DELETE CASCADE;
ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS fk_repository_chunks_artifact;
ALTER TABLE repository_item_chunks
  ADD CONSTRAINT fk_repository_chunks_artifact
  FOREIGN KEY (artifact_id) REFERENCES repository_artifacts(id) ON DELETE SET NULL;
ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS fk_repository_chunks_index_generation;
ALTER TABLE repository_item_chunks
  ADD CONSTRAINT fk_repository_chunks_index_generation
  FOREIGN KEY (index_generation_id) REFERENCES repository_index_generations(id) ON DELETE CASCADE;
ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS chk_repository_chunks_modality;
ALTER TABLE repository_item_chunks
  ADD CONSTRAINT chk_repository_chunks_modality
  CHECK (modality IN ('text', 'image', 'audio', 'video', 'table'));
ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS chk_repository_chunks_content_hash;
ALTER TABLE repository_item_chunks
  ADD CONSTRAINT chk_repository_chunks_content_hash
  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS idx_repository_chunks_generation
  ON repository_item_chunks (index_generation_id, item_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_repository_chunks_version
  ON repository_item_chunks (item_version_id, chunk_index);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_chunks_generation_index
  ON repository_item_chunks (item_version_id, index_generation_id, chunk_index)
  WHERE item_version_id IS NOT NULL AND index_generation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9. Database-first rollout and policy settings. Generic admin settings can
--    edit these immediately; a guided content-platform card follows in #1268.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  ('CONTENT_PLATFORM_ENABLED', 'false', 'Enable the unified repository content platform.', 'Content Platform', false),
  ('CONTENT_DUAL_WRITE_ENABLED', 'false', 'Write canonical content records alongside legacy repository processing.', 'Content Platform', false),
  ('CONTENT_READ_V2_ENABLED', 'false', 'Read repository search results from active canonical index generations.', 'Content Platform', false),
  ('NEXUS_ATTACHMENT_RETENTION_DAYS', '30', 'Days to retain private one-off Nexus attachment repositories.', 'Content Platform', false),
  ('CONTENT_DELETION_GRACE_DAYS', '7', 'Recovery window before expired content is physically deleted.', 'Content Platform', false),
  ('CONTENT_MAX_FILE_SIZE_GB', '10', 'Maximum source upload size in GiB.', 'Content Platform', false),
  ('CONTENT_MAX_PDF_SIZE_MB', '500', 'Maximum PDF size for the canonical PDF processor (Amazon Textract hard limit).', 'Content Platform', false),
  ('CONTENT_MAX_MEDIA_HOURS', '4', 'Maximum audio or video duration in hours.', 'Content Platform', false),
  ('CONTENT_MALWARE_SCAN_REQUIRED', 'true', 'Require a successful malware policy decision before quarantine release.', 'Content Platform', false),
  ('CONTENT_OCR_STRATEGY', 'auto', 'OCR strategy: auto, textract, or disabled.', 'Content Platform', false),
  ('CONTENT_VISUAL_INDEX_ENABLED', 'false', 'Enable visual artifact embeddings in canonical index generations.', 'Content Platform', false),
  ('GOOGLE_CONTENT_SYNC_ENABLED', 'false', 'Enable Google Workspace repository synchronization.', 'Content Platform', false),
  ('GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES', '15', 'Google Workspace reconciliation interval in minutes.', 'Content Platform', false)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. updated_at trigger backstops.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_repository_upload_sessions_updated_at ON repository_upload_sessions;
CREATE TRIGGER trg_repository_upload_sessions_updated_at
  BEFORE UPDATE ON repository_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_repository_processing_jobs_updated_at ON repository_processing_jobs;
CREATE TRIGGER trg_repository_processing_jobs_updated_at
  BEFORE UPDATE ON repository_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
