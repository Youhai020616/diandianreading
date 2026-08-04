"""Obsidian export reconciliation (C2, ADR-0008 sections 4 to 7).

The vault is not a database this product owns. It is a directory the user edits
by hand between exports, and Obsidian keeps no version history, so a wrong
overwrite is unrecoverable. Two rules follow, and both are implemented here:

* identity is the ``diandian_id`` in the frontmatter, never the file name, so a
  rename does not turn one note into two;
* a file whose digest no longer matches what this product last wrote has been
  edited by the user and is never overwritten; the new render goes to a conflict
  file beside it and the caller is told.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from diandianreading.application.ports.content import (
    ExportRecord,
    ObsidianExportStateRepository,
    VaultConfig,
    VaultRepository,
)
from diandianreading.domain.content import ExportOutcome, ExportTargetKind
from diandianreading.domain.errors import DiandianError, ErrorCode
from diandianreading.domain.models import utc_now
from diandianreading.domain.vault import (
    CONFLICT_SUFFIX,
    DIANDIAN_ID_KEY,
    ObsidianDocument,
    build_document,
    content_digest,
    deep_link,
    parse_frontmatter,
    resolve_in_vault,
    sanitize_segment,
)

#: Vault files may be scanned when a recorded path no longer resolves.
MAX_SCANNED_FILES = 5_000

_TARGET_FILENAMES: dict[ExportTargetKind, str] = {
    ExportTargetKind.BOOK: "Book.md",
    ExportTargetKind.HIGHLIGHTS: "Highlights.md",
    ExportTargetKind.NOTES: "Notes.md",
    ExportTargetKind.SUMMARY: "Summary.md",
}


class VaultNotConfiguredError(DiandianError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VALIDATION, "No Obsidian vault is configured", retryable=False)


class VaultUnavailableError(DiandianError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.VALIDATION, "The configured vault directory is unavailable", retryable=False
        )


@dataclass(frozen=True, slots=True)
class ExportTarget:
    """One file the exporter is asked to reconcile."""

    kind: ExportTargetKind
    target_id: str
    title: str
    body: str
    extra: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class ExportResult:
    """What happened to one target."""

    kind: ExportTargetKind
    target_id: str
    outcome: ExportOutcome
    relative_path: str
    deep_link: str
    conflict_path: str | None = None


class ObsidianExportService:
    def __init__(
        self,
        *,
        vaults: VaultRepository,
        state: ObsidianExportStateRepository,
    ) -> None:
        self._vaults = vaults
        self._state = state

    def configure_vault(
        self, *, name: str, root_path: str, now: datetime | None = None
    ) -> VaultConfig:
        """Point the exporter at a vault directory the user owns."""

        root = Path(root_path).expanduser()
        if not root.is_absolute():
            raise DiandianError(
                ErrorCode.VALIDATION, "Vault path must be absolute", retryable=False
            )
        if not root.is_dir():
            raise VaultUnavailableError()
        return self._vaults.set_active(
            vault_id=f"vault-{uuid4()}",
            name=name.strip() or root.name,
            root_path=str(root.resolve()),
            now=now or utc_now(),
        )

    def active_vault(self) -> VaultConfig | None:
        return self._vaults.get_active()

    def export_book(
        self,
        *,
        book_id: str,
        book_title: str,
        targets: tuple[ExportTarget, ...],
        now: datetime | None = None,
    ) -> tuple[ExportResult, ...]:
        """Reconcile every target for one book against the vault."""

        vault = self._vaults.get_active()
        if vault is None:
            raise VaultNotConfiguredError()
        root = Path(vault.root_path)
        if not root.is_dir():
            raise VaultUnavailableError()
        moment = now or utc_now()
        folder = ("Books", book_title)
        return tuple(self._reconcile(vault, root, folder, target, moment) for target in targets)

    def _reconcile(
        self,
        vault: VaultConfig,
        root: Path,
        folder: tuple[str, ...],
        target: ExportTarget,
        now: datetime,
    ) -> ExportResult:
        document = build_document(
            diandian_id=target.target_id,
            title=target.title,
            body=target.body,
            extra=target.extra,
        )
        record = self._state.get(
            vault_id=vault.id, target_kind=target.kind, target_id=target.target_id
        )
        existing = self._locate(root, vault, target, record)
        if existing is None:
            destination = resolve_in_vault(root, *folder, *self._filename(target))
            return self._write(
                vault, root, destination, document, target, now, ExportOutcome.CREATED
            )

        stored_text = existing.read_text(encoding="utf-8", errors="replace")
        stored_fields = parse_frontmatter(stored_text)
        stored_body = _body_of(stored_text)
        previous_digest = record.exported_sha256 if record is not None else None

        if previous_digest is not None and content_digest(stored_body) != previous_digest:
            # The user edited this file. Overwriting would destroy work Obsidian
            # cannot restore, so the new render lands beside it instead.
            conflict = existing.with_name(f"{existing.stem}{CONFLICT_SUFFIX}")
            conflict.write_text(document.text, encoding="utf-8")
            return ExportResult(
                kind=target.kind,
                target_id=target.target_id,
                outcome=ExportOutcome.CONFLICT,
                relative_path=_relative(root, existing),
                deep_link=deep_link(vault.name, _relative(root, existing)),
                conflict_path=_relative(root, conflict),
            )

        if (
            stored_fields.get(DIANDIAN_ID_KEY) == target.target_id
            and content_digest(stored_body) == document.digest
        ):
            self._remember(vault, target, root, existing, document, now, record)
            return ExportResult(
                kind=target.kind,
                target_id=target.target_id,
                outcome=ExportOutcome.UNCHANGED,
                relative_path=_relative(root, existing),
                deep_link=deep_link(vault.name, _relative(root, existing)),
            )

        return self._write(vault, root, existing, document, target, now, ExportOutcome.UPDATED)

    def _filename(self, target: ExportTarget) -> tuple[str, ...]:
        """Path segments beneath the book folder.

        Returned as separate segments on purpose: a single string containing a
        separator would be sanitised into one flat name, silently collapsing the
        ``Social Posts`` subdirectory.
        """

        if target.kind is ExportTargetKind.SOCIAL_POSTS:
            return ("Social Posts", f"{sanitize_segment(target.title)}.md")
        return (_TARGET_FILENAMES[target.kind],)

    def _locate(
        self,
        root: Path,
        vault: VaultConfig,
        target: ExportTarget,
        record: ExportRecord | None,
    ) -> Path | None:
        """Find the file for this target: recorded path first, identity second."""

        if record is not None:
            candidate = root / record.vault_relpath
            if candidate.is_file():
                return candidate
            # The recorded path is gone. The user may simply have renamed it, so
            # look for the identity before concluding this is a new export.
            found = self._scan_for_identity(root, target.target_id)
            if found is not None:
                return found
            return None
        return self._scan_for_identity(root, target.target_id)

    def _scan_for_identity(self, root: Path, target_id: str) -> Path | None:
        scanned = 0
        for path in sorted(root.rglob("*.md")):
            if path.name.endswith(CONFLICT_SUFFIX):
                continue
            scanned += 1
            if scanned > MAX_SCANNED_FILES:
                return None
            try:
                head = path.read_text(encoding="utf-8", errors="replace")[:4096]
            except OSError:
                continue
            if parse_frontmatter(head).get(DIANDIAN_ID_KEY) == target_id:
                return path
        return None

    def _write(
        self,
        vault: VaultConfig,
        root: Path,
        destination: Path,
        document: ObsidianDocument,
        target: ExportTarget,
        now: datetime,
        outcome: ExportOutcome,
    ) -> ExportResult:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(document.text, encoding="utf-8")
        record = self._remember(vault, target, root, destination, document, now, None)
        return ExportResult(
            kind=target.kind,
            target_id=target.target_id,
            outcome=outcome,
            relative_path=record.vault_relpath,
            deep_link=deep_link(vault.name, record.vault_relpath),
        )

    def _remember(
        self,
        vault: VaultConfig,
        target: ExportTarget,
        root: Path,
        destination: Path,
        document: ObsidianDocument,
        now: datetime,
        record: ExportRecord | None,
    ) -> ExportRecord:
        updated = ExportRecord(
            id=record.id if record is not None else f"export-{uuid4()}",
            vault_id=vault.id,
            target_kind=target.kind,
            target_id=target.target_id,
            vault_relpath=_relative(root, destination),
            exported_sha256=document.digest,
            exported_at=now,
            version=0,
        )
        self._state.upsert(updated)
        return updated


def _relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _body_of(text: str) -> str:
    """Return the body beneath a frontmatter block, if any."""

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text.strip("\n")
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return "\n".join(lines[index + 1 :]).strip("\n")
    return text.strip("\n")
