CREATE TABLE jobs_v4 (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')
    ),
    current_step TEXT CHECK (
        current_step IS NULL OR current_step IN (
            'acquiring', 'storing', 'preparing', 'creating_workspace',
            'uploading', 'processing', 'verifying'
        )
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    progress_current INTEGER,
    progress_total INTEGER,
    last_error_code TEXT,
    last_error_detail_redacted TEXT,
    retriable INTEGER CHECK (retriable IS NULL OR retriable IN (0, 1)),
    blocked_reason TEXT CHECK (
        blocked_reason IS NULL OR blocked_reason IN ('AUTH_REQUIRED', 'REMOTE_OUTCOME_AMBIGUOUS')
    ),
    cancel_requested_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
    not_before TEXT,
    book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        (progress_current IS NULL AND progress_total IS NULL)
        OR (
            progress_current IS NOT NULL AND progress_total IS NOT NULL
            AND progress_total > 0 AND progress_current >= 0
            AND progress_current <= progress_total
        )
    ),
    CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
    CHECK (
        (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
            AND lease_generation > 0)
        OR (status != 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
    CHECK (status != 'failed' OR retriable IS NOT NULL)
);

INSERT INTO jobs_v4(
    id, job_type, input_hash, status, current_step, attempt,
    progress_current, progress_total, last_error_code,
    last_error_detail_redacted, retriable, blocked_reason,
    cancel_requested_at, lease_owner, lease_expires_at, lease_generation,
    not_before, book_id, created_at, updated_at, started_at, completed_at, version
)
SELECT
    id,
    job_type,
    input_hash,
    CASE status
        WHEN 'running' THEN 'queued'
        WHEN 'cancellation_requested' THEN 'queued'
        WHEN 'failed_retryable' THEN 'failed'
        WHEN 'failed_terminal' THEN 'failed'
        ELSE status
    END,
    CASE step
        WHEN 'queued' THEN NULL
        WHEN 'completed' THEN 'verifying'
        ELSE step
    END,
    attempt,
    progress_current,
    progress_total,
    error_code,
    error_message,
    CASE status
        WHEN 'failed_retryable' THEN 1
        WHEN 'failed_terminal' THEN 0
        ELSE NULL
    END,
    CASE WHEN status = 'blocked' THEN 'AUTH_REQUIRED' ELSE NULL END,
    CASE
        WHEN status IN ('cancellation_requested', 'cancelled') THEN updated_at
        ELSE NULL
    END,
    NULL,
    NULL,
    0,
    NULL,
    book_id,
    created_at,
    updated_at,
    started_at,
    CASE
        WHEN status IN ('completed', 'failed_retryable', 'failed_terminal', 'cancelled')
            THEN COALESCE(completed_at, updated_at)
        ELSE NULL
    END,
    version
FROM jobs;

CREATE TABLE job_events_v4 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs_v4(id) ON DELETE CASCADE,
    from_status TEXT CHECK (
        from_status IS NULL OR from_status IN (
            'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'
        )
    ),
    to_status TEXT NOT NULL CHECK (
        to_status IN ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')
    ),
    current_step TEXT CHECK (
        current_step IS NULL OR current_step IN (
            'acquiring', 'storing', 'preparing', 'creating_workspace',
            'uploading', 'processing', 'verifying'
        )
    ),
    attempt INTEGER NOT NULL,
    progress_current INTEGER,
    progress_total INTEGER,
    blocked_reason TEXT,
    cancel_requested_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    lease_generation INTEGER NOT NULL,
    error_code TEXT,
    error_detail_redacted TEXT,
    retriable INTEGER,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, version)
);

INSERT INTO job_events_v4(
    id, job_id, from_status, to_status, current_step, attempt,
    progress_current, progress_total, blocked_reason, cancel_requested_at,
    lease_owner, lease_expires_at, lease_generation, error_code,
    error_detail_redacted, retriable, version, created_at
)
SELECT
    id,
    job_id,
    CASE from_status
        WHEN 'running' THEN 'queued'
        WHEN 'cancellation_requested' THEN 'queued'
        WHEN 'failed_retryable' THEN 'failed'
        WHEN 'failed_terminal' THEN 'failed'
        ELSE from_status
    END,
    CASE to_status
        WHEN 'running' THEN 'queued'
        WHEN 'cancellation_requested' THEN 'queued'
        WHEN 'failed_retryable' THEN 'failed'
        WHEN 'failed_terminal' THEN 'failed'
        ELSE to_status
    END,
    CASE step
        WHEN 'queued' THEN NULL
        WHEN 'completed' THEN 'verifying'
        ELSE step
    END,
    attempt,
    progress_current,
    progress_total,
    CASE WHEN to_status = 'blocked' THEN 'AUTH_REQUIRED' ELSE NULL END,
    CASE
        WHEN to_status IN ('cancellation_requested', 'cancelled') THEN created_at
        ELSE NULL
    END,
    NULL,
    NULL,
    0,
    error_code,
    error_message,
    CASE to_status
        WHEN 'failed_retryable' THEN 1
        WHEN 'failed_terminal' THEN 0
        ELSE NULL
    END,
    version,
    created_at
FROM job_events;

CREATE TABLE remote_operations_v4 (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs_v4(id) ON DELETE CASCADE,
    step TEXT NOT NULL CHECK (
        step IN ('creating_workspace', 'uploading', 'verifying')
    ),
    provider TEXT NOT NULL,
    credential_profile TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
        kind IN ('ensure_workspace', 'add_source', 'generate_content', 'download_content')
    ),
    idempotency_key TEXT NOT NULL UNIQUE,
    local_resource_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    probe_strategy TEXT NOT NULL CHECK (
        probe_strategy IN ('external_id', 'authoritative_operation_key', 'unsupported')
    ),
    baseline_snapshot_redacted TEXT NOT NULL,
    request_summary_redacted TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'prepared', 'dispatched', 'ambiguous', 'succeeded', 'reconciled',
            'failed_terminal', 'cancelled_before_dispatch'
        )
    ),
    dispatch_attempt INTEGER NOT NULL CHECK (dispatch_attempt >= 0),
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dispatched_at TEXT,
    resolved_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        (status IN ('succeeded', 'reconciled') AND external_id IS NOT NULL)
        OR status NOT IN ('succeeded', 'reconciled')
    ),
    CHECK (
        (status IN ('succeeded', 'reconciled', 'failed_terminal', 'cancelled_before_dispatch'))
        = (resolved_at IS NOT NULL)
    )
);

INSERT INTO remote_operations_v4(
    id, job_id, step, provider, credential_profile, kind,
    idempotency_key, local_resource_id, input_hash, probe_strategy,
    baseline_snapshot_redacted, request_summary_redacted, status,
    dispatch_attempt, external_id, created_at, updated_at,
    dispatched_at, resolved_at, version
)
SELECT
    operation.id,
    operation.job_id,
    CASE operation.kind
        WHEN 'ensure_workspace' THEN 'creating_workspace'
        WHEN 'add_source' THEN 'uploading'
        ELSE 'verifying'
    END,
    COALESCE(
        (SELECT provider FROM external_workspaces
         WHERE book_id = jobs.book_id ORDER BY created_at LIMIT 1),
        'unknown'
    ),
    COALESCE(
        (SELECT credential_profile FROM external_workspaces
         WHERE book_id = jobs.book_id ORDER BY created_at LIMIT 1),
        'unknown'
    ),
    operation.kind,
    operation.idempotency_key,
    operation.local_resource_id,
    operation.input_hash,
    CASE WHEN operation.external_id IS NOT NULL THEN 'external_id' ELSE 'unsupported' END,
    '{}',
    '{}',
    CASE operation.status
        WHEN 'pending' THEN 'prepared'
        WHEN 'completed' THEN 'succeeded'
        WHEN 'reconciliation_required' THEN 'ambiguous'
    END,
    CASE WHEN operation.status = 'pending' THEN 0 ELSE 1 END,
    operation.external_id,
    operation.created_at,
    operation.updated_at,
    CASE WHEN operation.status = 'pending' THEN NULL ELSE operation.created_at END,
    CASE WHEN operation.status = 'completed' THEN operation.updated_at ELSE NULL END,
    operation.version
FROM remote_operations AS operation
JOIN jobs ON jobs.id = operation.job_id;

DROP TABLE job_events;
DROP TABLE remote_operations;
DROP TABLE jobs;

ALTER TABLE jobs_v4 RENAME TO jobs;
ALTER TABLE job_events_v4 RENAME TO job_events;
ALTER TABLE remote_operations_v4 RENAME TO remote_operations;

CREATE INDEX idx_jobs_status_not_before ON jobs(status, not_before, updated_at);
CREATE INDEX idx_jobs_lease_expiry ON jobs(status, lease_expires_at);
CREATE INDEX idx_jobs_book_id ON jobs(book_id);
CREATE INDEX idx_job_events_job_id ON job_events(job_id, version);
CREATE INDEX idx_remote_operations_job_status ON remote_operations(job_id, status);
CREATE INDEX idx_remote_operations_job_step ON remote_operations(job_id, step);

CREATE TABLE job_steps (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    step TEXT NOT NULL CHECK (
        step IN (
            'acquiring', 'storing', 'preparing', 'creating_workspace',
            'uploading', 'processing', 'verifying'
        )
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'skipped')
    ),
    input_hash TEXT NOT NULL,
    output_ref TEXT,
    progress_current INTEGER,
    progress_total INTEGER,
    error_code TEXT,
    error_detail_redacted TEXT,
    started_at TEXT,
    completed_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0),
    PRIMARY KEY(job_id, step, attempt),
    CHECK (
        (progress_current IS NULL AND progress_total IS NULL)
        OR (
            progress_current IS NOT NULL AND progress_total IS NOT NULL
            AND progress_total > 0 AND progress_current >= 0
            AND progress_current <= progress_total
        )
    ),
    CHECK ((status = 'running') <= (started_at IS NOT NULL)),
    CHECK (
        (status IN ('completed', 'failed', 'cancelled', 'skipped'))
        <= (completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_job_steps_job_status ON job_steps(job_id, status, step);

CREATE TABLE job_payloads (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    payload_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
