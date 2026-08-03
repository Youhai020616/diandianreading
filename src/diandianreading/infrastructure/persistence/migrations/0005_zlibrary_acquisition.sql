CREATE TABLE rights_provenance (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_locator_redacted TEXT NOT NULL,
    rights_basis TEXT NOT NULL CHECK (
        rights_basis IN (
            'owned_copy', 'licensed', 'public_domain', 'open_license', 'explicit_permission'
        )
    ),
    license_identifier TEXT,
    evidence_storage_key TEXT,
    attestation_version TEXT NOT NULL,
    attested_at TEXT NOT NULL,
    acquisition_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
    content_sha256 TEXT,
    supersedes_id TEXT REFERENCES rights_provenance(id) ON DELETE RESTRICT,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        rights_basis NOT IN ('public_domain', 'open_license')
        OR (license_identifier IS NOT NULL AND length(trim(license_identifier)) > 0)
    ),
    CHECK (
        rights_basis NOT IN ('licensed', 'explicit_permission')
        OR evidence_storage_key IS NOT NULL
    ),
    CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
    CHECK (supersedes_id IS NULL OR supersedes_id != id)
);

CREATE INDEX idx_rights_provider_locator
    ON rights_provenance(provider, source_locator_redacted, attested_at);
CREATE INDEX idx_rights_content_sha256
    ON rights_provenance(content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX idx_rights_acquisition_job
    ON rights_provenance(acquisition_job_id) WHERE acquisition_job_id IS NOT NULL;

CREATE TABLE rights_provenance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provenance_id TEXT NOT NULL REFERENCES rights_provenance(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    source_locator_redacted TEXT NOT NULL,
    rights_basis TEXT NOT NULL,
    license_identifier TEXT,
    evidence_storage_key TEXT,
    attestation_version TEXT NOT NULL,
    attested_at TEXT NOT NULL,
    acquisition_job_id TEXT,
    content_sha256 TEXT,
    supersedes_id TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(provenance_id, version)
);

CREATE INDEX idx_rights_events_provenance
    ON rights_provenance_events(provenance_id, version);
