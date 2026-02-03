-- =====================================================
-- Migration: 050-graph-schema.sql
-- Description: Context graph schema (graph_nodes + graph_edges)
-- Issue: #665
-- Part: 1 of 5 in Context Graph Foundation epic
-- Dependencies: users table must exist
-- =====================================================

-- =====================================================
-- GRAPH NODES
-- =====================================================

CREATE TABLE IF NOT EXISTS graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type TEXT NOT NULL,
  node_class TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- GRAPH EDGES
-- =====================================================

CREATE TABLE IF NOT EXISTS graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Prevent self-referencing edges
  CONSTRAINT chk_no_self_reference CHECK (source_node_id != target_node_id),

  -- Allow multiple relationship types between same node pair
  CONSTRAINT uq_edge_source_target_type UNIQUE (source_node_id, target_node_id, edge_type)
);

-- =====================================================
-- INDEXES - graph_nodes
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_graph_nodes_node_type ON graph_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_node_class ON graph_nodes(node_class);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_created_by ON graph_nodes(created_by);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_metadata ON graph_nodes USING GIN (metadata);

-- =====================================================
-- INDEXES - graph_edges
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_edge_type ON graph_edges(edge_type);

-- =====================================================
-- TRIGGERS
-- Uses shared update_updated_at_column() from migration 017
-- =====================================================

DROP TRIGGER IF EXISTS trg_graph_nodes_updated_at ON graph_nodes;
CREATE TRIGGER trg_graph_nodes_updated_at
  BEFORE UPDATE ON graph_nodes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
