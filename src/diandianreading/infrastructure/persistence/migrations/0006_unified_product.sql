CREATE INDEX idx_jobs_created_at_id
    ON jobs(created_at DESC, id DESC);

CREATE INDEX idx_jobs_status_created_at_id
    ON jobs(status, created_at DESC, id DESC);

CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY,
    session_token_digest TEXT NOT NULL UNIQUE CHECK (
        length(session_token_digest) = 64
        AND session_token_digest NOT GLOB '*[^0-9a-f]*'
    ),
    csrf_token_digest TEXT NOT NULL UNIQUE CHECK (
        length(csrf_token_digest) = 64
        AND csrf_token_digest NOT GLOB '*[^0-9a-f]*'
    ),
    install_token_generation INTEGER NOT NULL CHECK (install_token_generation >= 1),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_reason TEXT CHECK (
        revoked_reason IS NULL OR revoked_reason IN (
            'logout', 'install_token_rotated', 'security_recovery', 'app_reset'
        )
    ),
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        (revoked_at IS NULL AND revoked_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
    )
);

CREATE INDEX idx_browser_sessions_active
    ON browser_sessions(idle_expires_at, absolute_expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_browser_sessions_cleanup
    ON browser_sessions(COALESCE(revoked_at, idle_expires_at), id);

CREATE TABLE browser_bootstrap_nonces (
    id TEXT PRIMARY KEY,
    nonce_digest TEXT NOT NULL UNIQUE CHECK (
        length(nonce_digest) = 64
        AND nonce_digest NOT GLOB '*[^0-9a-f]*'
    ),
    install_token_generation INTEGER NOT NULL CHECK (install_token_generation >= 1),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE INDEX idx_browser_bootstrap_nonces_active
    ON browser_bootstrap_nonces(expires_at)
    WHERE consumed_at IS NULL;

CREATE INDEX idx_browser_bootstrap_nonces_cleanup
    ON browser_bootstrap_nonces(COALESCE(consumed_at, expires_at), id);

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES external_workspaces(id) ON DELETE CASCADE,
    title TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE INDEX idx_conversations_workspace_id
    ON conversations(workspace_id);

CREATE TABLE provider_conversation_bindings (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_conversation_id TEXT,
    context_generation INTEGER NOT NULL CHECK (context_generation >= 0),
    health TEXT NOT NULL CHECK (
        health IN ('unknown', 'active', 'missing', 'resetting', 'error')
    ),
    last_verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (health != 'active' OR provider_conversation_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_provider_conversation_bindings_remote
    ON provider_conversation_bindings(provider, provider_conversation_id)
    WHERE provider_conversation_id IS NOT NULL;

CREATE TABLE chat_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    user_message_id TEXT NOT NULL UNIQUE,
    assistant_message_id TEXT NOT NULL UNIQUE,
    query_scope_type TEXT NOT NULL CHECK (query_scope_type = 'book'),
    question_hash TEXT NOT NULL CHECK (
        length(question_hash) = 64
        AND question_hash NOT GLOB '*[^0-9a-f]*'
    ),
    request_fingerprint TEXT NOT NULL CHECK (
        length(request_fingerprint) = 64
        AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
    ),
    phase TEXT CHECK (
        phase IS NULL OR phase IN (
            'resolving_scope', 'waiting_for_provider', 'reconciling', 'finalizing'
        )
    ),
    effective_scope_json TEXT CHECK (
        effective_scope_json IS NULL OR json_valid(effective_scope_json)
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    cancel_requested_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
    provider_request_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE(conversation_id, client_message_id),
    UNIQUE(id, conversation_id),
    CHECK (user_message_id != assistant_message_id),
    CHECK (
        (status = 'running' AND phase IS NOT NULL)
        OR (status != 'running' AND phase IS NULL)
    ),
    CHECK (
        (
            status = 'running'
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_generation > 0
            AND started_at IS NOT NULL
        )
        OR (
            status != 'running'
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
        )
    ),
    CHECK (
        (status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)
    ),
    CHECK ((status = 'failed') = (error_json IS NOT NULL)),
    CHECK (status != 'completed' OR effective_scope_json IS NOT NULL),
    CHECK (status != 'completed' OR provider_request_started_at IS NOT NULL),
    CHECK (
        provider_request_started_at IS NULL
        OR (
            status != 'queued'
            AND (status != 'running' OR phase != 'resolving_scope')
        )
    ),
    CHECK (
        status != 'cancelled'
        OR (cancel_requested_at IS NOT NULL AND provider_request_started_at IS NULL)
    )
);

CREATE UNIQUE INDEX idx_chat_runs_one_active_per_conversation
    ON chat_runs(conversation_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX idx_chat_runs_claimable
    ON chat_runs(status, created_at, id);

CREATE INDEX idx_chat_runs_expired_lease
    ON chat_runs(lease_expires_at, created_at, id)
    WHERE status = 'running';

CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    chat_run_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT,
    client_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE(chat_run_id, role),
    UNIQUE(conversation_id, client_message_id),
    FOREIGN KEY(chat_run_id, conversation_id)
        REFERENCES chat_runs(id, conversation_id) ON DELETE CASCADE,
    CHECK (
        (
            role = 'user'
            AND content IS NOT NULL
            AND length(content) > 0
            AND client_message_id IS NOT NULL
        )
        OR (role = 'assistant' AND client_message_id IS NULL)
    ),
    CHECK (content IS NULL OR length(content) > 0)
);

CREATE INDEX idx_chat_messages_conversation_created_at_id
    ON chat_messages(conversation_id, created_at DESC, id DESC);

CREATE TABLE chat_references (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    citation_number INTEGER NOT NULL CHECK (citation_number > 0),
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    document_part_id TEXT NOT NULL REFERENCES document_parts(id) ON DELETE CASCADE,
    chapter_refs_json TEXT NOT NULL CHECK (json_valid(chapter_refs_json)),
    label TEXT NOT NULL CHECK (length(label) > 0),
    passage TEXT,
    location_type TEXT CHECK (
        location_type IS NULL OR location_type IN ('epub_cfi', 'pdf_page', 'markdown_offset')
    ),
    location_value TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(message_id, citation_number),
    CHECK (
        (location_type IS NULL AND location_value IS NULL)
        OR (location_type IS NOT NULL AND location_value IS NOT NULL)
    ),
    CHECK (passage IS NULL OR length(passage) > 0),
    CHECK (location_value IS NULL OR length(location_value) > 0)
);

CREATE INDEX idx_chat_references_message_citation
    ON chat_references(message_id, citation_number, id);

CREATE TABLE chat_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
    run_version INTEGER NOT NULL CHECK (run_version >= 0),
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'chat_run.updated', 'chat_run.completed', 'chat_run.failed',
            'chat_run.cancelled', 'chat_run.snapshot'
        )
    ),
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
    ),
    phase TEXT CHECK (
        phase IS NULL OR phase IN (
            'resolving_scope', 'waiting_for_provider', 'reconciling', 'finalizing'
        )
    ),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    UNIQUE(chat_run_id, run_version),
    CHECK ((status = 'running') = (phase IS NOT NULL)),
    CHECK ((status = 'failed') = (error_json IS NOT NULL)),
    CHECK (
        status NOT IN ('completed', 'failed', 'cancelled')
        OR event_type = 'chat_run.snapshot'
        OR (status = 'completed' AND event_type = 'chat_run.completed')
        OR (status = 'failed' AND event_type = 'chat_run.failed')
        OR (status = 'cancelled' AND event_type = 'chat_run.cancelled')
    )
);

CREATE INDEX idx_chat_run_events_run_id_id
    ON chat_run_events(chat_run_id, id);

CREATE TABLE chat_provider_attempts (
    id TEXT PRIMARY KEY,
    chat_run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
    run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
    provider TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (
        length(request_fingerprint) = 64
        AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    status TEXT NOT NULL CHECK (
        status IN ('prepared', 'dispatched', 'succeeded', 'ambiguous', 'failed_terminal')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dispatched_at TEXT,
    resolved_at TEXT,
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE(chat_run_id, run_attempt),
    CHECK (status != 'prepared' OR dispatched_at IS NULL),
    CHECK (
        status NOT IN ('dispatched', 'succeeded', 'ambiguous')
        OR dispatched_at IS NOT NULL
    ),
    CHECK (
        (status IN ('succeeded', 'ambiguous', 'failed_terminal')) = (resolved_at IS NOT NULL)
    )
);

CREATE INDEX idx_chat_provider_attempts_run_attempt
    ON chat_provider_attempts(chat_run_id, run_attempt);

CREATE TABLE chat_run_retries (
    chat_run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
    client_retry_id TEXT NOT NULL,
    run_attempt INTEGER NOT NULL CHECK (run_attempt >= 2),
    created_at TEXT NOT NULL,
    PRIMARY KEY(chat_run_id, client_retry_id),
    UNIQUE(chat_run_id, run_attempt)
);
