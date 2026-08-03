from __future__ import annotations

import asyncio

import pytest

from diandianreading.application.use_cases.import_book import ImportBookUseCase
from diandianreading.domain import DiandianError, ErrorCode, JobStatus
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from diandianreading.infrastructure.persistence import SQLiteDatabase, SQLiteUnitOfWorkFactory
from diandianreading.worker.runner import WorkerRunner
from tests.support import FIXED_NOW, SequentialIds, make_import_command


class OneChatRun:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.available = True

    async def run_next(self, *, worker_id: str):
        self.calls.append(worker_id)
        if not self.available:
            return None
        self.available = False
        return object()


class UnexpectedImportWorker:
    async def run_next(self, *, worker_id: str):
        del worker_id
        raise RuntimeError("unexpected worker failure")


class FailedImportWorker:
    def __init__(self, *, projected: bool) -> None:
        self.error = DiandianError(ErrorCode.VALIDATION, "safe import failure", retryable=False)
        if projected:
            self.error.__dict__["durably_projected"] = True

    async def run_next(self, *, worker_id: str):
        del worker_id
        raise self.error


def test_worker_run_once_attempts_one_import_then_one_chat_run(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    imports = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=FakeKnowledgeAdapter(),
        id_factory=SequentialIds("book-1", "job-1"),
        clock=lambda: FIXED_NOW,
    )
    submitted = imports.submit(make_import_command(tmp_path, part_count=1))
    chat = OneChatRun()
    runner = WorkerRunner(imports=imports, chat=chat, worker_id="worker-one")

    assert asyncio.run(runner.run_once()) is True
    assert chat.calls == ["worker-one"]
    with SQLiteUnitOfWorkFactory(database)() as unit_of_work:
        completed = unit_of_work.jobs.get(submitted.id)
        unit_of_work.commit()
    assert completed is not None and completed.status is JobStatus.COMPLETED

    assert asyncio.run(runner.run_once()) is False
    assert chat.calls == ["worker-one", "worker-one"]


def test_worker_catches_only_import_errors_marked_as_durably_projected() -> None:
    assert asyncio.run(WorkerRunner(imports=FailedImportWorker(projected=True)).run_once()) is True
    with pytest.raises(DiandianError, match="safe import failure"):
        asyncio.run(WorkerRunner(imports=FailedImportWorker(projected=False)).run_once())


def test_worker_propagates_unexpected_errors_instead_of_spinning() -> None:
    runner = WorkerRunner(imports=UnexpectedImportWorker(), poll_interval=0.01)
    with pytest.raises(RuntimeError, match="unexpected worker failure"):
        asyncio.run(runner.run_once())


def test_worker_forever_honors_an_already_set_stop_event() -> None:
    stop = asyncio.Event()
    stop.set()
    worker = OneChatRun()
    runner = WorkerRunner(imports=worker, poll_interval=0.01)
    asyncio.run(runner.run_forever(stop))
    assert worker.calls == []


def test_worker_forever_retries_after_idle_timeout_then_stops() -> None:
    class NoWork:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def run_next(self, *, worker_id: str):
            self.calls.append(worker_id)
            return None

    class TimeoutThenStop:
        def __init__(self) -> None:
            self.stopped = False
            self.wait_calls = 0

        def is_set(self) -> bool:
            return self.stopped

        async def wait(self) -> None:
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise TimeoutError("controlled idle poll timeout")
            self.stopped = True

    imports = NoWork()
    stop = TimeoutThenStop()
    runner = WorkerRunner(imports=imports, worker_id="idle-worker", poll_interval=0.01)

    asyncio.run(runner.run_forever(stop))

    assert imports.calls == ["idle-worker", "idle-worker"]
    assert stop.wait_calls == 2


def test_worker_forever_yields_after_handled_work_and_observes_stop() -> None:
    stop = asyncio.Event()

    class StopAfterOneWorkItem:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def run_next(self, *, worker_id: str):
            self.calls.append(worker_id)
            stop.set()
            return object()

    imports = StopAfterOneWorkItem()
    runner = WorkerRunner(imports=imports, worker_id="finite-worker", poll_interval=0.01)

    asyncio.run(runner.run_forever(stop))

    assert imports.calls == ["finite-worker"]
    assert stop.is_set()


def test_worker_forever_propagates_errors_without_retry_spin() -> None:
    stop = asyncio.Event()
    runner = WorkerRunner(imports=UnexpectedImportWorker(), poll_interval=0.01)

    with pytest.raises(RuntimeError, match="unexpected worker failure"):
        asyncio.run(runner.run_forever(stop))

    assert not stop.is_set()


def test_worker_handles_only_durably_projected_chat_errors() -> None:
    class NoImports:
        async def run_next(self, *, worker_id: str):
            del worker_id
            return None

    class ProjectedChatFailure(Exception):
        def __init__(self) -> None:
            super().__init__("safe projected chat failure")
            self.run_id = "chat-run-1"
            self.error = object()

    class FailingChat:
        def __init__(self, error: Exception) -> None:
            self.error = error
            self.calls: list[str] = []

        async def run_next(self, *, worker_id: str):
            self.calls.append(worker_id)
            raise self.error

    projected = FailingChat(ProjectedChatFailure())
    projected_runner = WorkerRunner(
        imports=NoImports(),
        chat=projected,
        worker_id="chat-worker",
    )
    assert asyncio.run(projected_runner.run_once()) is True
    assert projected.calls == ["chat-worker"]

    unexpected = FailingChat(RuntimeError("unexpected chat worker failure"))
    unexpected_runner = WorkerRunner(imports=NoImports(), chat=unexpected)
    with pytest.raises(RuntimeError, match="unexpected chat worker failure"):
        asyncio.run(unexpected_runner.run_once())


@pytest.mark.parametrize("worker_id", ("", "   ", "x" * 513))
def test_worker_rejects_invalid_worker_ids(worker_id: str) -> None:
    with pytest.raises(ValueError, match="Worker ID"):
        WorkerRunner(imports=OneChatRun(), worker_id=worker_id)


@pytest.mark.parametrize(
    "poll_interval",
    (0.0, 0.0009, 60.001, float("inf"), float("nan")),
)
def test_worker_rejects_invalid_poll_intervals(poll_interval: float) -> None:
    with pytest.raises(ValueError, match="poll interval"):
        WorkerRunner(imports=OneChatRun(), poll_interval=poll_interval)

    runner = WorkerRunner(imports=OneChatRun(), poll_interval=0.01)
    with pytest.raises(ValueError, match="poll interval"):
        asyncio.run(runner.run_forever(asyncio.Event(), poll_interval=poll_interval))
