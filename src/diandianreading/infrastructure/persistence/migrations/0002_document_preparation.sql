ALTER TABLE document_assets
    ADD COLUMN derived_from_asset_id TEXT REFERENCES document_assets(id);

CREATE INDEX idx_document_assets_derived_from
    ON document_assets(derived_from_asset_id);

ALTER TABLE document_parts
    ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0);

CREATE TABLE document_manifests (
    root_asset_id TEXT PRIMARY KEY REFERENCES document_assets(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(book_id, storage_key),
    UNIQUE(book_id, sha256)
);

CREATE INDEX idx_document_manifests_book_id
    ON document_manifests(book_id);
