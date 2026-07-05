-- Migration 096: Atrium public-publish approval queue (§26.4 persistence)
-- Part of Epic #1059 completion.
--
-- The §26.4 gate (lib/content/helpers.ts raisePublishApprovalRequired) blocks an
-- unauthorized public exposure by emitting a `content.public_publish_requested`
-- SNS event and throwing ApprovalRequiredError — but until now the signal went
-- nowhere durable: no table, no queue UI. This table is the durable approval
-- queue: one row per blocked request, decided by an admin at /admin/atrium.
--
-- One row per §26.4 raise site, classified by `request_kind`:
--   'publish'          — publishService.publish blocked on a public destination
--                        (pre-tx gate) or on a bundled visibility widen to public
--                        (in-tx gate). `context` records destination (+ slug for
--                        display, + visibility when the widen branch fired) — the
--                        exact input to REPLAY via publishService.publish on approve.
--   'visibility_widen' — visibilityService.setLevel blocked widening to public.
--                        `context.level` = 'public'; replayed via setLevel.
--   'export'           — okfExportService blocked a public-audience OKF bundle.
--                        Collection-scoped, NOT object-scoped: object_id is NULL and
--                        `context.collectionId` records the subtree. NOT replayed on
--                        approve (the bundle is returned to the original caller at
--                        call time; the exporter re-runs it).
--
-- object_id is NULLABLE because 'export' requests have no content object (the OKF
-- exporter raises with a collection id only); a CHECK enforces it is present for
-- every other kind. ON DELETE CASCADE: a deleted object's requests are moot.
-- destination is TEXT (not the publish_destination enum) because
-- 'visibility_widen' rows record the exposure target ('public'), which is not a
-- publish destination — and ALTER TYPE ... ADD VALUE is not available to the
-- Aurora migration role on early enums anyway (see MEMORY: migration 085).
--
-- Dedupe: at most ONE pending row per (object, kind, destination) — a repeat of
-- the same blocked request (agents retry) upserts into silence via
-- ON CONFLICT DO NOTHING against the partial unique indexes below. Export
-- requests (NULL object_id — treated as DISTINCT by a unique index) get their own
-- partial index keyed on context->>'collectionId'.
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 090/094/095). No DO $$
-- blocks — the migration runner's statement splitter cannot handle dollar-quoted
-- blocks (see 079/085/086). updated_at is backed by the pre-existing
-- update_updated_at_column() trigger function (migration 017); single-statement
-- CREATE TRIGGER needs no dollar-quoting (proven by 028/085/086).

CREATE TABLE IF NOT EXISTS content_publish_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only for request_kind = 'export' (collection-scoped, see header).
  object_id             uuid REFERENCES content_objects(id) ON DELETE CASCADE,
  request_kind          text NOT NULL
                        CHECK (request_kind IN ('publish', 'visibility_widen', 'export')),
  -- 'publish' → the publish destination; 'visibility_widen' → 'public' (the
  -- exposure target); 'export' → 'okf'.
  destination           text NOT NULL,
  -- Exactly what is needed to REPLAY the blocked action on approve (see header).
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Requester identity, from the Requester union: user → requested_by_user_id;
  -- agent-delegated → requested_by_user_id (the human) + requester_label;
  -- agent-autonomous → requested_by_agent_id + requester_label.
  requested_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  requested_by_agent_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL,
  requester_label       text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by_user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at            timestamptz,
  decision_note         text,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now(),
  -- Every kind except the collection-scoped 'export' must name its object.
  CONSTRAINT chk_cpr_object_required
    CHECK (request_kind = 'export' OR object_id IS NOT NULL)
);

-- Pending-dedupe: one open request per (object, kind, destination). Partial on
-- status so a re-request after a denial opens a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpr_pending
  ON content_publish_requests (object_id, request_kind, destination)
  WHERE status = 'pending';

-- Export requests have object_id NULL (unique indexes treat NULLs as distinct),
-- so dedupe them on the collection they bundle instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpr_pending_export
  ON content_publish_requests ((context->>'collectionId'), request_kind, destination)
  WHERE status = 'pending' AND object_id IS NULL;

-- Queue listing: pending-first pages ordered by age.
CREATE INDEX IF NOT EXISTS idx_cpr_status_created
  ON content_publish_requests (status, created_at);

-- updated_at trigger (CLAUDE.md: tables with updated_at MUST have the trigger).
DROP TRIGGER IF EXISTS update_content_publish_requests_updated_at ON content_publish_requests;
CREATE TRIGGER update_content_publish_requests_updated_at
  BEFORE UPDATE ON content_publish_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Admin nav link for the approvals + audit page (nav is DB-driven; the standard
-- registration point is a navigation_items INSERT — see 049/053). Parent is
-- resolved by link (not the hard-coded id 11 of 049/053) so a fresh local seed
-- with different ids still nests correctly. 'IconShield' is present in
-- components/navigation/icon-map.ts.
INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'Atrium Oversight', 'IconShield', '/admin/atrium',
       (SELECT id FROM navigation_items WHERE link = '/admin' LIMIT 1),
       'administrator', 28, true, 'link',
       'Approve public-publish requests and review the Atrium content audit trail'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/admin/atrium'
);
