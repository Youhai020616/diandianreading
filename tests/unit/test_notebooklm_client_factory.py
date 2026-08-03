from __future__ import annotations

import asyncio

import pytest

from diandianreading.infrastructure.notebooklm import NotebookLMClientFactory
from diandianreading.infrastructure.notebooklm import client as client_module


class RecordingContext:
    def __init__(self, value: object) -> None:
        self.value = value
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> object:
        self.entered = True
        return self.value

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        del exc_type, exc_value, traceback
        self.exited = True


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": 0},
        {"chat_timeout": 0},
        {"rate_limit_max_retries": -1},
        {"server_error_max_retries": -1},
        {"max_concurrent_uploads": 0},
        {"max_concurrent_rpcs": 0},
    ],
)
def test_client_factory_rejects_unbounded_or_invalid_resource_settings(kwargs) -> None:
    with pytest.raises(ValueError):
        NotebookLMClientFactory(**kwargs)


def test_client_factory_uses_canonical_public_context_and_explicit_storage_path(
    tmp_path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}
    marker = object()
    context = RecordingContext(marker)

    def from_storage(**kwargs):
        captured.update(kwargs)
        return context

    monkeypatch.setattr(
        client_module.NotebookLMClient,
        "from_storage",
        staticmethod(from_storage),
    )
    factory = NotebookLMClientFactory(
        timeout=12,
        chat_timeout=34,
        rate_limit_max_retries=1,
        server_error_max_retries=2,
        max_concurrent_uploads=3,
        max_concurrent_rpcs=4,
    )
    storage_path = tmp_path / "storage_state.json"

    async def scenario() -> None:
        async with factory.open(storage_path) as client:
            assert client is marker
            assert context.entered
            assert not context.exited

    asyncio.run(scenario())

    assert context.exited
    assert captured == {
        "path": str(storage_path),
        "timeout": 12,
        "chat_timeout": 34,
        "rate_limit_max_retries": 1,
        "server_error_max_retries": 2,
        "max_concurrent_uploads": 3,
        "max_concurrent_rpcs": 4,
    }
