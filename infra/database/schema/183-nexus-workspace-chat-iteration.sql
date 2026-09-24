-- Migration 183: Nexus workspace chat iteration (#1791)
--
-- Two independent columns, both in service of iterating on a workspace artifact
-- rather than starting over every time.
--
-- 1. nexus_conversations.workspace_object_id (#1791 finding 1)
--    Which Atrium object a conversation worked on. Today that binding lives ONLY
--    in the `?workspace=` URL param, so:
--      - opening the conversation from the sidebar (`/nexus?id=…`) shows the chat
--        WITHOUT the workspace panel, and
--      - the editor's "Ask the agent" / "Open beside chat" always start a NEW
--        conversation, which then re-runs every table listing and schema probe
--        the original chat had already done.
--    Nullable: most conversations have no workspace. ON DELETE SET NULL because
--    deleting an artifact must not delete the conversation about it.
--
-- 2. content_versions.author_label (#1791 finding 6)
--    Versions written by the Nexus chat model show as "v3 · human" and
--    "Human-authored", because the workspace chat tools deliberately run under
--    the USER's own requester (the right call for authorization — the model can
--    never exceed what the person may do). `author_agent_id` cannot carry the
--    distinction: it is a UUID referencing agent_identities, and the Nexus chat
--    is not a registered agent identity. A free-text label mirrors the pattern
--    `apply_agent_edit` already uses for comment threads (author_label carries a
--    non-UUID agent name while author_agent_id stays NULL) and lets the UI say
--    "you, via Nexus chat" without weakening the authorization story.

ALTER TABLE nexus_conversations
  ADD COLUMN IF NOT EXISTS workspace_object_id UUID
    REFERENCES content_objects(id)
    ON DELETE SET NULL;

-- Serves the "most recent conversation this user had about this object" lookup
-- that the editor's Ask / Open-beside-chat controls make. Partial: the vast
-- majority of conversations have no workspace and do not belong in the index.
CREATE INDEX IF NOT EXISTS idx_nexus_conversations_workspace_object
  ON nexus_conversations (user_id, workspace_object_id, last_message_at DESC)
  WHERE workspace_object_id IS NOT NULL;

ALTER TABLE content_versions
  ADD COLUMN IF NOT EXISTS author_label VARCHAR(64);

COMMENT ON COLUMN nexus_conversations.workspace_object_id IS
  'Atrium content object this conversation worked on (#1791). Set on the first turn that carries a workspace binding; restores the workspace panel when the conversation is reopened.';

COMMENT ON COLUMN content_versions.author_label IS
  'Free-text authoring-surface label (e.g. ''nexus-chat'') for versions written under a human requester by a model (#1791). NULL for a version a person wrote directly. Never a substitute for author_actor/author_user_id, which remain the authorization record.';
