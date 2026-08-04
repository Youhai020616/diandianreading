"""Content generation use case (C1b, ADR-0008 section 2b).

The content asset row is the durable task unit. It carries its own lease and
provider-operation columns rather than borrowing the import saga's ``jobs`` and
``remote_operations`` tables: ``remote_operations.job_id`` is a NOT NULL foreign
key into ``jobs``, whose step vocabulary (``acquiring``/``uploading``/…) is
document-import specific. Chat already solved the same problem the same way, so
generation follows that precedent instead of widening the import tables.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import NAMESPACE_URL, uuid4, uuid5

from diandianreading.application.ports.content import ContentAssetRepository
from diandianreading.application.ports.knowledge import (
    KnowledgeGenerationPort,
    generation_input_hash,
)
from diandianreading.application.ports.repositories import KnowledgeMappingRepository
from diandianreading.domain.content import (
    CONTENT_BODY_MAX_CODEPOINTS,
    CONTENT_TITLE_MAX_CODEPOINTS,
    ContentAsset,
    ContentFailureCode,
    ContentLength,
    ContentRevision,
    ContentStatus,
    ContentTone,
    ContentType,
    GenerationRequest,
    RevisionAuthor,
    ensure_supported_in_p5,
    provider_content_type,
)
from diandianreading.domain.errors import DiandianError, ErrorCode, RepositoryConflict
from diandianreading.domain.models import (
    RemoteOperationKind,
    RemoteOperationRef,
    WorkspaceRef,
    utc_now,
)

DEFAULT_LEASE_SECONDS = 300

_TYPE_INSTRUCTIONS: dict[ContentType, str] = {
    ContentType.READING_REPORT: "写一篇结构化的读书长文，包含背景、核心论点、论据与结论。",
    ContentType.READING_CARD: "写一张读书卡片：一个核心观点、两到三条支撑、一句可分享的结语。",
    ContentType.SLIDES: "输出幻灯片大纲：每页一个标题加三条要点，页与页之间保持递进。",
    ContentType.PODCAST_SCRIPT: "输出播客脚本：开场、观点展开、转场与结尾，用口语化的完整句子。",
    ContentType.VIDEO_SCRIPT: "输出视频脚本：标题、分镜、旁白与字幕建议，按镜头分段。",
    ContentType.SHORT_POST: "写一条社交短帖：第一句抓住注意力，全文不超过三段。",
    ContentType.QUIZ: "输出复习题：题目、选项与答案解析，覆盖关键概念。",
}

_TONE_INSTRUCTIONS: dict[ContentTone, str] = {
    ContentTone.RATIONAL: "语气理性克制，先给判断再给依据。",
    ContentTone.PERSONAL: "语气个人化，可以使用具体经历与感受。",
    ContentTone.NARRATIVE: "用故事化的方式组织，先场景后观点。",
    ContentTone.CONCISE: "语气简洁，删掉一切修饰。",
}

_LENGTH_INSTRUCTIONS: dict[ContentLength, str] = {
    ContentLength.SHORT: "长度控制在 300 字以内。",
    ContentLength.MEDIUM: "长度控制在 800 字左右。",
    ContentLength.LONG: "长度可以到 2000 字。",
}


class ContentNotFoundError(DiandianError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VALIDATION, "Content asset was not found", retryable=False)


class UnsupportedContentStatusError(DiandianError):
    def __init__(self, status: ContentStatus) -> None:
        super().__init__(
            ErrorCode.VALIDATION,
            f"Content status {status.value} belongs to the P6 publishing track",
            retryable=False,
        )


@dataclass(frozen=True, slots=True)
class GenerationOutcome:
    """What one worker turn did, for tests and the offline demo."""

    content_id: str
    status: ContentStatus
    failure_code: ContentFailureCode | None


def build_instructions(request: GenerationRequest) -> str:
    """Compose a bounded, deterministic instruction string for the provider.

    Determinism matters beyond tidiness: the instruction text feeds
    ``generation_input_hash``, which is the fingerprint that lets a retry be
    recognised as the same intent instead of creating a second remote artefact.
    """

    parts = [
        _TYPE_INSTRUCTIONS[request.content_type],
        _TONE_INSTRUCTIONS[request.tone],
        _LENGTH_INSTRUCTIONS[request.length],
        f"使用 {request.language} 输出。",
    ]
    if request.target_platform is not None:
        parts.append(f"面向 {request.target_platform} 平台的表达习惯。")
    parts.append("使用第一人称。" if request.first_person else "不要使用第一人称。")
    parts.append("必须保留可核对的引用。" if request.require_citations else "不必强制附带引用。")
    references = "、".join(f"{s.kind.value}:{s.reference}" for s in request.sources)
    parts.append(f"输入来源：{references}。")
    return " ".join(parts)


class ContentGenerationUseCase:
    def __init__(
        self,
        *,
        assets: ContentAssetRepository,
        knowledge_generation: KnowledgeGenerationPort,
        mappings: KnowledgeMappingRepository,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> None:
        if lease_seconds <= 0:
            raise ValueError("Lease seconds must be positive")
        self._assets = assets
        self._generation = knowledge_generation
        self._mappings = mappings
        self._lease_seconds = lease_seconds

    def submit(
        self, *, book_id: str, request: GenerationRequest, now: datetime | None = None
    ) -> ContentAsset:
        moment = now or utc_now()
        asset = ContentAsset(
            id=f"content-{uuid4()}",
            book_id=book_id,
            request=request,
            status=ContentStatus.QUEUED,
            latest_revision_number=0,
            created_at=moment,
            updated_at=moment,
            version=0,
        )
        self._assets.create(asset)
        return asset

    def get(self, content_id: str) -> ContentAsset | None:
        return self._assets.get(content_id)

    def list_revisions(self, content_id: str) -> Sequence[ContentRevision]:
        return self._assets.list_revisions(content_id)

    def list_for_book(self, book_id: str, *, limit: int = 100) -> tuple[ContentAsset, ...]:
        return tuple(self._assets.list_for_book(book_id, limit=limit))

    def list_drafts(self, book_id: str, *, limit: int = 100) -> tuple[ContentRevision, ...]:
        """Latest revision of every settled asset for one book.

        Export consumes drafts, not tasks: an asset still queued or generating
        has no revision to write, so it is skipped rather than exported empty.
        """

        drafts = []
        for asset in self._assets.list_for_book(book_id, limit=limit):
            if asset.latest_revision_number < 1:
                continue
            revisions = self._assets.list_revisions(asset.id)
            if revisions:
                drafts.append(revisions[-1])
        return tuple(drafts)

    def request_cancel(self, content_id: str, *, now: datetime | None = None) -> bool:
        return self._assets.request_cancel(content_id, now=now or utc_now())

    def edit(
        self,
        content_id: str,
        *,
        title: str,
        body: str,
        now: datetime | None = None,
    ) -> ContentAsset:
        asset = self._assets.get(content_id)
        if asset is None:
            raise ContentNotFoundError()
        ensure_supported_in_p5(asset.status)
        if asset.latest_revision_number < 1:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "A draft must exist before it can be edited",
                retryable=False,
            )
        moment = now or utc_now()
        revision = ContentRevision(
            id=f"revision-{uuid4()}",
            content_id=content_id,
            revision_number=asset.latest_revision_number + 1,
            author_kind=RevisionAuthor.HUMAN,
            title=title.strip()[:CONTENT_TITLE_MAX_CODEPOINTS],
            body=body.strip()[:CONTENT_BODY_MAX_CODEPOINTS],
            created_at=moment,
        )
        return self._assets.append_human_revision(content_id, revision, now=moment)

    async def run_next(self, *, worker_id: str) -> GenerationOutcome | None:
        """Claim and execute one generation attempt."""

        now = utc_now()
        claimed = self._assets.claim_next(
            worker_id=worker_id, now=now, lease_seconds=self._lease_seconds
        )
        if claimed is None:
            return None
        asset, token = claimed

        # Cancelling before dispatch is free; after dispatch the remote artefact
        # already exists, so the attempt runs to completion and the cancellation
        # is reported as late rather than leaving an orphaned provider job.
        if self._assets.cancel_requested(asset.id):
            self._assets.fail(asset.id, token, code=ContentFailureCode.CANCELLED, now=utc_now())
            return GenerationOutcome(asset.id, ContentStatus.QUEUED, ContentFailureCode.CANCELLED)

        workspace = self._mappings.get_workspace_for_book(asset.book_id)
        if workspace is None:
            self._assets.fail(
                asset.id, token, code=ContentFailureCode.PROVIDER_UNAVAILABLE, now=utc_now()
            )
            return GenerationOutcome(
                asset.id, ContentStatus.QUEUED, ContentFailureCode.PROVIDER_UNAVAILABLE
            )

        instructions = build_instructions(asset.request)
        provider_type = provider_content_type(asset.request.content_type)
        input_hash = generation_input_hash(provider_type, instructions)
        idempotency_key = f"{asset.id}:{RemoteOperationKind.GENERATE_CONTENT.value}:{input_hash}"
        operation = RemoteOperationRef(
            id=str(uuid5(NAMESPACE_URL, f"content-operation:{idempotency_key}")),
            idempotency_key=idempotency_key,
            kind=RemoteOperationKind.GENERATE_CONTENT,
            local_resource_id=workspace.id,
            input_hash=input_hash,
            external_id=None,
        )

        try:
            self._assets.bind_provider_operation(
                asset.id, token, operation_id=operation.id, now=utc_now()
            )
            handle = await self._generation.generate(
                WorkspaceRef(
                    id=workspace.id,
                    provider=workspace.provider,
                    external_id=workspace.external_id,
                    status=workspace.status,
                ),
                provider_type,
                instructions,
                operation,
            )
            produced = await self._generation.wait(handle)
        except RepositoryConflict:
            # Another worker fenced this one out; it must not write anything.
            return GenerationOutcome(asset.id, ContentStatus.GENERATING, None)
        except DiandianError as error:
            code = (
                ContentFailureCode.PROVIDER_OUTCOME_AMBIGUOUS
                if error.code is ErrorCode.REMOTE_OUTCOME_AMBIGUOUS
                else ContentFailureCode.PROVIDER_UNAVAILABLE
            )
            self._assets.fail(asset.id, token, code=code, now=utc_now())
            return GenerationOutcome(asset.id, ContentStatus.QUEUED, code)

        text = (produced.text or "").strip()
        if not text:
            self._assets.fail(
                asset.id, token, code=ContentFailureCode.EMPTY_PROVIDER_RESULT, now=utc_now()
            )
            return GenerationOutcome(
                asset.id, ContentStatus.QUEUED, ContentFailureCode.EMPTY_PROVIDER_RESULT
            )

        revision = ContentRevision(
            id=f"revision-{uuid4()}",
            content_id=asset.id,
            revision_number=asset.latest_revision_number + 1,
            author_kind=RevisionAuthor.AI,
            title=(produced.title or asset.request.content_type.value)[
                :CONTENT_TITLE_MAX_CODEPOINTS
            ],
            body=text[:CONTENT_BODY_MAX_CODEPOINTS],
            created_at=utc_now(),
        )
        completed = self._assets.complete_with_revision(asset.id, token, revision, now=utc_now())
        return GenerationOutcome(completed.id, completed.status, None)
