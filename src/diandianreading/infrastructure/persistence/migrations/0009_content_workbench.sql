-- C0: content assets, notes, and Obsidian export reconciliation (ADR-0008).
--
-- This migration only adds tables. No existing table is rebuilt or altered, so a
-- rollback is a plain DROP and Phase 0-5 plus R1-R4 data are untouched.
--
-- notes deliberately does not reuse annotations: an annotation must always be
-- locatable in the body text, and an AI answer has no anchor. Making the anchor
-- nullable would have broken the re-anchoring invariant frozen by ADR-0007.

CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('chat_message', 'annotation', 'manual')),
    source_id TEXT CHECK (source_id IS NULL OR length(source_id) > 0),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK ((source_kind = 'manual') = (source_id IS NULL))
);

-- save-as-note idempotency is enforced by the database rather than by an
-- application-level lookup: repeating the request for one message can only ever
-- resolve to the same note.
CREATE UNIQUE INDEX notes_unique_derived_source
    ON notes (source_kind, source_id)
    WHERE source_id IS NOT NULL;

CREATE INDEX notes_by_book ON notes (book_id, created_at);

CREATE TABLE generated_contents (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL CHECK (content_type IN (
        'reading_report',
        'reading_card',
        'slides',
        'podcast_script',
        'video_script',
        'short_post',
        'quiz'
    )),
    -- scheduled and published are accepted by the schema but belong to the P6
    -- publishing track; the use case refuses them so an out-of-scope request is
    -- an explicit error instead of a silent widening.
    status TEXT NOT NULL CHECK (status IN (
        'queued',
        'generating',
        'draft',
        'editing',
        'approved',
        'scheduled',
        'published'
    )),
    language TEXT NOT NULL CHECK (length(language) BETWEEN 1 AND 64),
    tone TEXT NOT NULL CHECK (tone IN ('rational', 'personal', 'narrative', 'concise')),
    length_hint TEXT NOT NULL CHECK (length_hint IN ('short', 'medium', 'long')),
    target_platform TEXT CHECK (
        target_platform IS NULL OR length(target_platform) BETWEEN 1 AND 64
    ),
    require_citations INTEGER NOT NULL CHECK (require_citations IN (0, 1)),
    first_person INTEGER NOT NULL CHECK (first_person IN (0, 1)),
    latest_revision_number INTEGER NOT NULL CHECK (latest_revision_number >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (status IN ('queued', 'generating') OR latest_revision_number >= 1)
);

CREATE INDEX generated_contents_by_book ON generated_contents (book_id, created_at);

CREATE TABLE content_sources (
    content_id TEXT NOT NULL REFERENCES generated_contents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('book', 'chapter', 'note', 'topic')),
    reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
    PRIMARY KEY (content_id, position)
);

-- Revisions are append-only. Keeping the original model draft is what lets a
-- user answer "did I write this paragraph or did the model" months later.
CREATE TABLE content_revisions (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES generated_contents(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('ai', 'human')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
    created_at TEXT NOT NULL,
    UNIQUE (content_id, revision_number),
    CHECK (revision_number > 1 OR author_kind = 'ai')
);

CREATE TABLE obsidian_vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    root_path TEXT NOT NULL CHECK (length(root_path) > 0),
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0)
);

CREATE UNIQUE INDEX obsidian_vaults_single_active
    ON obsidian_vaults (is_active)
    WHERE is_active = 1;

-- Reconciliation is keyed by content identity, not by file name: renaming an
-- exported note is normal user behaviour, and a name-keyed exporter would treat
-- it as a new file and duplicate on every sync.
CREATE TABLE obsidian_export_state (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES obsidian_vaults(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN (
        'book',
        'highlights',
        'notes',
        'summary',
        'social_posts'
    )),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    -- Defence in depth for the path-escape rule in ADR-0008 section 6: even a
    -- bug in the sanitiser cannot persist a traversal segment.
    vault_relpath TEXT NOT NULL CHECK (
        length(vault_relpath) > 0
        AND vault_relpath NOT GLOB '*..*'
        AND vault_relpath NOT GLOB '/*'
    ),
    exported_sha256 TEXT NOT NULL CHECK (
        length(exported_sha256) = 64 AND exported_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    exported_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE (vault_id, target_kind, target_id)
);
