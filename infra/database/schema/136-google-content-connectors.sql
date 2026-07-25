-- Google Workspace synchronized repository sources (Epic #1261 / Issue #1262).
-- Additive only: legacy and canonical upload paths remain untouched.

CREATE TABLE IF NOT EXISTS repository_connector_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id INTEGER NOT NULL
    REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_repository_connector_credentials_provider
    CHECK (provider IN ('google_drive'))
);

CREATE INDEX IF NOT EXISTS idx_repository_connector_credentials_user
  ON repository_connector_credentials(repository_id, user_id, provider);

CREATE TABLE IF NOT EXISTS repository_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id INTEGER NOT NULL
    REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  auth_mode VARCHAR(32) NOT NULL,
  -- Owner-neutral on user deletion: the connector record must outlive its
  -- creator so imported repository_items keep a connector to reconcile and
  -- disconnect against. Cascading here would orphan indexed items.
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  credential_id UUID
    REFERENCES repository_connector_credentials(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  shared_drive_id TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  cursor TEXT,
  watch_channel_id UUID,
  watch_resource_id TEXT,
  watch_token_hash VARCHAR(64),
  watch_expires_at TIMESTAMPTZ,
  last_notification_number BIGINT,
  -- Monotonic counter bumped whenever the active selection set changes. A sync
  -- run captures it when it loads the connector and refuses to persist its
  -- cursor at completion if the value moved, so a concurrent selection reset is
  -- never overwritten by the run it superseded.
  selection_version INTEGER NOT NULL DEFAULT 0,
  -- NULL means "inherit GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES"; a value is a
  -- per-connector override. A NOT NULL default would pin every connector to the
  -- column default and make the global setting unreachable.
  sync_interval_minutes INTEGER,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_code VARCHAR(128),
  last_error_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_repository_connectors_provider
    CHECK (provider IN ('google_drive')),
  CONSTRAINT chk_repository_connectors_auth_mode
    CHECK (auth_mode IN ('personal_oauth', 'shared_drive_wif')),
  CONSTRAINT chk_repository_connectors_status
    CHECK (status IN ('pending', 'active', 'degraded', 'paused', 'revoked')),
  -- personal_oauth tolerates a NULL credential_id: deleting the owning user
  -- cascades the credential away and SET NULLs this column, and the surviving
  -- connector is then reported as unauthorized rather than blocking the delete.
  CONSTRAINT chk_repository_connectors_auth_shape
    CHECK (
      (
        auth_mode = 'personal_oauth'
        AND shared_drive_id IS NULL
      )
      OR
      (
        auth_mode = 'shared_drive_wif'
        AND credential_id IS NULL
        AND shared_drive_id IS NOT NULL
      )
    ),
  CONSTRAINT chk_repository_connectors_sync_interval
    CHECK (sync_interval_minutes IS NULL OR sync_interval_minutes BETWEEN 5 AND 1440),
  CONSTRAINT chk_repository_connectors_selection_version
    CHECK (selection_version >= 0),
  CONSTRAINT chk_repository_connectors_failure_count
    CHECK (consecutive_failures >= 0)
);

CREATE INDEX IF NOT EXISTS idx_repository_connectors_due
  ON repository_connectors(status, next_sync_at);
CREATE INDEX IF NOT EXISTS idx_repository_connectors_repository
  ON repository_connectors(repository_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_connectors_personal
  ON repository_connectors(repository_id, provider, auth_mode, created_by)
  WHERE auth_mode = 'personal_oauth';
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_connectors_shared_drive
  ON repository_connectors(repository_id, provider, shared_drive_id)
  WHERE auth_mode = 'shared_drive_wif';
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_connectors_watch_channel
  ON repository_connectors(watch_channel_id)
  WHERE watch_channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS repository_connector_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL
    REFERENCES repository_connectors(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  selection_kind VARCHAR(16) NOT NULL,
  display_name TEXT NOT NULL,
  include_descendants BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_repository_connector_selections_external
    UNIQUE (connector_id, external_id),
  CONSTRAINT chk_repository_connector_selections_kind
    CHECK (selection_kind IN ('file', 'folder', 'drive'))
);

CREATE INDEX IF NOT EXISTS idx_repository_connector_selections_active
  ON repository_connector_selections(connector_id, active);

CREATE TABLE IF NOT EXISTS repository_connector_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL
    REFERENCES repository_connectors(id) ON DELETE CASCADE,
  repository_item_id INTEGER NOT NULL
    REFERENCES repository_items(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  drive_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  parent_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_revision TEXT,
  modified_time TIMESTAMPTZ,
  checksum VARCHAR(128),
  current_item_version_id UUID
    REFERENCES repository_item_versions(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  missing_since TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_repository_connector_sources_external
    UNIQUE (connector_id, external_id),
  CONSTRAINT uq_repository_connector_sources_item
    UNIQUE (repository_item_id),
  CONSTRAINT chk_repository_connector_sources_status
    CHECK (status IN ('active', 'missing', 'access_lost', 'deleted', 'unsupported', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_repository_connector_sources_missing
  ON repository_connector_sources(status, missing_since);

CREATE TABLE IF NOT EXISTS repository_connector_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL
    REFERENCES repository_connectors(id) ON DELETE CASCADE,
  trigger VARCHAR(20) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  cursor_before TEXT,
  cursor_after TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_code VARCHAR(128),
  error_message TEXT,
  trace_id VARCHAR(128),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT chk_repository_connector_sync_runs_trigger
    CHECK (trigger IN ('initial', 'schedule', 'notification', 'manual', 'recovery')),
  CONSTRAINT chk_repository_connector_sync_runs_status
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT chk_repository_connector_sync_runs_counts
    CHECK (
      discovered_count >= 0
      AND created_count >= 0
      AND updated_count >= 0
      AND unchanged_count >= 0
      AND missing_count >= 0
      AND failed_count >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_repository_connector_sync_runs_connector
  ON repository_connector_sync_runs(connector_id, started_at);

DROP TRIGGER IF EXISTS trg_repository_connector_credentials_updated_at
  ON repository_connector_credentials;
CREATE TRIGGER trg_repository_connector_credentials_updated_at
BEFORE UPDATE ON repository_connector_credentials
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_repository_connectors_updated_at
  ON repository_connectors;
CREATE TRIGGER trg_repository_connectors_updated_at
BEFORE UPDATE ON repository_connectors
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_repository_connector_selections_updated_at
  ON repository_connector_selections;
CREATE TRIGGER trg_repository_connector_selections_updated_at
BEFORE UPDATE ON repository_connector_selections
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_repository_connector_sources_updated_at
  ON repository_connector_sources;
CREATE TRIGGER trg_repository_connector_sources_updated_at
BEFORE UPDATE ON repository_connector_sources
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
