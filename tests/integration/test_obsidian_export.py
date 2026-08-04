"""Obsidian export reconciliation against a real directory (C2).

Each test manipulates the vault the way a user would — repeat, rename, edit —
because those are exactly the situations where a name-keyed or unconditional
exporter silently duplicates or destroys work.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from diandianreading.application.use_cases.obsidian_export import (
    ExportTarget,
    ObsidianExportService,
    VaultNotConfiguredError,
    VaultUnavailableError,
)
from diandianreading.domain.content import ExportOutcome, ExportTargetKind
from diandianreading.domain.errors import DiandianError
from diandianreading.domain.vault import CONFLICT_SUFFIX, DIANDIAN_ID_KEY
from diandianreading.infrastructure.persistence.content import (
    SQLiteObsidianExportStateRepository,
    SQLiteVaultRepository,
)
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase
from tests.support import FIXED_NOW

BOOK_TITLE = "设计心理学"


@pytest.fixture
def service(tmp_path: Path) -> ObsidianExportService:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    return ObsidianExportService(
        vaults=SQLiteVaultRepository(database),
        state=SQLiteObsidianExportStateRepository(database),
    )


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "Vault"
    root.mkdir()
    return root


def book_target(body: str = "书籍元数据。") -> ExportTarget:
    return ExportTarget(
        kind=ExportTargetKind.BOOK,
        target_id="book-1",
        title=BOOK_TITLE,
        body=body,
    )


def export(service: ObsidianExportService, *targets: ExportTarget):
    return service.export_book(
        book_id="book-1", book_title=BOOK_TITLE, targets=targets, now=FIXED_NOW
    )


class TestVaultConfiguration:
    def test_configures_and_reads_back_the_active_vault(self, service, vault) -> None:
        configured = service.configure_vault(name="My Vault", root_path=str(vault))
        assert configured.name == "My Vault"
        assert service.active_vault() is not None
        assert service.active_vault().root_path == str(vault.resolve())

    def test_replacing_the_vault_keeps_only_one_active(self, service, vault, tmp_path) -> None:
        other = tmp_path / "Other"
        other.mkdir()
        service.configure_vault(name="First", root_path=str(vault))
        service.configure_vault(name="Second", root_path=str(other))
        assert service.active_vault().name == "Second"

    def test_refuses_a_relative_or_missing_path(self, service, tmp_path) -> None:
        with pytest.raises(DiandianError, match="absolute"):
            service.configure_vault(name="v", root_path="relative/path")
        with pytest.raises(VaultUnavailableError):
            service.configure_vault(name="v", root_path=str(tmp_path / "does-not-exist"))

    def test_export_requires_a_configured_vault(self, service) -> None:
        with pytest.raises(VaultNotConfiguredError):
            export(service, book_target())


class TestReconciliation:
    def test_first_export_creates_the_file(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (result,) = export(service, book_target())
        assert result.outcome is ExportOutcome.CREATED
        assert result.relative_path == f"Books/{BOOK_TITLE}/Book.md"
        assert (vault / result.relative_path).is_file()
        assert result.deep_link.startswith("obsidian://open?vault=v&file=")

    def test_repeating_an_unchanged_export_adds_no_file(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        export(service, book_target())
        (second,) = export(service, book_target())
        assert second.outcome is ExportOutcome.UNCHANGED
        assert len(list(vault.rglob("*.md"))) == 1

    def test_changed_content_updates_in_place(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        export(service, book_target())
        (second,) = export(service, book_target(body="更新后的元数据。"))
        assert second.outcome is ExportOutcome.UPDATED
        assert len(list(vault.rglob("*.md"))) == 1
        assert "更新后的元数据。" in (vault / second.relative_path).read_text(encoding="utf-8")

    def test_a_renamed_file_is_found_by_identity_not_by_name(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (first,) = export(service, book_target())
        original = vault / first.relative_path
        renamed = original.with_name("我改名了.md")
        original.rename(renamed)

        (second,) = export(service, book_target(body="新的正文。"))
        assert second.outcome is ExportOutcome.UPDATED
        assert second.relative_path.endswith("我改名了.md")
        # The rename did not produce a duplicate.
        assert len(list(vault.rglob("*.md"))) == 1

    def test_a_manual_edit_is_never_overwritten(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (first,) = export(service, book_target())
        target_file = vault / first.relative_path
        edited = target_file.read_text(encoding="utf-8") + "\n我自己补充的一段。\n"
        target_file.write_text(edited, encoding="utf-8")

        (second,) = export(service, book_target(body="产品想写的新正文。"))
        assert second.outcome is ExportOutcome.CONFLICT
        assert second.conflict_path is not None
        assert second.conflict_path.endswith(CONFLICT_SUFFIX)
        # The user's text survived, and the new render is beside it.
        assert "我自己补充的一段。" in target_file.read_text(encoding="utf-8")
        assert "产品想写的新正文。" in (vault / second.conflict_path).read_text(encoding="utf-8")

    def test_a_conflict_file_is_not_mistaken_for_the_target(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (first,) = export(service, book_target())
        target_file = vault / first.relative_path
        target_file.write_text(
            target_file.read_text(encoding="utf-8") + "\n手改\n", encoding="utf-8"
        )
        export(service, book_target(body="第二版"))
        # Deleting the original must not make the exporter adopt the conflict file.
        target_file.unlink()
        (third,) = export(service, book_target(body="第三版"))
        assert third.outcome is ExportOutcome.CREATED
        assert not third.relative_path.endswith(CONFLICT_SUFFIX)


class TestTargets:
    def test_every_target_kind_lands_in_its_own_file(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        results = export(
            service,
            book_target(),
            ExportTarget(
                kind=ExportTargetKind.HIGHLIGHTS,
                target_id="highlights-book-1",
                title="划线",
                body="- 一条划线",
            ),
            ExportTarget(
                kind=ExportTargetKind.NOTES,
                target_id="notes-book-1",
                title="笔记",
                body="- 一条笔记",
            ),
            ExportTarget(
                kind=ExportTargetKind.SUMMARY,
                target_id="summary-book-1",
                title="摘要",
                body="摘要正文",
            ),
        )
        names = sorted(Path(item.relative_path).name for item in results)
        assert names == ["Book.md", "Highlights.md", "Notes.md", "Summary.md"]

    def test_social_posts_keep_their_subdirectory(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (result,) = export(
            service,
            ExportTarget(
                kind=ExportTargetKind.SOCIAL_POSTS,
                target_id="content-1",
                title="可见性/原则",
                body="短帖正文",
            ),
        )
        assert result.relative_path == f"Books/{BOOK_TITLE}/Social Posts/可见性 原则.md"
        assert (vault / result.relative_path).is_file()

    def test_a_hostile_book_title_cannot_escape_the_vault(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        results = service.export_book(
            book_id="book-1",
            book_title="../../etc",
            targets=(book_target(),),
            now=FIXED_NOW,
        )
        written = vault / results[0].relative_path
        assert vault.resolve() in written.resolve().parents

    def test_the_written_file_carries_its_identity(self, service, vault) -> None:
        service.configure_vault(name="v", root_path=str(vault))
        (result,) = export(service, book_target())
        text = (vault / result.relative_path).read_text(encoding="utf-8")
        assert f'{DIANDIAN_ID_KEY}: "book-1"' in text
