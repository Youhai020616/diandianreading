"""Real browser-backed Z-Library session lifecycle."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, utc_now
from diandianreading.infrastructure.acquisition.zlibrary.browser import ZLibraryBrowserPort
from diandianreading.infrastructure.acquisition.zlibrary.config import ZLibraryAdapterConfig
from diandianreading.infrastructure.acquisition.zlibrary.credentials import (
    ZLibraryCredentialResolver,
)
from diandianreading.infrastructure.acquisition.zlibrary.network import ZLibraryNetworkPolicy
from diandianreading.infrastructure.acquisition.zlibrary.selectors import (
    ZLIBRARY_SELECTORS_V1,
    ZLibrarySelectorSet,
)


class ZLibrarySessionState(StrEnum):
    CONNECTED = "connected"
    EXPIRED = "expired"
    MISSING = "missing"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class ZLibrarySessionStatus:
    provider: str
    profile: str
    state: ZLibrarySessionState
    selector_version: str
    checked_at: datetime


class ZLibrarySessionManager:
    """Treat the persistent browser profile—not file existence—as authentication truth."""

    provider = "zlibrary"

    def __init__(
        self,
        *,
        resolver: ZLibraryCredentialResolver,
        browser: ZLibraryBrowserPort,
        network_policy: ZLibraryNetworkPolicy,
        config: ZLibraryAdapterConfig,
        selectors: ZLibrarySelectorSet = ZLIBRARY_SELECTORS_V1,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._resolver = resolver
        self._browser = browser
        self._network_policy = network_policy
        self._config = config
        self._selectors = selectors
        self._clock = clock

    async def login(self, credential: CredentialRef) -> ZLibrarySessionStatus:
        self._validate_credential(credential)
        _ = self._network_policy.authorize(self._config.base_url)
        paths = self._resolver.prepare_profile(credential)
        try:
            authenticated = await self._browser.login(
                browser_profile=paths.browser_profile,
                storage_state=paths.storage_state,
                entry_url=self._config.base_url,
                network_policy=self._network_policy,
                selectors=self._selectors,
                timeout_seconds=self._config.browser_action_timeout_seconds,
            )
        finally:
            self._resolver.secure_profile_tree(paths)
        if not authenticated:
            raise _auth_required("Z-Library login was not confirmed by the authenticated page")
        _ = self._resolver.resolve_existing_profile(credential)
        return self._status(credential, ZLibrarySessionState.CONNECTED)

    async def status(self, credential: CredentialRef) -> ZLibrarySessionStatus:
        self._validate_credential(credential)
        if not self._resolver.profile_exists(credential):
            return self._status(credential, ZLibrarySessionState.MISSING)
        try:
            paths = self._resolver.resolve_existing_profile(credential)
            _ = self._network_policy.authorize(self._config.base_url)
            try:
                authenticated = await self._browser.is_authenticated(
                    browser_profile=paths.browser_profile,
                    entry_url=self._config.base_url,
                    network_policy=self._network_policy,
                    selectors=self._selectors,
                    timeout_seconds=self._config.browser_action_timeout_seconds,
                )
            finally:
                self._resolver.secure_profile_tree(paths)
        except DiandianError as exc:
            if exc.code is ErrorCode.AUTH_REQUIRED:
                return self._status(credential, ZLibrarySessionState.EXPIRED)
            return self._status(credential, ZLibrarySessionState.ERROR)
        except OSError:
            return self._status(credential, ZLibrarySessionState.ERROR)
        return self._status(
            credential,
            ZLibrarySessionState.CONNECTED if authenticated else ZLibrarySessionState.EXPIRED,
        )

    async def require_authenticated(self, credential: CredentialRef) -> None:
        status = await self.status(credential)
        if status.state in {ZLibrarySessionState.MISSING, ZLibrarySessionState.EXPIRED}:
            raise _auth_required("Z-Library profile is missing or expired")
        if status.state is ZLibrarySessionState.ERROR:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library session health check failed",
                retryable=True,
            )

    def logout(self, credential: CredentialRef) -> bool:
        self._validate_credential(credential)
        return self._resolver.delete_profile(credential)

    def _status(
        self,
        credential: CredentialRef,
        state: ZLibrarySessionState,
    ) -> ZLibrarySessionStatus:
        return ZLibrarySessionStatus(
            provider=self.provider,
            profile=credential.profile,
            state=state,
            selector_version=self._selectors.version,
            checked_at=self._clock(),
        )

    @classmethod
    def _validate_credential(cls, credential: CredentialRef) -> None:
        if credential.provider != cls.provider:
            raise ValueError("Z-Library Session Manager requires a Z-Library credential reference")


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
