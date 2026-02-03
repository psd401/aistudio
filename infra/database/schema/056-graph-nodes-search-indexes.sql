-- =====================================================
-- Migration: 056-graph-nodes-search-indexes.sql
-- Description: Add trigram indexes for ILIKE pattern matching
--              and composite index for decision type filtering
-- Issue: PR #705 (reviewer feedback on search performance)
-- Dependencies: 050-graph-schema.sql
-- =====================================================

-- Enable pg_trgm extension for ILIKE optimization
-- Allows PostgreSQL to use GIN indexes for ILIKE '%pattern%' queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index on graph_nodes.name for ILIKE pattern searches
-- Used by search_graph_nodes tool and graph admin page
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name_trgm
  ON graph_nodes USING GIN (name gin_trgm_ops);

-- Trigram index on graph_nodes.description for ILIKE pattern searches
CREATE INDEX IF NOT EXISTS idx_graph_nodes_description_trgm
  ON graph_nodes USING GIN (description gin_trgm_ops);

-- Composite index for decision-type filtering (node_type + node_class)
-- Optimizes queries that filter by both fields simultaneously
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type_class
  ON graph_nodes(node_type, node_class);
