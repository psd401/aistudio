-- ============================================================================
-- 173: bounded retention for superseded repository index generations (#1527)
-- ============================================================================
--
-- Record the transition time independently of generation creation so a
-- long-lived active generation always gets a full rollback window after it is
-- replaced. Existing rows start a conservative new window at deployment.
-- ============================================================================

ALTER TABLE repository_index_generations
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz
  DEFAULT statement_timestamp();

-- PostgreSQL stores a non-volatile ADD COLUMN default in table metadata instead
-- of rewriting the backlog. New application rows rely on the trigger below.
ALTER TABLE repository_index_generations
  ALTER COLUMN superseded_at DROP DEFAULT;

-- The normal historical backlog already has the fast-default value. This is
-- only an idempotent recovery for a partial run or a row written during the
-- short interval between removing the default and installing the trigger.
UPDATE repository_index_generations
SET superseded_at = statement_timestamp()
WHERE status = 'superseded'
  AND superseded_at IS NULL;

UPDATE repository_index_generations
SET superseded_at = NULL
WHERE status <> 'superseded'
  AND superseded_at IS NOT NULL;

-- Keep the body on one single-quoted line. The db-init Lambda's line-based SQL
-- splitter treats an interior line ending in ");" as the end of a function.
CREATE OR REPLACE FUNCTION set_repository_index_generation_superseded_at() RETURNS trigger AS 'BEGIN IF NEW.status <> ''superseded'' THEN NEW.superseded_at := NULL; ELSIF TG_OP = ''INSERT'' THEN NEW.superseded_at := clock_timestamp(); ELSIF OLD.status IS DISTINCT FROM ''superseded'' THEN NEW.superseded_at := clock_timestamp(); END IF; RETURN NEW; END;' LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_repository_index_generation_superseded_at
  ON repository_index_generations;
CREATE TRIGGER trg_repository_index_generation_superseded_at
BEFORE INSERT OR UPDATE OF status ON repository_index_generations
FOR EACH ROW
EXECUTE FUNCTION set_repository_index_generation_superseded_at();

CREATE INDEX IF NOT EXISTS idx_repository_index_generations_superseded_retention
  ON repository_index_generations (repository_id, superseded_at DESC, id DESC)
  WHERE status = 'superseded';

CREATE INDEX IF NOT EXISTS idx_knowledge_repositories_active_index_generation
  ON knowledge_repositories (active_index_generation_id)
  WHERE active_index_generation_id IS NOT NULL;

-- ROLLBACK SQL (for manual rollback if needed)
-- DROP INDEX IF EXISTS idx_repository_index_generations_superseded_retention;
-- DROP INDEX IF EXISTS idx_knowledge_repositories_active_index_generation;
-- DROP TRIGGER IF EXISTS trg_repository_index_generation_superseded_at ON repository_index_generations;
-- DROP FUNCTION IF EXISTS set_repository_index_generation_superseded_at();
-- ALTER TABLE repository_index_generations DROP COLUMN IF EXISTS superseded_at;
