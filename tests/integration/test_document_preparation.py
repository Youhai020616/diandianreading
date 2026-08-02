from __future__ import annotations

import asyncio
import io
import json
import stat
import zipfile

import pytest

from diandianreading.application.ports import AcquisitionRequest
from diandianreading.domain import DiandianError, ErrorCode, TargetCapabilities
from diandianreading.infrastructure.acquisition import LocalFileAcquirer
from diandianreading.infrastructure.documents import (
    DocumentSecurityLimits,
    LocalDocumentPreparationAdapter,
)
from diandianreading.infrastructure.storage import LocalFileStore
from tests.support import RecordingProgressSink


def capabilities(
    *,
    max_words: int = 20,
    max_bytes: int = 200,
    max_sources: int = 20,
    mime_types: frozenset[str] | None = None,
) -> TargetCapabilities:
    return TargetCapabilities(
        max_source_words=max_words,
        max_source_bytes=max_bytes,
        max_sources_per_workspace=max_sources,
        accepted_mime_types=mime_types or frozenset({"text/markdown", "application/pdf"}),
    )


def acquire(path, store: LocalFileStore):
    return asyncio.run(
        LocalFileAcquirer(store).acquire(
            AcquisitionRequest(
                provider="local",
                location=str(path),
                rights_confirmed=True,
                options={"rights_provenance_id": "rights-local-test"},
            ),
            RecordingProgressSink([]),
        )
    ).asset


def test_markdown_preparation_is_deterministic_bounded_and_manifested(tmp_path) -> None:
    source = tmp_path / "book.md"
    source.write_text(
        "# One\n\none two three four five six\n\n"
        "## Two\n\n七八九十十一十二\n\n"
        "## Three\n\nfinal chapter words",
        encoding="utf-8",
    )
    store = LocalFileStore(tmp_path / "objects")
    asset = acquire(source, store)
    adapter = LocalDocumentPreparationAdapter(store)
    progress = RecordingProgressSink([])

    first = asyncio.run(adapter.prepare(asset, capabilities(max_words=5, max_bytes=45), progress))
    repeated = asyncio.run(
        adapter.prepare(asset, capabilities(max_words=5, max_bytes=45), progress)
    )

    assert repeated == first
    assert first.derived_assets == ()
    assert len(first.parts) > 1
    assert all(part.asset_id == asset.id for part in first.parts)
    assert all(part.word_count <= 5 and part.size_bytes <= 45 for part in first.parts)
    assert all(part.chapter_refs for part in first.parts)
    with store.open(first.manifest.storage_key) as manifest_file:
        manifest_bytes = manifest_file.read()
    assert first.manifest.sha256 == __import__("hashlib").sha256(manifest_bytes).hexdigest()
    manifest = json.loads(manifest_bytes)
    assert manifest["root_asset"]["id"] == asset.id
    assert len(manifest["parts"]) == len(first.parts)
    assert manifest["policy"]["target_capabilities"] == {
        "accepted_mime_types": ["application/pdf", "text/markdown"],
        "max_source_bytes": 45,
        "max_source_words": 5,
        "max_sources_per_workspace": 20,
    }
    assert str(tmp_path) not in manifest_bytes.decode("utf-8")
    assert [event.step for event in progress.events] == [
        "preparing",
        "preparing",
        "preparing",
        "preparing",
    ]


def test_pdf_preparation_uses_original_asset_and_rejects_invalid_or_oversized_pdf(tmp_path) -> None:
    source = tmp_path / "book.pdf"
    source.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF")
    store = LocalFileStore(tmp_path / "objects")
    asset = acquire(source, store)
    adapter = LocalDocumentPreparationAdapter(store)

    prepared = asyncio.run(
        adapter.prepare(asset, capabilities(max_bytes=100), RecordingProgressSink([]))
    )

    assert prepared.derived_assets == ()
    assert len(prepared.parts) == 1
    assert prepared.parts[0].storage_key == asset.storage_key
    assert prepared.parts[0].sha256 == asset.sha256
    assert prepared.parts[0].chapter_refs == ("pdf-document",)

    with pytest.raises(DiandianError) as oversized:
        asyncio.run(adapter.prepare(asset, capabilities(max_bytes=10), RecordingProgressSink([])))
    assert oversized.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED

    malformed = tmp_path / "malformed.pdf"
    malformed.write_bytes(b"%PDF-1.4\nmissing eof")
    malformed_asset = acquire(malformed, store)
    with pytest.raises(DiandianError) as invalid:
        asyncio.run(
            adapter.prepare(malformed_asset, capabilities(max_bytes=100), RecordingProgressSink([]))
        )
    assert invalid.value.code is ErrorCode.CONVERSION_FAILED


def test_epub_preparation_uses_spine_order_derives_markdown_and_ignores_active_content(
    tmp_path,
) -> None:
    source = tmp_path / "book.epub"
    make_epub(source)
    store = LocalFileStore(tmp_path / "objects")
    asset = acquire(source, store)
    adapter = LocalDocumentPreparationAdapter(store)

    prepared = asyncio.run(
        adapter.prepare(asset, capabilities(max_words=50, max_bytes=500), RecordingProgressSink([]))
    )

    assert len(prepared.derived_assets) == 1
    derived = prepared.derived_assets[0]
    assert derived.derived_from_asset_id == asset.id
    assert derived.mime_type == "text/markdown"
    assert derived.title == "Synthetic Book"
    assert derived.author == "Test Author"
    assert all(part.asset_id == derived.id for part in prepared.parts)
    assert {reference for part in prepared.parts for reference in part.chapter_refs} == {
        "epub-spine-0001",
        "epub-spine-0002",
    }
    with store.open(derived.storage_key) as markdown_file:
        markdown = markdown_file.read().decode("utf-8")
    assert markdown.index("First chapter") < markdown.index("Second chapter")
    assert "alert" not in markdown
    assert "malformed-skip-leak" not in markdown
    assert "content after embed" in markdown
    assert "tracker.invalid" not in markdown


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        ("traversal", ErrorCode.CONVERSION_FAILED),
        ("collision", ErrorCode.CONVERSION_FAILED),
        ("symlink", ErrorCode.CONVERSION_FAILED),
        ("nested", ErrorCode.FORMAT_UNSUPPORTED),
        ("doctype", ErrorCode.CONVERSION_FAILED),
        ("query", ErrorCode.CONVERSION_FAILED),
    ],
)
def test_epub_preparation_fails_closed_for_malicious_archive_fixtures(
    tmp_path,
    mutation,
    expected_code,
) -> None:
    source = tmp_path / f"{mutation}.epub"
    make_epub(source, mutation=mutation)
    store = LocalFileStore(tmp_path / f"objects-{mutation}")
    asset = acquire(source, store)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            LocalDocumentPreparationAdapter(store).prepare(
                asset,
                capabilities(max_bytes=1_000),
                RecordingProgressSink([]),
            )
        )
    assert raised.value.code is expected_code


def test_epub_preparation_enforces_entry_count_and_compression_ratio_before_parsing(
    tmp_path,
) -> None:
    source = tmp_path / "book.epub"
    make_epub(source, mutation="bomb")
    store = LocalFileStore(tmp_path / "objects")
    asset = acquire(source, store)

    count_limits = DocumentSecurityLimits(max_archive_entries=4)
    with pytest.raises(DiandianError) as count_error:
        asyncio.run(
            LocalDocumentPreparationAdapter(store, limits=count_limits).prepare(
                asset,
                capabilities(max_bytes=1_000),
                RecordingProgressSink([]),
            )
        )
    assert count_error.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED

    ratio_limits = DocumentSecurityLimits(max_compression_ratio=2)
    with pytest.raises(DiandianError) as ratio_error:
        asyncio.run(
            LocalDocumentPreparationAdapter(store, limits=ratio_limits).prepare(
                asset,
                capabilities(max_bytes=1_000),
                RecordingProgressSink([]),
            )
        )
    assert ratio_error.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED


def test_preparation_rejects_unaccepted_target_mime_and_tampered_object(tmp_path) -> None:
    source = tmp_path / "book.md"
    source.write_text("# Book\n\ncontent", encoding="utf-8")
    root = tmp_path / "objects"
    store = LocalFileStore(root)
    asset = acquire(source, store)
    adapter = LocalDocumentPreparationAdapter(store)

    with pytest.raises(DiandianError) as unsupported:
        asyncio.run(
            adapter.prepare(
                asset,
                capabilities(mime_types=frozenset({"application/pdf"})),
                RecordingProgressSink([]),
            )
        )
    assert unsupported.value.code is ErrorCode.FORMAT_UNSUPPORTED

    object_path = root / asset.storage_key.value
    object_path.write_bytes(b"tampered")
    object_path.chmod(0o600)
    with pytest.raises(DiandianError) as tampered:
        asyncio.run(adapter.prepare(asset, capabilities(), RecordingProgressSink([])))
    assert tampered.value.code is ErrorCode.SOURCE_UNAVAILABLE


def make_epub(path, *, mutation: str | None = None) -> None:
    container = (
        '<?xml version="1.0"?>'
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    chapter_one_href = (
        "chapter1.xhtml?tracking=forbidden" if mutation == "query" else "chapter1.xhtml#content"
    )
    package = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">'
        "<metadata><dc:title>Synthetic Book</dc:title>"
        "<dc:creator>Test Author</dc:creator></metadata>"
        f'<manifest><item id="c1" href="{chapter_one_href}" media-type="application/xhtml+xml"/>'
        '<item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
    )
    chapter1 = (
        ("<!DOCTYPE html>" if mutation == "doctype" else "")
        + "<html><body><h1>First chapter</h1><p>one two three</p>"
        "<script>alert(1)</script>"
        "<svg><object></svg></object>malformed-skip-leak</body></html>"
    )
    chapter2 = (
        "<html><body><h1>Second chapter</h1><p>四五六</p>"
        '<img src="https://tracker.invalid/pixel"/><embed src="active.invalid"/>'
        "<p>content after embed</p></body></html>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, "application/epub+zip")
        archive.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/content.opf", package, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/chapter1.xhtml", chapter1, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/chapter2.xhtml", chapter2, compress_type=zipfile.ZIP_DEFLATED)
        if mutation == "traversal":
            archive.writestr("../escape.txt", "escape")
        elif mutation == "collision":
            archive.writestr("OEBPS/DUP.txt", "one")
            archive.writestr("oebps/dup.txt", "two")
        elif mutation == "symlink":
            member = zipfile.ZipInfo("OEBPS/link")
            member.create_system = 3
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(member, "chapter1.xhtml")
        elif mutation == "nested":
            archive.writestr("OEBPS/payload.zip", io.BytesIO(b"PK\x03\x04").getvalue())
        elif mutation == "bomb":
            archive.writestr(
                "OEBPS/repetitive.txt",
                b"0" * 100_000,
                compress_type=zipfile.ZIP_DEFLATED,
            )
