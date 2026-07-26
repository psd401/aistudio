-- Durable conservative cost reservations for capped agentic assistant runs.

CREATE TABLE IF NOT EXISTS agentic_cost_reservations (
    id VARCHAR(36) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    execution_id INTEGER NOT NULL,
    reserved_cost_cents INTEGER NOT NULL CHECK (reserved_cost_cents > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'released', 'expired')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    CONSTRAINT uq_agentic_cost_execution UNIQUE (execution_id)
);

CREATE INDEX IF NOT EXISTS idx_agentic_cost_active_user
    ON agentic_cost_reservations(user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_agentic_cost_budget_window
    ON agentic_cost_reservations(reserved_at);
