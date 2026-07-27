-- Migration 160: keep intentionally unsupported connector sources out of the
-- legacy-content retirement denominator without erasing their audit evidence.
--
-- Google Drive discovery records unsupported MIME types so operators can see
-- them, but those rows have no canonical version by design. Migration 155
-- originally treated every active document row as recoverable legacy content,
-- which mislabeled unsupported connector discoveries as source loss and made
-- retirement impossible. `excluded` is an explicit, durable non-migration
-- disposition; it is never used for a source that created canonical data.

ALTER TABLE repository_migration_items
  DROP CONSTRAINT IF EXISTS repository_migration_items_status_check;

ALTER TABLE repository_migration_items
  ADD CONSTRAINT repository_migration_items_status_check
  CHECK (
    status IN (
      'pending',
      'migrating',
      'migrated',
      'verified',
      'mismatch',
      'failed',
      'unrecoverable',
      'excluded',
      'rolled_back'
    )
  );

UPDATE repository_migration_items migration
SET status = 'excluded',
    last_error_code = 'MIGRATION_SOURCE_EXCLUDED',
    last_error_message =
      'Connector source is intentionally unsupported and has no canonical version',
    metadata = migration.metadata || jsonb_build_object(
      'exclusionReason', 'unsupported_connector_source',
      'excludedAt', now()
    ),
    verified_at = NULL,
    updated_at = now()
FROM repository_connector_sources connector_source
WHERE migration.source_kind = 'repository_item'
  AND connector_source.repository_item_id = migration.source_id
  AND connector_source.status = 'unsupported'
  AND migration.status IN (
    'pending',
    'migrating',
    'failed',
    'unrecoverable'
  )
  AND migration.canonical_version_id IS NULL
  AND migration.canonical_object_key IS NULL;
