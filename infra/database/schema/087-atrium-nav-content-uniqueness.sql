-- Migration 087: Atrium content nav-item uniqueness (concurrency hardening)
-- Part of #1054 (Epic #1059, Atrium Phase 4 — Navigation & IA)
--
-- navItemService.ensureNavItem (the publish path) maintains the single content
-- nav item for a content object, keyed by navigation_items.content_object_id.
-- Migration 085 added that column + the fk_nav_content_object FK, but NO
-- uniqueness — so two OVERLAPPING publishes of the same object could both observe
-- "no existing row" (the prior check-then-insert) and both INSERT, leaving
-- DUPLICATE active nav items. Later republishes match LIMIT 1 and update only one,
-- stranding the duplicate in the section tree.
--
-- This constraint lets ensureNavItem use INSERT ... ON CONFLICT (content_object_id)
-- DO UPDATE — atomic: a second concurrent insert conflicts and updates the same
-- row instead of duplicating it.
--
-- A plain UNIQUE constraint is correct here even though content_object_id is
-- NULLABLE: PostgreSQL treats NULLs as DISTINCT in a unique constraint, so the
-- many regular (non-content) nav items with content_object_id IS NULL are
-- unaffected; only the non-null content links are constrained to one row each.
-- (No partial CREATE UNIQUE INDEX is needed, which also keeps us on the
-- ALTER TABLE ADD CONSTRAINT path proven to work for the Aurora migration role on
-- this postgres-owned early table — see 085's fk_nav_content_object.)
--
-- ADDITIVE and idempotent (DROP IF EXISTS + ADD, mirroring 085's FK pattern). No
-- DO $$ blocks — the migration runner's statement splitter cannot handle
-- dollar-quoted blocks (see 079/085/086). Safe to apply: no environment has
-- content nav items yet (ensureNavItem ships in this same change), so there are no
-- pre-existing duplicate content_object_id values to violate the new constraint.

ALTER TABLE navigation_items DROP CONSTRAINT IF EXISTS uq_nav_content_object;
ALTER TABLE navigation_items
  ADD CONSTRAINT uq_nav_content_object UNIQUE (content_object_id);
