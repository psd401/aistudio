-- Durable, atomic rate reservations shared by API-key, OAuth/JWT, and session callers.

CREATE TABLE IF NOT EXISTS api_rate_limit_reservations (
    id BIGSERIAL PRIMARY KEY,
    principal_hash VARCHAR(64) NOT NULL,
    endpoint VARCHAR(255) NOT NULL,
    request_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_rate_reservations_principal_time
    ON api_rate_limit_reservations(principal_hash, request_at);

CREATE INDEX IF NOT EXISTS idx_api_rate_reservations_time
    ON api_rate_limit_reservations(request_at);
