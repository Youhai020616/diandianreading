"""Finite parser budgets and deterministic text chunking."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from diandianreading.domain import DiandianError, ErrorCode, TargetCapabilities

_CJK_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
)
_LATIN_WORD = re.compile(r"[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*")
_HEADING = re.compile(r"(?m)^(#{1,6})[ \t]+(.+?)\s*$")
_BREAK_CHARACTERS = frozenset(" \t\n\u3002\uff01\uff1f.!?;\uff1b,\uff0c:\uff1a")


@dataclass(frozen=True, slots=True)
class DocumentSecurityLimits:
    max_input_bytes: int = 100 * 1024 * 1024
    max_archive_entries: int = 2_000
    max_archive_entry_bytes: int = 20 * 1024 * 1024
    max_archive_total_bytes: int = 200 * 1024 * 1024
    max_compression_ratio: int = 100
    max_archive_depth: int = 16
    max_archive_name_length: int = 255
    max_xml_bytes: int = 5 * 1024 * 1024
    max_parser_output_bytes: int = 100 * 1024 * 1024
    parser_timeout_seconds: int = 20
    parser_cpu_seconds: int = 10
    parser_memory_bytes: int = 512 * 1024 * 1024

    def __post_init__(self) -> None:
        values = (
            self.max_input_bytes,
            self.max_archive_entries,
            self.max_archive_entry_bytes,
            self.max_archive_total_bytes,
            self.max_compression_ratio,
            self.max_archive_depth,
            self.max_archive_name_length,
            self.max_xml_bytes,
            self.max_parser_output_bytes,
            self.parser_timeout_seconds,
            self.parser_cpu_seconds,
            self.parser_memory_bytes,
        )
        if any(value <= 0 for value in values):
            raise ValueError("Document security limits must be positive and finite")
        if self.max_archive_entry_bytes > self.max_archive_total_bytes:
            raise ValueError("Archive entry limit cannot exceed the total archive limit")


@dataclass(frozen=True, slots=True)
class TextChapter:
    reference: str
    markdown: str


@dataclass(frozen=True, slots=True)
class PreparedChunk:
    content: str
    chapter_refs: tuple[str, ...]
    word_count: int
    size_bytes: int


def normalize_markdown(value: str) -> str:
    if "\x00" in value:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "Document text contains a NUL character",
            retryable=False,
        )
    normalized = unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")
    normalized = "\n".join(line.rstrip() for line in normalized.split("\n")).strip()
    if not normalized:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "Document contains no readable text",
            retryable=False,
        )
    return f"{normalized}\n"


def count_words(value: str) -> int:
    cjk = sum(_is_cjk(character) for character in value)
    without_cjk = "".join(" " if _is_cjk(character) else character for character in value)
    return cjk + len(_LATIN_WORD.findall(without_cjk))


def markdown_chapters(value: str) -> tuple[TextChapter, ...]:
    normalized = normalize_markdown(value)
    headings = list(_HEADING.finditer(normalized))
    if not headings:
        return (TextChapter("markdown-section-0001", normalized),)

    chapters: list[TextChapter] = []
    if normalized[: headings[0].start()].strip():
        chapters.append(TextChapter("markdown-preamble", normalized[: headings[0].start()]))
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(normalized)
        chapters.append(
            TextChapter(
                reference=f"markdown-heading-{index + 1:04d}",
                markdown=normalized[heading.start() : end],
            )
        )
    return tuple(chapters)


def chunk_chapters(
    chapters: tuple[TextChapter, ...],
    capabilities: TargetCapabilities,
) -> tuple[PreparedChunk, ...]:
    pieces: list[tuple[str, str]] = []
    for chapter in chapters:
        normalized = normalize_markdown(chapter.markdown)
        for piece in _split_to_limits(
            normalized,
            max_words=capabilities.max_source_words,
            max_bytes=capabilities.max_source_bytes,
        ):
            pieces.append((chapter.reference, piece))

    chunks: list[PreparedChunk] = []
    current = ""
    references: list[str] = []
    for reference, piece in pieces:
        candidate = f"{current.rstrip()}\n\n{piece.lstrip()}" if current else piece
        if current and not _fits(
            candidate, capabilities.max_source_words, capabilities.max_source_bytes
        ):
            chunks.append(_chunk(current, references))
            current = piece
            references = [reference]
        else:
            current = candidate
            if reference not in references:
                references.append(reference)
    if current:
        chunks.append(_chunk(current, references))
    chunks = _deduplicate_chunks(chunks)
    if not chunks:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "Document preparation produced no source parts",
            retryable=False,
        )
    if len(chunks) > capabilities.max_sources_per_workspace:
        raise DiandianError(
            ErrorCode.SOURCE_LIMIT_EXCEEDED,
            "Prepared document exceeds the target source-count limit",
            retryable=False,
        )
    return tuple(chunks)


def _deduplicate_chunks(chunks: list[PreparedChunk]) -> list[PreparedChunk]:
    deduplicated: list[PreparedChunk] = []
    index_by_content: dict[str, int] = {}
    for chunk in chunks:
        existing_index = index_by_content.get(chunk.content)
        if existing_index is None:
            index_by_content[chunk.content] = len(deduplicated)
            deduplicated.append(chunk)
            continue
        existing = deduplicated[existing_index]
        chapter_refs = tuple(dict.fromkeys((*existing.chapter_refs, *chunk.chapter_refs)))
        deduplicated[existing_index] = PreparedChunk(
            content=existing.content,
            chapter_refs=chapter_refs,
            word_count=existing.word_count,
            size_bytes=existing.size_bytes,
        )
    return deduplicated


def _split_to_limits(value: str, *, max_words: int, max_bytes: int) -> tuple[str, ...]:
    remaining = value
    pieces: list[str] = []
    while remaining:
        if _fits(remaining, max_words, max_bytes):
            pieces.append(remaining)
            break
        low = 1
        high = len(remaining)
        fitting = 0
        while low <= high:
            middle = (low + high) // 2
            if _fits(remaining[:middle], max_words, max_bytes):
                fitting = middle
                low = middle + 1
            else:
                high = middle - 1
        if fitting == 0:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "A document character cannot fit within the target byte limit",
                retryable=False,
            )
        boundary_floor = max(1, fitting - max(32, fitting // 5))
        boundary = next(
            (
                index
                for index in range(fitting, boundary_floor - 1, -1)
                if remaining[index - 1] in _BREAK_CHARACTERS
            ),
            fitting,
        )
        piece = remaining[:boundary].strip()
        if not piece:
            piece = remaining[:fitting]
            boundary = fitting
        pieces.append(f"{piece}\n")
        remaining = remaining[boundary:].lstrip()
    return tuple(pieces)


def _chunk(content: str, references: list[str]) -> PreparedChunk:
    normalized = normalize_markdown(content)
    return PreparedChunk(
        content=normalized,
        chapter_refs=tuple(references),
        word_count=count_words(normalized),
        size_bytes=len(normalized.encode("utf-8")),
    )


def _fits(value: str, max_words: int, max_bytes: int) -> bool:
    stripped = value.strip()
    normalized = f"{stripped}\n" if stripped else ""
    return count_words(normalized) <= max_words and len(normalized.encode("utf-8")) <= max_bytes


def _is_cjk(character: str) -> bool:
    codepoint = ord(character)
    return any(start <= codepoint <= end for start, end in _CJK_RANGES)
