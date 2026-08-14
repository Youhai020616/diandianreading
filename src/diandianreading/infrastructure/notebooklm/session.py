"""Safe project-owned NotebookLM authentication session lifecycle."""

from __future__ import annotations

import asyncio
import importlib.util
import math
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import ClassVar, Protocol

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, utc_now
from diandianreading.infrastructure.notebooklm.credentials import (
    CredentialPathResolver,
    NotebookLMProfilePaths,
)

_DEFAULT_LOGIN_TIMEOUT_SECONDS = 300.0
_PROCESS_TERMINATION_TIMEOUT_SECONDS = 5.0
_BROWSER_EXTRA_GUIDANCE = (
    "NotebookLM browser support is missing from this tool environment. "
    "Reinstall diandianreading, then run `diandianreading setup notebooklm`."
)


class NotebookLMSessionState(StrEnum):
    CONNECTED = "connected"
    EXPIRED = "expired"
    MISSING = "missing"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class NotebookLMSessionStatus:
    """Credential-free NotebookLM session health for one logical profile."""

    provider: str
    profile: str
    state: NotebookLMSessionState
    checked_at: datetime


class NotebookLMProcessRunner(Protocol):
    """Injectable argv-only asynchronous process boundary used by interactive login."""

    async def __call__(
        self,
        argv: tuple[str, ...],
        environment: Mapping[str, str],
        timeout_seconds: float,
    ) -> int: ...


class NotebookLMPassiveProbe(Protocol):
    """Injectable passive authentication check that must not retain returned tokens."""

    async def __call__(self, storage_path: Path, safe_profile: str) -> None: ...


NotebookLMCacheInvalidator = Callable[[CredentialRef], Awaitable[None]]


class NotebookLMSessionManager:
    """Manage one local NotebookLM profile without exposing credential material."""

    provider: ClassVar[str] = "notebooklm"

    def __init__(
        self,
        *,
        resolver: CredentialPathResolver,
        process_runner: NotebookLMProcessRunner | None = None,
        passive_probe: NotebookLMPassiveProbe | None = None,
        cache_invalidator: NotebookLMCacheInvalidator | None = None,
        browser_extra_available: Callable[[], bool] | None = None,
        login_timeout_seconds: float = _DEFAULT_LOGIN_TIMEOUT_SECONDS,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        if not math.isfinite(login_timeout_seconds) or login_timeout_seconds <= 0:
            raise ValueError("NotebookLM login timeout must be finite and positive")
        self._resolver: CredentialPathResolver = resolver
        self._process_runner: NotebookLMProcessRunner = (
            process_runner if process_runner is not None else _run_notebooklm_process
        )
        self._passive_probe: NotebookLMPassiveProbe = (
            passive_probe if passive_probe is not None else _fetch_tokens_passive
        )
        self._cache_invalidator: NotebookLMCacheInvalidator | None = cache_invalidator
        self._browser_extra_available: Callable[[], bool] = (
            browser_extra_available if browser_extra_available is not None else _has_browser_extra
        )
        self._login_timeout_seconds: float = login_timeout_seconds
        self._clock: Callable[[], datetime] = clock

    async def login(self, credential: CredentialRef) -> NotebookLMSessionStatus:
        """Replace a local profile through the pinned NotebookLM interactive CLI."""

        self._validate_credential(credential)
        if not self._browser_support_is_available():
            raise _validation(_BROWSER_EXTRA_GUIDANCE)

        if self._profile_exists_for_mutation(credential):
            await self._invalidate_cache(credential)
            _ = self._delete_profile(credential)

        paths = self._prepare_profile(credential)
        argv = (
            sys.executable,
            "-m",
            "notebooklm",
            "--quiet",
            "--profile",
            paths.profile_key,
            "--storage",
            str(paths.storage_state),
            "login",
        )
        environment = _sanitized_login_environment(paths.provider_root)

        try:
            return_code = await asyncio.wait_for(
                self._process_runner(
                    argv,
                    environment,
                    self._login_timeout_seconds,
                ),
                timeout=self._login_timeout_seconds,
            )
        except TimeoutError as exc:
            raise _auth_required("NotebookLM interactive login timed out; retry login") from exc
        except Exception as exc:
            raise _validation("NotebookLM interactive login could not be started safely") from exc
        finally:
            self._secure_profile_tree(paths)

        if return_code != 0:
            raise _auth_required("NotebookLM interactive login did not complete; retry login")

        status = await self.status(credential)
        if status.state is NotebookLMSessionState.CONNECTED:
            return status
        if status.state is NotebookLMSessionState.ERROR:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "NotebookLM session verification failed",
                retryable=True,
            )
        raise _auth_required("NotebookLM interactive login did not produce a valid session")

    async def status(self, credential: CredentialRef) -> NotebookLMSessionStatus:
        """Passively map local/session health to a credential-free state."""

        self._validate_credential(credential)
        try:
            if not self._resolver.profile_exists(credential):
                return self._status(credential, NotebookLMSessionState.MISSING)
            paths = self._resolver.profile_paths(credential)
            storage_path = self._resolver.resolve_storage_state(credential)
        except DiandianError as exc:
            state = (
                NotebookLMSessionState.EXPIRED
                if exc.code is ErrorCode.AUTH_REQUIRED
                else NotebookLMSessionState.ERROR
            )
            return self._status(credential, state)
        except OSError:
            return self._status(credential, NotebookLMSessionState.ERROR)

        try:
            await self._passive_probe(storage_path, paths.profile_key)
        except (FileNotFoundError, ValueError):
            return self._status(credential, NotebookLMSessionState.EXPIRED)
        except DiandianError as exc:
            state = (
                NotebookLMSessionState.EXPIRED
                if exc.code is ErrorCode.AUTH_REQUIRED
                else NotebookLMSessionState.ERROR
            )
            return self._status(credential, state)
        except Exception:
            return self._status(credential, NotebookLMSessionState.ERROR)
        return self._status(credential, NotebookLMSessionState.CONNECTED)

    async def require_authenticated(self, credential: CredentialRef) -> None:
        """Raise a sanitized typed error unless the passive probe succeeds."""

        status = await self.status(credential)
        if status.state in {NotebookLMSessionState.MISSING, NotebookLMSessionState.EXPIRED}:
            raise _auth_required("NotebookLM profile is missing or expired")
        if status.state is NotebookLMSessionState.ERROR:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "NotebookLM session health check failed",
                retryable=True,
            )

    async def logout(self, credential: CredentialRef) -> bool:
        """Delete the entire local managed profile; this does not revoke remote sessions."""

        self._validate_credential(credential)
        if not self._profile_exists_for_mutation(credential):
            return False
        await self._invalidate_cache(credential)
        return self._delete_profile(credential)

    def _status(
        self,
        credential: CredentialRef,
        state: NotebookLMSessionState,
    ) -> NotebookLMSessionStatus:
        return NotebookLMSessionStatus(
            provider=self.provider,
            profile=credential.profile,
            state=state,
            checked_at=self._clock(),
        )

    def _profile_exists_for_mutation(self, credential: CredentialRef) -> bool:
        try:
            return self._resolver.profile_exists(credential)
        except DiandianError:
            raise
        except OSError as exc:
            raise _validation("NotebookLM local profile could not be accessed safely") from exc

    def _prepare_profile(self, credential: CredentialRef) -> NotebookLMProfilePaths:
        try:
            return self._resolver.prepare_profile(credential)
        except DiandianError:
            raise
        except OSError as exc:
            raise _validation("NotebookLM local profile could not be prepared safely") from exc

    def _secure_profile_tree(self, paths: NotebookLMProfilePaths) -> None:
        try:
            self._resolver.secure_profile_tree(paths)
        except DiandianError:
            raise
        except OSError as exc:
            raise _validation("NotebookLM local profile could not be secured safely") from exc

    def _delete_profile(self, credential: CredentialRef) -> bool:
        try:
            return self._resolver.delete_profile(credential)
        except DiandianError:
            raise
        except OSError as exc:
            raise _validation("NotebookLM local profile could not be deleted safely") from exc

    def _browser_support_is_available(self) -> bool:
        try:
            return self._browser_extra_available()
        except Exception:
            return False

    async def _invalidate_cache(self, credential: CredentialRef) -> None:
        if self._cache_invalidator is None:
            return
        try:
            await self._cache_invalidator(credential)
        except Exception as exc:
            raise DiandianError(
                ErrorCode.UNEXPECTED,
                "NotebookLM session cache invalidation failed",
                retryable=False,
            ) from exc

    @classmethod
    def _validate_credential(cls, credential: CredentialRef) -> None:
        if credential.provider != cls.provider:
            raise ValueError(
                "NotebookLM session manager requires a NotebookLM credential reference"
            )


async def _fetch_tokens_passive(storage_path: Path, safe_profile: str) -> None:
    from notebooklm.auth import fetch_tokens_passive

    _ = await fetch_tokens_passive(storage_path, safe_profile)


def _has_browser_extra() -> bool:
    try:
        return importlib.util.find_spec("playwright") is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _sanitized_login_environment(provider_root: Path) -> dict[str, str]:
    environment = {
        name: value
        for name, value in os.environ.items()
        if name.upper() != "PYTHONPATH"
        and not name.upper().startswith(("NOTEBOOKLM_", "_NOTEBOOKLM_"))
    }
    environment["NOTEBOOKLM_HOME"] = str(provider_root)
    return environment


async def _run_notebooklm_process(
    argv: tuple[str, ...],
    environment: Mapping[str, str],
    timeout_seconds: float,
) -> int:
    process = await asyncio.create_subprocess_exec(
        *argv,
        env=dict(environment),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        return await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
    except TimeoutError:
        await _terminate_process(process)
        raise
    except asyncio.CancelledError:
        await _terminate_process(process)
        raise


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        _ = await asyncio.wait_for(
            process.wait(),
            timeout=_PROCESS_TERMINATION_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            return
        _ = await process.wait()


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.VALIDATION, message, retryable=False)


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
