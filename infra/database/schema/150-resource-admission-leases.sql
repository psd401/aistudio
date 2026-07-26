-- Shared durable admission leases for bounded external and platform resources.

CREATE TABLE IF NOT EXISTS resource_admission_leases (
    id VARCHAR(36) PRIMARY KEY,
    kind VARCHAR(64) NOT NULL,
    owner_key VARCHAR(256) NOT NULL,
    context_key VARCHAR(256) NOT NULL,
    idempotency_key VARCHAR(256) NOT NULL,
    reserved_units BIGINT NOT NULL CHECK (reserved_units > 0),
    actual_units BIGINT CHECK (actual_units IS NULL OR actual_units >= 0),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'released', 'expired')),
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    CONSTRAINT uq_resource_admission_idempotency
        UNIQUE (kind, owner_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_resource_admission_active
    ON resource_admission_leases(kind, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_resource_admission_owner_window
    ON resource_admission_leases(kind, owner_key, admitted_at);

CREATE INDEX IF NOT EXISTS idx_resource_admission_global_window
    ON resource_admission_leases(kind, admitted_at);

CREATE INDEX IF NOT EXISTS idx_resource_admission_terminal_cleanup
    ON resource_admission_leases(kind, status, finished_at);
