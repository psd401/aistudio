-- =====================================================
-- Migration: 115-graph-decision-lifecycle.sql
-- Description: Decision lifecycle (status + supersession), entity-resolution
--              embeddings, and the GRAPH_EMBEDDING_MODEL_ID setting.
-- Issue: #1252 (builds on the unified write path from #1251)
-- Dependencies: 050-graph-schema.sql (graph_nodes/graph_edges),
--               010-knowledge-repositories.sql (pgvector `vector` extension)
--
-- Additive and reversible: new nullable columns + indexes on graph_nodes and a
-- single seeded setting. Safe to leave in place with the feature disabled.
-- =====================================================

-- -----------------------------------------------------
-- 1. Decision lifecycle columns
--    `status`        — MADR 4.0 lifecycle for decision-typed nodes
--                      (proposed | accepted | superseded | rejected). NULL for
--                      non-decision nodes (person/evidence/…).
--    `superseded_at` — set when a decision is superseded by a newer one, so
--                      "what was current as of T" is answerable without traversal
--                      (bi-temporal depth is deliberately limited to this single
--                      column per issue decision 3).
-- -----------------------------------------------------
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMP WITH TIME ZONE;

-- Integrity guard: only the four MADR lifecycle values (or NULL).
-- DROP IF EXISTS + ADD (two single statements, no DO/$$ block) keeps the
-- migration re-runnable AND compatible with the db-init statement splitter,
-- which splits on ';' and does not understand dollar-quoted blocks.
ALTER TABLE graph_nodes DROP CONSTRAINT IF EXISTS chk_graph_nodes_status;
ALTER TABLE graph_nodes
  ADD CONSTRAINT chk_graph_nodes_status
  CHECK (status IS NULL OR status IN ('proposed', 'accepted', 'superseded', 'rejected'));

-- Partial index for "current decision on X" filters (node_type + status).
-- Partial (WHERE status IS NOT NULL) keeps it small — only decision-typed rows
-- carry a status, so the vast majority of nodes are excluded from the index.
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type_status
  ON graph_nodes (node_type, status)
  WHERE status IS NOT NULL;

-- -----------------------------------------------------
-- 2. Entity-resolution / semantic-search embedding column
--    512-dim pgvector column populated at capture time by the direct-Bedrock
--    helper (lib/graph/graph-embeddings.ts, model GRAPH_EMBEDDING_MODEL_ID).
--    Fixed at 512 dims: Titan V2 supports 256/512/1024; 512 halves index/storage
--    cost vs 1024 with negligible accuracy loss for short name+description texts.
--    Swapping to a model with different dimensions later requires a re-embed
--    backfill (the column dimension is fixed) — see the setting seed below.
-- -----------------------------------------------------
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS embedding vector(512);

-- HNSW index for approximate-nearest-neighbour cosine search (pgvector >= 0.5.0).
-- vector_cosine_ops pairs with the `<=>` cosine-distance operator used by the
-- entity-resolution and semantic-search queries.
CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding_hnsw
  ON graph_nodes USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------
-- 3. Backfill existing decision nodes to 'accepted'
--    Every decision already in the graph was, by definition, adopted; give them
--    the lifecycle status so the new "current decision" filters see them.
-- -----------------------------------------------------
UPDATE graph_nodes
  SET status = 'accepted'
  WHERE node_type = 'decision';

-- -----------------------------------------------------
-- 4. Seed the graph embedding model setting
--    Self-contained from the repository-chunk embedding pipeline
--    (EMBEDDING_MODEL_*), which is slated for a separate rework — this feature
--    must NOT depend on it. Default amazon.titan-embed-text-v2:0 at 512 dims.
--    NOTE: the graph_nodes.embedding column is fixed at 512 dimensions. Changing
--    this setting to a model with a different output dimension (or a different
--    Titan dimension) requires a re-embed/backfill and an ALTER of the column —
--    do not point this at a non-512-dim model without that migration.
-- -----------------------------------------------------
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'GRAPH_EMBEDDING_MODEL_ID',
    'amazon.titan-embed-text-v2:0',
    'Bedrock model id used to embed context-graph nodes for entity resolution and semantic decision search. Invoked directly via Bedrock Runtime (lib/graph/graph-embeddings.ts), decoupled from the repository EMBEDDING_MODEL_* pipeline. The graph_nodes.embedding column is fixed at 512 dimensions — changing this to a model with a different output dimension requires a re-embed backfill and a column ALTER.',
    'ai',
    false
)
ON CONFLICT (key) DO NOTHING;
