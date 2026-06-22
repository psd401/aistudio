-- Migration 080: Unified tool catalog (tool_catalog table)
-- Part of #924 (Epic #922, workstream #2 — Unify Agent Platform)
--
-- Introduces `tool_catalog`, the single source of truth for *invocable units*
-- (tools) AI Studio exposes across the MCP server, AI SDK chat/Nexus, the REST
-- API, and internal agent loops.
--
-- This is intentionally NOT the legacy `tools` table (the pre-#923 role-gated
-- feature-flag registry kept as a compat shim and dropped in workstream #6). The
-- canonical catalog uses a distinct table name so both can coexist during the
-- migration window with no physical collision.
--
-- This migration is ADDITIVE and idempotent:
--   1. Create `tool_catalog` (a row per (identifier, version)).
--   2. Seed the 5 existing MCP tools with source = 'code' and surfaces = ['mcp'],
--      preserving the exact required-scope mapping from lib/mcp/tool-registry.ts.
--      The code manifest sync (lib/tools/catalog/sync.ts, run on app boot) owns
--      these rows after deploy and keeps them in lockstep with the manifest.
--
-- NOTE: No PL/pgSQL triggers / DO $$ blocks. The RDS Data API migration runner's
-- statement splitter cannot handle dollar-quoted blocks (see migration 079).
-- `updated_at` is maintained by application code (Drizzle .set({ updatedAt })).

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '080-tool-catalog.sql' AND status = 'failed';

-- 1. tool_catalog table
CREATE TABLE IF NOT EXISTS tool_catalog (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(150) NOT NULL,
    version VARCHAR(20) DEFAULT 'v1' NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    input_schema JSONB,
    output_schema JSONB,
    surfaces JSONB DEFAULT '[]'::jsonb NOT NULL,
    required_scopes JSONB DEFAULT '[]'::jsonb NOT NULL,
    agent_callable BOOLEAN DEFAULT true NOT NULL,
    source VARCHAR(20) DEFAULT 'code' NOT NULL,
    handler_ref VARCHAR(200),
    is_active BOOLEAN DEFAULT true NOT NULL,
    deprecated_at TIMESTAMP,
    replaced_by VARCHAR(170),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- 'retired' marks a row that WAS code-managed but was removed from the
    -- manifest: is_active=false + source='retired'. Distinct from 'assistant'
    -- (a real assistant-derived tool) so observability/queries are not misled,
    -- and from 'code' so a manifest re-add can detect the released row and
    -- re-claim ownership (re-activating it) without clobbering an admin's
    -- is_active toggle on a still-present code tool.
    CONSTRAINT tool_catalog_source_check CHECK (source IN ('code', 'assistant', 'skill', 'retired')),
    CONSTRAINT tool_catalog_identifier_version_key UNIQUE (identifier, version)
);

CREATE INDEX IF NOT EXISTS idx_tool_catalog_identifier ON tool_catalog (identifier);
CREATE INDEX IF NOT EXISTS idx_tool_catalog_source ON tool_catalog (source);
CREATE INDEX IF NOT EXISTS idx_tool_catalog_is_active ON tool_catalog (is_active);

-- 2. Seed the existing 5 MCP tools. ON CONFLICT keeps this idempotent and lets
-- the boot-time manifest sync take ownership of name/description/schema after
-- deploy. surfaces = ['mcp'] initially per the issue's migration plan. The
-- required_scopes mirror TOOL_SCOPE_MAP exactly. agent_callable defaults true;
-- capture_decision is human-or-agent callable. All are code-sourced.
--
-- handler_ref is seeded with the canonical identifier (domain.action), matching
-- what the manifest sync writes (handlerRef = entry.identifier). Seeding the old
-- snake_case wire name here would differ from the manifest and trigger a spurious
-- UPDATE for every row on the first boot sync.
INSERT INTO tool_catalog (identifier, version, name, description, surfaces, required_scopes, agent_callable, source, handler_ref)
VALUES
    ('decisions.search', 'v1', 'search_decisions',
     'Search decision graph nodes by type, class, or text query. Returns paginated results.',
     '["mcp"]'::jsonb, '["mcp:search_decisions"]'::jsonb, true, 'code', 'decisions.search'),
    ('decisions.capture', 'v1', 'capture_decision',
     'Capture a structured decision with full context (evidence, constraints, reasoning, alternatives). Creates a decision subgraph with completeness scoring.',
     '["mcp"]'::jsonb, '["mcp:capture_decision"]'::jsonb, true, 'code', 'decisions.capture'),
    ('assistants.execute', 'v1', 'execute_assistant',
     'Execute an AI assistant with the given inputs and return the final text result.',
     '["mcp"]'::jsonb, '["mcp:execute_assistant"]'::jsonb, true, 'code', 'assistants.execute'),
    ('assistants.list', 'v1', 'list_assistants',
     'List AI assistants the authenticated user has access to execute.',
     '["mcp"]'::jsonb, '["mcp:list_assistants"]'::jsonb, true, 'code', 'assistants.list'),
    ('decisions.graph_get', 'v1', 'get_decision_graph',
     'Get details of a specific decision node and all its connections (incoming and outgoing edges).',
     '["mcp"]'::jsonb, '["mcp:get_decision_graph"]'::jsonb, true, 'code', 'decisions.graph_get')
ON CONFLICT (identifier, version) DO NOTHING;

-- 3. Seed the AI SDK (chat / Nexus) tools. Descriptor-only entries — the concrete
-- implementations are provider-native and built per request. surfaces = ['ai_sdk'].
-- show_chart is universal (no scope); the rest require chat:write. The boot-time
-- manifest sync owns these rows after deploy.
INSERT INTO tool_catalog (identifier, version, name, description, surfaces, required_scopes, agent_callable, source, handler_ref)
VALUES
    ('chat.show_chart', 'v1', 'show_chart',
     'Render a chart (bar, line, pie, etc.) from structured data on the client.',
     '["ai_sdk"]'::jsonb, '[]'::jsonb, true, 'code', 'chat.show_chart'),
    ('chat.web_search', 'v1', 'web_search_preview',
     'Search the web for current information and facts.',
     '["ai_sdk"]'::jsonb, '["chat:write"]'::jsonb, true, 'code', 'chat.web_search'),
    ('chat.code_interpreter', 'v1', 'code_interpreter',
     'Execute code and perform data analysis.',
     '["ai_sdk"]'::jsonb, '["chat:write"]'::jsonb, true, 'code', 'chat.code_interpreter'),
    ('chat.generate_image', 'v1', 'generateImage',
     'Generate images from text descriptions using AI models.',
     '["ai_sdk"]'::jsonb, '["chat:write"]'::jsonb, true, 'code', 'chat.generate_image')
ON CONFLICT (identifier, version) DO NOTHING;
