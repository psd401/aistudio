-- Atomic concurrency and cost reservations for paid Gemini Deep Research runs.

CREATE TABLE IF NOT EXISTS deep_research_reservations (
    id VARCHAR(36) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reserved_cost_cents INTEGER NOT NULL CHECK (reserved_cost_cents > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'released', 'expired')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    sequence BIGSERIAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deep_research_active_user
    ON deep_research_reservations(user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_deep_research_budget_window
    ON deep_research_reservations(reserved_at);
