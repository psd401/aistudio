-- Migration 139: Unified content integrations for agents, skills, and Nexus Projects.
-- Epic #1261, workstream #1266.
--
-- Additive only:
--   * repository catalog scopes and a first-party public PKCE client for OpenClaw
--   * durable skill-to-repository bindings
--   * Nexus Projects, membership, connected repositories, and project chats
-- Existing Nexus conversations remain valid with project_id NULL.
--
-- Rollback:
-- DELETE FROM oauth_clients
--  WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126'
--    AND client_name = 'PSD OpenClaw';
-- ALTER TABLE psd_agent_workspace_consent_nonces
--   DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;
-- ALTER TABLE psd_agent_workspace_consent_nonces
--   ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
--   CHECK (token_kind IN ('agent_account', 'user_account', 'cognito_data', 'plaud', 'canva'));
-- ALTER TABLE nexus_conversations DROP COLUMN IF EXISTS project_id;
-- DROP TABLE IF EXISTS nexus_project_repositories;
-- DROP TABLE IF EXISTS nexus_project_members;
-- DROP TABLE IF EXISTS nexus_projects;
-- DROP TABLE IF EXISTS skill_repository_bindings;

ALTER TABLE psd_agent_workspace_consent_nonces
  DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;
ALTER TABLE psd_agent_workspace_consent_nonces
  ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
  CHECK (token_kind IN (
    'agent_account',
    'user_account',
    'cognito_data',
    'plaud',
    'canva',
    'aistudio'
  ));

INSERT INTO oauth_clients (
  client_id,
  client_name,
  application_type,
  client_secret_hash,
  redirect_uris,
  allowed_scopes,
  grant_types,
  response_types,
  token_endpoint_auth_method,
  require_pkce,
  access_token_ttl,
  refresh_token_ttl,
  is_active,
  is_first_party
)
VALUES (
  '7e8646f4-4091-4a34-a6b9-0d3721e8a126',
  'PSD OpenClaw',
  'native',
  NULL,
  '[
    "http://localhost:3000/agent-connect-aistudio/callback",
    "https://dev.aistudio.psd401.ai/agent-connect-aistudio/callback",
    "https://aistudio.psd401.ai/agent-connect-aistudio/callback"
  ]'::jsonb,
  '[
    "openid",
    "profile",
    "email",
    "offline_access",
    "platform:read",
    "repositories:list",
    "repositories:read",
    "repositories:search",
    "repositories:changes"
  ]'::jsonb,
  '["authorization_code", "refresh_token"]'::jsonb,
  '["code"]'::jsonb,
  'none',
  true,
  900,
  2592000,
  true,
  true
)
ON CONFLICT (client_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS skill_repository_bindings (
  skill_id uuid NOT NULL REFERENCES psd_agent_skills(id) ON DELETE CASCADE,
  repository_id integer NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_repository_bindings_repository
  ON skill_repository_bindings (repository_id, skill_id);

CREATE TABLE IF NOT EXISTS nexus_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  instructions text NOT NULL DEFAULT '',
  project_repository_id integer NOT NULL UNIQUE
    REFERENCES knowledge_repositories(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_nexus_projects_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_nexus_projects_owner_updated
  ON nexus_projects (owner_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_nexus_projects_updated_at ON nexus_projects;
CREATE TRIGGER trg_nexus_projects_updated_at
  BEFORE UPDATE ON nexus_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS nexus_project_members (
  project_id uuid NOT NULL REFERENCES nexus_projects(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL DEFAULT 'viewer',
  repository_access_id integer REFERENCES repository_access(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT chk_nexus_project_member_role
    CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nexus_project_owner_member
  ON nexus_project_members (project_id)
  WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_nexus_project_members_user
  ON nexus_project_members (user_id, project_id);

CREATE TABLE IF NOT EXISTS nexus_project_repositories (
  project_id uuid NOT NULL REFERENCES nexus_projects(id) ON DELETE CASCADE,
  repository_id integer NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  connected_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_nexus_project_repositories_repository
  ON nexus_project_repositories (repository_id, project_id);

ALTER TABLE nexus_conversations
  ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES nexus_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nexus_conversations_project_user_updated
  ON nexus_conversations (project_id, user_id, updated_at DESC)
  WHERE project_id IS NOT NULL;
