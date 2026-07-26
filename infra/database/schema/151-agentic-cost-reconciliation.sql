-- Reconcile conservative agentic reservations to measured token-based cost.

ALTER TABLE agentic_cost_reservations
    ADD COLUMN IF NOT EXISTS actual_cost_cents INTEGER
        CHECK (actual_cost_cents IS NULL OR actual_cost_cents > 0);

ALTER TABLE agentic_cost_reservations
    ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
