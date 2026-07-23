-- Migration 125: Nexus private ephemeral repository bindings (Epic #1261, #1268)
--
-- Adds the server-owned relationship that lets Nexus stage attachments before
-- a conversation exists, bind them to the eventual conversation, and keep the
-- repository owner identical to the conversation owner at the database layer.
-- The repository lifecycle columns and retention settings were added by 116.

-- Assistant Architect is available to staff by default, so its repository
-- picker and Nexus "keep as a repository" handoff must be manageable by the
-- same default audience. Manifest defaults only apply when a capability is
-- first inserted; explicitly backfill existing installations idempotently.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, c.id
FROM roles r
JOIN capabilities c
  ON c.identifier = 'knowledge-repositories'
WHERE r.name = 'staff'
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Composite uniqueness lets the binding foreign keys prove ownership instead
-- of relying only on application checks.
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_repositories_id_owner
  ON knowledge_repositories (id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nexus_conversations_id_user
  ON nexus_conversations (id, user_id);

-- Ephemeral repositories are always private and carry an explicit expiry.
ALTER TABLE knowledge_repositories
  DROP CONSTRAINT IF EXISTS chk_knowledge_repositories_ephemeral_policy;

-- Earlier experimental rows predate Nexus bindings and cannot be trusted to
-- satisfy the product's privacy/lifecycle contract. Quarantine every invalid
-- row before enabling the constraint: make it private, give it bounded
-- retention, and expire an active row immediately so it cannot remain
-- owner-retrievable forever. Valid private rows with an existing expiry remain
-- bounded and are left intact.
UPDATE knowledge_repositories
SET is_public = FALSE,
    retention_days = COALESCE(retention_days, 30),
    expires_at = COALESCE(expires_at, now()),
    lifecycle_status = CASE
      WHEN lifecycle_status = 'active' THEN 'expired'
      ELSE lifecycle_status
    END,
    updated_at = now()
WHERE repository_kind = 'ephemeral'
  AND (
    is_public IS DISTINCT FROM FALSE
    OR retention_days IS NULL
    OR expires_at IS NULL
  );

ALTER TABLE knowledge_repositories
  ADD CONSTRAINT chk_knowledge_repositories_ephemeral_policy
  CHECK (
    repository_kind <> 'ephemeral'
    OR (
      is_public IS FALSE
      AND retention_days IS NOT NULL
      AND expires_at IS NOT NULL
    )
  ) NOT VALID;

-- Adding NOT VALID takes the lighter lock, then the explicit validation proves
-- there is no historical policy bypass left for retrieval or lifecycle jobs.
ALTER TABLE knowledge_repositories
  VALIDATE CONSTRAINT chk_knowledge_repositories_ephemeral_policy;

CREATE TABLE IF NOT EXISTS nexus_repository_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_key uuid NOT NULL,
  conversation_id uuid,
  repository_id integer NOT NULL,
  bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_nexus_repository_binding_owner_draft
    UNIQUE (owner_id, draft_key),
  CONSTRAINT uq_nexus_repository_binding_repository
    UNIQUE (repository_id),
  CONSTRAINT fk_nexus_repository_binding_conversation_owner
    FOREIGN KEY (conversation_id, owner_id)
    REFERENCES nexus_conversations(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_nexus_repository_binding_repository_owner
    FOREIGN KEY (repository_id, owner_id)
    REFERENCES knowledge_repositories(id, owner_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nexus_repository_binding_conversation
  ON nexus_repository_bindings (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nexus_repository_binding_owner_created
  ON nexus_repository_bindings (owner_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_nexus_repository_bindings_updated_at
  ON nexus_repository_bindings;
CREATE TRIGGER trg_nexus_repository_bindings_updated_at
  BEFORE UPDATE ON nexus_repository_bindings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
