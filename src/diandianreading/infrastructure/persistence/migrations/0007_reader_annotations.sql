CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note')),
    status TEXT NOT NULL CHECK (status IN ('active', 'orphaned', 'deleted')),
    anchor_type TEXT CHECK (anchor_type IN ('markdown_offset', 'pdf_page')),
    anchor_sha256 TEXT CHECK (
        anchor_sha256 IS NULL
        OR (length(anchor_sha256) = 64 AND anchor_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    anchor_start INTEGER,
    anchor_end INTEGER,
    chapter_ref TEXT CHECK (chapter_ref IS NULL OR length(chapter_ref) > 0),
    quote_exact TEXT CHECK (
        quote_exact IS NULL OR (length(quote_exact) BETWEEN 1 AND 2000)
    ),
    quote_prefix TEXT CHECK (quote_prefix IS NULL OR length(quote_prefix) <= 64),
    quote_suffix TEXT CHECK (quote_suffix IS NULL OR length(quote_suffix) <= 64),
    selected_text TEXT CHECK (
        selected_text IS NULL OR (length(selected_text) BETWEEN 1 AND 2000)
    ),
    body TEXT CHECK (body IS NULL OR (length(body) BETWEEN 1 AND 10000)),
    color TEXT CHECK (
        color IS NULL OR color IN ('yellow', 'green', 'blue', 'pink', 'purple')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK ((anchor_type IS NULL) = (anchor_sha256 IS NULL)),
    CHECK (
        anchor_type IS NOT NULL
        OR (anchor_start IS NULL AND anchor_end IS NULL AND quote_exact IS NULL)
    ),
    CHECK (
        anchor_type IS NOT 'markdown_offset'
        OR (anchor_start IS NOT NULL AND anchor_end IS NOT NULL
            AND anchor_start >= 0 AND anchor_end >= anchor_start)
    ),
    CHECK (
        anchor_type IS NOT 'pdf_page'
        OR (anchor_start IS NOT NULL AND anchor_start >= 1 AND anchor_end IS NULL)
    ),
    CHECK (
        (quote_exact IS NULL) = (quote_prefix IS NULL)
        AND (quote_exact IS NULL) = (quote_suffix IS NULL)
    ),
    CHECK (
        kind IS NOT 'highlight'
        OR (anchor_type IS NOT NULL AND quote_exact IS NOT NULL
            AND selected_text IS NOT NULL AND color IS NOT NULL
            AND quote_exact = selected_text)
    ),
    CHECK (
        kind IS NOT 'highlight'
        OR anchor_type IS NOT 'markdown_offset'
        OR anchor_end > anchor_start
    ),
    CHECK (kind IS NOT 'note' OR (body IS NOT NULL AND selected_text IS NULL)),
    CHECK (status IS NOT 'orphaned' OR anchor_type IS NOT NULL)
);

CREATE INDEX idx_annotations_book_created_at_id
    ON annotations(book_id, created_at DESC, id DESC);

CREATE INDEX idx_annotations_anchor_document
    ON annotations(anchor_sha256)
    WHERE anchor_sha256 IS NOT NULL;

CREATE TABLE reading_progress (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    anchor_type TEXT NOT NULL CHECK (anchor_type IN ('markdown_offset', 'pdf_page')),
    anchor_sha256 TEXT NOT NULL CHECK (
        length(anchor_sha256) = 64 AND anchor_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    anchor_start INTEGER,
    anchor_end INTEGER,
    chapter_ref TEXT CHECK (chapter_ref IS NULL OR length(chapter_ref) > 0),
    percent REAL NOT NULL CHECK (percent >= 0.0 AND percent <= 1.0),
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
        anchor_type IS NOT 'markdown_offset'
        OR (anchor_start IS NOT NULL AND anchor_end IS NOT NULL
            AND anchor_start >= 0 AND anchor_end >= anchor_start)
    ),
    CHECK (
        anchor_type IS NOT 'pdf_page'
        OR (anchor_start IS NOT NULL AND anchor_start >= 1 AND anchor_end IS NULL)
    )
);
