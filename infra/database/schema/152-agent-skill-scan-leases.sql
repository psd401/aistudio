-- Bind asynchronous skill scans to the exact draft version and admission lease.
-- A newer draft clears these fields, so stale Lambda completions cannot publish.
ALTER TABLE psd_agent_skills
  ADD COLUMN IF NOT EXISTS scan_lease_id UUID,
  ADD COLUMN IF NOT EXISTS scan_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_skills_scan_lease
  ON psd_agent_skills (scan_lease_id)
  WHERE scan_lease_id IS NOT NULL;
