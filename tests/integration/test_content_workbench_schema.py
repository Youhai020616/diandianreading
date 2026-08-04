"""Migration 0009 constraint coverage.

The invariants asserted here are the ones ADR-0008 relies on being enforced by
the database rather than by application code: save-as-note idempotency, revision
authorship, and the refusal to persist a traversal segment in an export path.
"""

from __future__ import annotations

import sqlite3

import pytest

from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase
from tests.support import FIXED_NOW

NOW = FIXED_NOW.isoformat()


def make_database(tmp_path) -> SQLiteDatabase:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            INSERT INTO books(id, title, author, source_hash, status, created_at, updated_at)
            VALUES ('book-1', '设计心理学', 'Norman', 'hash-1', 'ready', ?, ?)
            """,
            (NOW, NOW),
        )
    return database


def insert_note(connection: sqlite3.Connection, *, note_id: str, kind: str, source: str | None):
    connection.execute(
        """
        INSERT INTO notes(
            id, book_id, source_kind, source_id, title, body, created_at, updated_at, version
        ) VALUES (?, 'book-1', ?, ?, 'title', 'body', ?, ?, 0)
        """,
        (note_id, kind, source, NOW, NOW),
    )


def insert_content(connection: sqlite3.Connection, *, status: str, revisions: int) -> None:
    connection.execute(
        """
        INSERT INTO generated_contents(
            id, book_id, content_type, status, language, tone, length_hint, target_platform,
            require_citations, first_person, latest_revision_number,
            created_at, updated_at, version
        ) VALUES (
            'content-1', 'book-1', 'reading_report', ?, 'zh-CN', 'rational', 'medium', NULL,
            1, 0, ?, ?, ?, 0
        )
        """,
        (status, revisions, NOW, NOW),
    )


class TestNoteConstraints:
    def test_one_note_per_derived_source(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            insert_note(connection, note_id="note-1", kind="chat_message", source="message-1")
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            insert_note(connection, note_id="note-2", kind="chat_message", source="message-1")

    def test_manual_notes_are_not_deduplicated_against_each_other(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            insert_note(connection, note_id="note-1", kind="manual", source=None)
            insert_note(connection, note_id="note-2", kind="manual", source=None)
            count = connection.execute("SELECT count(*) FROM notes").fetchone()[0]
        assert count == 2

    def test_manual_notes_reject_a_source_id(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            insert_note(connection, note_id="note-1", kind="manual", source="message-1")

    def test_derived_notes_require_a_source_id(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            insert_note(connection, note_id="note-1", kind="annotation", source=None)


class TestContentConstraints:
    def test_settled_content_requires_a_revision(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            insert_content(connection, status="draft", revisions=0)

    def test_pending_content_may_have_no_revision(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            insert_content(connection, status="queued", revisions=0)
            status = connection.execute("SELECT status FROM generated_contents").fetchone()[0]
        assert status == "queued"

    def test_first_revision_must_be_authored_by_the_model(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            insert_content(connection, status="draft", revisions=1)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            connection.execute(
                """
                    INSERT INTO content_revisions(
                        id, content_id, revision_number, author_kind, title, body, created_at
                    ) VALUES ('rev-1', 'content-1', 1, 'human', 'title', 'body', ?)
                    """,
                (NOW,),
            )

    def test_revision_numbers_are_unique_per_content(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            insert_content(connection, status="draft", revisions=1)
            connection.execute(
                """
                INSERT INTO content_revisions(
                    id, content_id, revision_number, author_kind, title, body, created_at
                ) VALUES ('rev-1', 'content-1', 1, 'ai', 'title', 'body', ?)
                """,
                (NOW,),
            )
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            connection.execute(
                """
                    INSERT INTO content_revisions(
                        id, content_id, revision_number, author_kind, title, body, created_at
                    ) VALUES ('rev-2', 'content-1', 1, 'human', 'title', 'body', ?)
                    """,
                (NOW,),
            )


class TestObsidianExportConstraints:
    def insert_vault(self, connection: sqlite3.Connection, *, vault_id: str, active: int) -> None:
        connection.execute(
            """
            INSERT INTO obsidian_vaults(
                id, name, root_path, is_active, created_at, updated_at, version
            ) VALUES (?, 'Vault', '/home/user/Vault', ?, ?, ?, 0)
            """,
            (vault_id, active, NOW, NOW),
        )

    def insert_state(self, connection: sqlite3.Connection, *, relpath: str) -> None:
        connection.execute(
            """
            INSERT INTO obsidian_export_state(
                id, vault_id, target_kind, target_id, vault_relpath,
                exported_sha256, exported_at, version
            ) VALUES ('state-1', 'vault-1', 'book', 'book-1', ?, ?, ?, 0)
            """,
            (relpath, "a" * 64, NOW),
        )

    def test_only_one_vault_may_be_active(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            self.insert_vault(connection, vault_id="vault-1", active=1)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            self.insert_vault(connection, vault_id="vault-2", active=1)

    def test_inactive_vaults_may_coexist(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            self.insert_vault(connection, vault_id="vault-1", active=0)
            self.insert_vault(connection, vault_id="vault-2", active=0)
            count = connection.execute("SELECT count(*) FROM obsidian_vaults").fetchone()[0]
        assert count == 2

    @pytest.mark.parametrize(
        "relpath",
        ["../escape.md", "Books/../../escape.md", "/absolute/escape.md", ""],
    )
    def test_traversal_and_absolute_paths_cannot_be_persisted(self, tmp_path, relpath) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            self.insert_vault(connection, vault_id="vault-1", active=1)
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            self.insert_state(connection, relpath=relpath)

    def test_a_normal_relative_path_is_accepted(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            self.insert_vault(connection, vault_id="vault-1", active=1)
            self.insert_state(connection, relpath="Books/设计心理学/Book.md")
            stored = connection.execute(
                "SELECT vault_relpath FROM obsidian_export_state"
            ).fetchone()[0]
        assert stored == "Books/设计心理学/Book.md"

    def test_one_state_row_per_target(self, tmp_path) -> None:
        database = make_database(tmp_path)
        with database.connect(immediate=True) as connection:
            self.insert_vault(connection, vault_id="vault-1", active=1)
            self.insert_state(connection, relpath="Books/a/Book.md")
        with (
            pytest.raises(sqlite3.IntegrityError),
            database.connect(immediate=True) as connection,
        ):
            connection.execute(
                """
                    INSERT INTO obsidian_export_state(
                        id, vault_id, target_kind, target_id, vault_relpath,
                        exported_sha256, exported_at, version
                    ) VALUES ('state-2', 'vault-1', 'book', 'book-1', 'Books/b/Book.md', ?, ?, 0)
                    """,
                ("b" * 64, NOW),
            )
