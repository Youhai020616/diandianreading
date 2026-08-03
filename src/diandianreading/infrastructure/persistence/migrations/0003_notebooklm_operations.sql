CREATE TABLE remote_operations_v3 (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (
        kind IN ('ensure_workspace', 'add_source', 'generate_content', 'download_content')
    ),
    idempotency_key TEXT NOT NULL UNIQUE,
    local_resource_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'completed', 'reconciliation_required')
    ),
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        (status = 'completed' AND external_id IS NOT NULL)
        OR (status != 'completed')
    )
);

INSERT INTO remote_operations_v3(
    id, job_id, kind, idempotency_key, local_resource_id, input_hash,
    status, external_id, created_at, updated_at, version
)
SELECT
    id, job_id, kind, idempotency_key, local_resource_id, input_hash,
    status, external_id, created_at, updated_at, version
FROM remote_operations;

DROP TABLE remote_operations;
ALTER TABLE remote_operations_v3 RENAME TO remote_operations;

CREATE INDEX idx_remote_operations_job_status
    ON remote_operations(job_id, status);
