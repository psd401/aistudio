-- Migration 103: Atrium document cover band + emoji icon (Epic #1059 Meridian slice F)
--
-- Adds two nullable presentation columns to content_objects backing the Meridian
-- "2b — Rich document" cover band + doc icon (README §"2b"): the editor renders a
-- 170px gradient cover with a 56px emoji tile, the reader shows the same cover, and
-- the library doc cards show the emoji when set.
--
--   cover_gradient  — a PRESET KEY (e.g. 'default','sunrise','forest','violet'),
--                     NOT raw CSS. The app maps the key to one of a fixed set of
--                     CSS gradients (styles/atrium-meridian.css). Storing a key (not
--                     author CSS) keeps this off the style-injection surface — the
--                     value is validated against an allowlist on write and only ever
--                     selects a class, never emits author-controlled CSS. NULL = no
--                     cover band (the default, unchanged look).
--   icon            — a single emoji (grapheme). NULL = the kind's default lucide
--                     icon on the library card. Length-capped; rendered as plain
--                     text (never as HTML), so no markup can ride in.
--
-- content_objects is an Atrium-era table (created in migration 085, owned by the
-- master migration role), so ALTER TABLE ADD COLUMN is permitted here — unlike an
-- `ALTER TYPE <early-enum>` on a postgres-owned 001-005 object (see MEMORY: mig 085).
-- Both columns are nullable with no default, so the ALTER is a metadata-only change
-- (no table rewrite) and safe on a live table.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS, mirroring 090/094/095/102). No
-- DO $$ blocks — the migration runner's statement splitter cannot handle
-- dollar-quoted blocks (see 079/085/086). No new updated_at column, so no trigger.

ALTER TABLE content_objects
  ADD COLUMN IF NOT EXISTS cover_gradient varchar(40);

ALTER TABLE content_objects
  ADD COLUMN IF NOT EXISTS icon varchar(32);
