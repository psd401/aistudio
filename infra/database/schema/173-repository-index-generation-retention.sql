-- ============================================================================
-- 173: bounded retention for superseded repository index generations (#1527)
-- ============================================================================
--
-- Record the transition time independently of generation creation so a
-- long-lived active generation always gets a full rollback window after it is
-- replaced. Existing rows start a conservative new window at deployment.
-- ============================================================================

ALTER TABLE repository_index_generations
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

UPDATE repository_index_generations
SET superseded_at = now()
WHERE status = 'superseded'
  AND superseded_at IS NULL;

CREATE OR REPLACE FUNCTION set_repository_index_generation_superseded_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'superseded' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'superseded' THEN
      NEW.superseded_at = now();
    END IF;
  ELSE
    NEW.superseded_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_repository_index_generation_superseded_at
  ON repository_index_generations;
CREATE TRIGGER trg_repository_index_generation_superseded_at
BEFORE INSERT OR UPDATE OF status ON repository_index_generations
FOR EACH ROW
EXECUTE FUNCTION set_repository_index_generation_superseded_at();

CREATE INDEX IF NOT EXISTS idx_repository_index_generations_superseded_retention
  ON repository_index_generations (repository_id, superseded_at DESC, id DESC)
  WHERE status = 'superseded';

-- ROLLBACK SQL (for manual rollback if needed)
-- DROP INDEX IF EXISTS idx_repository_index_generations_superseded_retention;
-- DROP TRIGGER IF EXISTS trg_repository_index_generation_superseded_at ON repository_index_generations;
-- DROP FUNCTION IF EXISTS set_repository_index_generation_superseded_at();
-- ALTER TABLE repository_index_generations DROP COLUMN IF EXISTS superseded_at;
