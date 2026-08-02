CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('importing', 'ready', 'reading', 'completed', 'archived', 'failed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_books_source_hash ON books(source_hash);

CREATE TABLE document_assets (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    display_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    title TEXT,
    author TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'zlibrary')),
    origin_locator TEXT,
    rights_provenance_id TEXT NOT NULL,
    UNIQUE(book_id, sha256)
);

CREATE TABLE document_parts (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    word_count INTEGER NOT NULL CHECK (word_count >= 0),
    sha256 TEXT NOT NULL,
    chapter_refs_json TEXT NOT NULL,
    UNIQUE(asset_id, sequence),
    UNIQUE(asset_id, sha256)
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'queued', 'running', 'blocked', 'cancellation_requested', 'completed',
            'failed_retryable', 'failed_terminal', 'cancelled'
        )
    ),
    step TEXT NOT NULL CHECK (
        step IN (
            'queued', 'acquiring', 'storing', 'preparing', 'creating_workspace',
            'uploading', 'processing', 'verifying', 'completed'
        )
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    progress_current INTEGER,
    progress_total INTEGER,
    error_code TEXT,
    error_message TEXT,
    book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE INDEX idx_jobs_status_updated_at ON jobs(status, updated_at);
CREATE INDEX idx_jobs_book_id ON jobs(book_id);

CREATE TABLE job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    step TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    progress_current INTEGER,
    progress_total INTEGER,
    error_code TEXT,
    error_message TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, version)
);

CREATE INDEX idx_job_events_job_id ON job_events(job_id, version);

CREATE TABLE external_workspaces (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    credential_profile TEXT NOT NULL,
    external_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'processing', 'ready', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(book_id, provider, credential_profile),
    UNIQUE(provider, credential_profile, external_id)
);

CREATE TABLE external_sources (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES external_workspaces(id) ON DELETE CASCADE,
    document_part_id TEXT NOT NULL REFERENCES document_parts(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    checksum TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'processing', 'ready', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, document_part_id),
    UNIQUE(workspace_id, external_id)
);

CREATE INDEX idx_external_sources_workspace_status
    ON external_sources(workspace_id, status);

CREATE TABLE remote_operations (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ensure_workspace', 'add_source')),
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

CREATE INDEX idx_remote_operations_job_status
    ON remote_operations(job_id, status);
