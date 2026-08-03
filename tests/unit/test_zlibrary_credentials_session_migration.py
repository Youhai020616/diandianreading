from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path

import pytest

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition.zlibrary import (
    ZLibraryAdapterConfig,
    ZLibraryCredentialResolver,
    ZLibraryLegacyProfileMigrator,
    ZLibraryNetworkPolicy,
    ZLibrarySessionManager,
    ZLibrarySessionState,
)
from tests.support import FIXED_NOW


class StaticResolver:
    def resolve(self, host: str, port: int):
        assert host == "zlibrary.invalid"
        assert port == 443
        return ("8.8.8.8",)


class FakeBrowser:
    def __init__(self, *, authenticated: bool = True) -> None:
        self.authenticated = authenticated
        self.login_calls = 0
        self.health_calls = 0
        self.health_error: BaseException | None = None

    async def login(
        self,
        *,
        browser_profile,
        storage_state,
        entry_url,
        network_policy,
        selectors,
        timeout_seconds,
    ) -> bool:
        del entry_url, network_policy, selectors, timeout_seconds
        self.login_calls += 1
        marker = browser_profile / "session.bin"
        marker.write_bytes(b"private browser state")
        storage_state.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
        return self.authenticated

    async def is_authenticated(
        self,
        *,
        browser_profile,
        entry_url,
        network_policy,
        selectors,
        timeout_seconds,
    ) -> bool:
        del entry_url, network_policy, selectors, timeout_seconds
        self.health_calls += 1
        assert browser_profile.is_dir()
        if self.health_error is not None:
            raise self.health_error
        return self.authenticated

    async def capture_download(self, **kwargs):
        del kwargs
        raise AssertionError("not used by credential/session tests")


def make_config() -> ZLibraryAdapterConfig:
    return ZLibraryAdapterConfig(
        base_url="https://zlibrary.invalid/",
        allowed_hosts=frozenset({"zlibrary.invalid"}),
    )


def make_manager(tmp_path, browser: FakeBrowser):
    resolver = ZLibraryCredentialResolver(tmp_path / "credentials")
    policy = ZLibraryNetworkPolicy(frozenset({"zlibrary.invalid"}), StaticResolver())
    manager = ZLibrarySessionManager(
        resolver=resolver,
        browser=browser,
        network_policy=policy,
        config=make_config(),
        clock=lambda: FIXED_NOW,
    )
    return resolver, policy, manager


def test_resolver_hashes_profile_and_keeps_provider_roots_physically_isolated(tmp_path) -> None:
    resolver = ZLibraryCredentialResolver(tmp_path / "credentials")
    credential = CredentialRef("zlibrary", "personal account")
    paths = resolver.prepare_profile(credential)
    notebooklm_sentinel = tmp_path / "credentials" / "notebooklm" / "sentinel"
    notebooklm_sentinel.parent.mkdir(mode=0o700)
    notebooklm_sentinel.write_text("untouched", encoding="utf-8")

    assert credential.profile not in str(paths.profile_directory)
    assert paths.profile_directory.name.startswith("profile-")
    assert paths.browser_profile.parent == paths.profile_directory
    assert resolver.profile_exists(credential)
    assert resolver.delete_profile(credential) is True
    assert resolver.delete_profile(credential) is False
    assert notebooklm_sentinel.read_text(encoding="utf-8") == "untouched"


def test_session_status_uses_real_browser_marker_not_storage_file_existence(tmp_path) -> None:
    browser = FakeBrowser(authenticated=False)
    resolver, _policy, manager = make_manager(tmp_path, browser)
    credential = CredentialRef("zlibrary", "test")

    missing = asyncio.run(manager.status(credential))
    assert missing.state is ZLibrarySessionState.MISSING

    with pytest.raises(DiandianError) as failed_login:
        asyncio.run(manager.login(credential))
    assert failed_login.value.code is ErrorCode.AUTH_REQUIRED
    assert resolver.resolve_existing_profile(credential).storage_state.exists()

    expired = asyncio.run(manager.status(credential))
    assert expired.state is ZLibrarySessionState.EXPIRED
    assert browser.health_calls == 1

    browser.authenticated = True
    connected = asyncio.run(manager.status(credential))
    assert connected.state is ZLibrarySessionState.CONNECTED
    assert connected.profile == "test"
    assert connected.checked_at == FIXED_NOW
    assert str(tmp_path) not in repr(connected)


def test_session_maps_health_failures_and_requires_matching_provider(tmp_path) -> None:
    browser = FakeBrowser(authenticated=True)
    _resolver, _policy, manager = make_manager(tmp_path, browser)
    credential = CredentialRef("zlibrary", "test")
    asyncio.run(manager.login(credential))

    browser.health_error = DiandianError(
        ErrorCode.AUTH_REQUIRED,
        "synthetic expired",
        retryable=False,
    )
    assert asyncio.run(manager.status(credential)).state is ZLibrarySessionState.EXPIRED
    browser.health_error = DiandianError(
        ErrorCode.REMOTE_PROTOCOL_DRIFT,
        "synthetic drift",
        retryable=False,
    )
    assert asyncio.run(manager.status(credential)).state is ZLibrarySessionState.ERROR
    browser.health_error = OSError("synthetic local failure")
    assert asyncio.run(manager.status(credential)).state is ZLibrarySessionState.ERROR
    with pytest.raises(DiandianError) as unavailable:
        asyncio.run(manager.require_authenticated(credential))
    assert unavailable.value.code is ErrorCode.SOURCE_UNAVAILABLE
    browser.health_error = None
    browser.authenticated = False
    with pytest.raises(DiandianError) as required:
        asyncio.run(manager.require_authenticated(credential))
    assert required.value.code is ErrorCode.AUTH_REQUIRED

    with pytest.raises(ValueError, match="requires a Z-Library"):
        asyncio.run(manager.status(CredentialRef("other", "test")))


def test_successful_login_secures_snapshot_and_logout_only_removes_zlibrary_profile(
    tmp_path,
) -> None:
    browser = FakeBrowser(authenticated=True)
    resolver, _policy, manager = make_manager(tmp_path, browser)
    credential = CredentialRef("zlibrary", "test")
    other = tmp_path / "credentials" / "notebooklm" / "profile"
    other.mkdir(parents=True, mode=0o700)

    status = asyncio.run(manager.login(credential))
    paths = resolver.resolve_existing_profile(credential)

    assert status.state is ZLibrarySessionState.CONNECTED
    assert browser.login_calls == 1
    if os.name != "nt":
        assert stat.S_IMODE(paths.profile_directory.stat().st_mode) == 0o700
        assert stat.S_IMODE(paths.storage_state.stat().st_mode) == 0o600
        assert stat.S_IMODE((paths.browser_profile / "session.bin").stat().st_mode) == 0o600
    assert manager.logout(credential) is True
    assert other.is_dir()


def test_resolver_validates_optional_storage_snapshot_and_migration_staging(tmp_path) -> None:
    resolver = ZLibraryCredentialResolver(tmp_path / "credentials")
    credential = CredentialRef("zlibrary", "test")
    paths = resolver.prepare_profile(credential)
    paths.storage_state.write_text("not-json", encoding="utf-8")
    if os.name != "nt":
        paths.storage_state.chmod(0o600)
    with pytest.raises(DiandianError) as invalid:
        resolver.resolve_existing_profile(credential)
    assert invalid.value.code is ErrorCode.AUTH_REQUIRED

    paths.storage_state.write_text(json.dumps({"origins": []}), encoding="utf-8")
    with pytest.raises(DiandianError):
        resolver.resolve_existing_profile(credential)

    staged = resolver.create_migration_staging()
    (staged.browser_profile / "state.bin").write_bytes(b"state")
    resolver.secure_profile_tree(staged)
    resolver.discard_migration_staging(staged)
    assert not staged.profile_directory.exists()


def test_resolver_rejects_wrong_provider_symlinks_and_broad_permissions(tmp_path) -> None:
    resolver = ZLibraryCredentialResolver(tmp_path / "credentials")
    with pytest.raises(ValueError, match="cannot use provider"):
        resolver.prepare_profile(CredentialRef("other", "test"))

    credential = CredentialRef("zlibrary", "test")
    paths = resolver.prepare_profile(credential)
    if os.name != "nt":
        paths.browser_profile.chmod(0o755)
        with pytest.raises(UnsafePathError, match="permissions"):
            resolver.resolve_existing_profile(credential)
        paths.browser_profile.chmod(0o700)

    if hasattr(os, "symlink"):
        link = paths.browser_profile / "unsafe-link"
        link.symlink_to(tmp_path)
        with pytest.raises(UnsafePathError, match="symbolic links"):
            resolver.validate_profile_tree(paths)


def prepare_legacy_root(tmp_path: Path) -> Path:
    root = tmp_path / "legacy"
    browser = root / "browser_profile"
    browser.mkdir(parents=True, mode=0o700)
    (browser / "session.bin").write_bytes(b"legacy session")
    (root / "storage_state.json").write_text(
        json.dumps({"cookies": [], "origins": []}),
        encoding="utf-8",
    )
    (root / "config.json").write_text(
        json.dumps({"email": "private@example.invalid", "password": "secret-password"}),
        encoding="utf-8",
    )
    if os.name != "nt":
        root.chmod(0o700)
        browser.chmod(0o700)
        (browser / "session.bin").chmod(0o600)
        (root / "storage_state.json").chmod(0o600)
        (root / "config.json").chmod(0o600)
    return root


def make_migrator(tmp_path, browser: FakeBrowser):
    resolver, policy, _manager = make_manager(tmp_path, browser)
    legacy_root = prepare_legacy_root(tmp_path)
    migrator = ZLibraryLegacyProfileMigrator(
        legacy_root=legacy_root,
        resolver=resolver,
        browser=browser,
        network_policy=policy,
        config=make_config(),
    )
    return legacy_root, resolver, migrator


def test_legacy_inspection_handles_missing_root_and_requires_browser_profile(tmp_path) -> None:
    browser = FakeBrowser()
    resolver, policy, _manager = make_manager(tmp_path, browser)
    missing = ZLibraryLegacyProfileMigrator(
        legacy_root=tmp_path / "missing-legacy",
        resolver=resolver,
        browser=browser,
        network_policy=policy,
        config=make_config(),
    )
    assert missing.inspect().warnings == ()
    with pytest.raises(DiandianError) as absent:
        asyncio.run(
            missing.migrate(
                CredentialRef("zlibrary", "missing"),
                confirmed=True,
                dry_run=False,
            )
        )
    assert absent.value.code is ErrorCode.AUTH_REQUIRED

    root = tmp_path / "config-only"
    root.mkdir(mode=0o700)
    config = root / "config.json"
    config.write_text("{}", encoding="utf-8")
    if os.name != "nt":
        config.chmod(0o600)
    inspection = ZLibraryLegacyProfileMigrator(
        legacy_root=root,
        resolver=resolver,
        browser=browser,
        network_policy=policy,
        config=make_config(),
    ).inspect()
    assert inspection.plaintext_config_detected is True
    assert any("No legacy browser" in warning for warning in inspection.warnings)


def test_legacy_migration_dry_run_detects_but_never_opens_plaintext_config(
    tmp_path, monkeypatch
) -> None:
    browser = FakeBrowser()
    legacy_root, resolver, migrator = make_migrator(tmp_path, browser)
    config_path = legacy_root / "config.json"
    original_os_open = os.open

    def guarded_open(path, *args, **kwargs):
        if Path(path) == config_path:
            raise AssertionError("legacy config.json must never be opened")
        return original_os_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", guarded_open)
    inspection = migrator.inspect()
    result = asyncio.run(
        migrator.migrate(
            CredentialRef("zlibrary", "migrated"),
            confirmed=False,
            dry_run=True,
        )
    )

    assert inspection.plaintext_config_detected is True
    assert any("will not be read" in warning for warning in inspection.warnings)
    assert result.dry_run is True
    assert result.source_retained is True
    assert browser.health_calls == 0
    assert resolver.profile_exists(CredentialRef("zlibrary", "migrated")) is False
    with pytest.raises(DiandianError, match="explicit confirmation"):
        asyncio.run(
            migrator.migrate(
                CredentialRef("zlibrary", "migrated"),
                confirmed=False,
                dry_run=False,
            )
        )


def test_confirmed_legacy_migration_validates_then_atomically_publishes_and_retains_source(
    tmp_path,
) -> None:
    browser = FakeBrowser(authenticated=True)
    legacy_root, resolver, migrator = make_migrator(tmp_path, browser)
    credential = CredentialRef("zlibrary", "migrated")

    result = asyncio.run(migrator.migrate(credential, confirmed=True, dry_run=False))

    assert result.migrated is True
    assert result.session_validated is True
    assert result.source_retained is True
    assert browser.health_calls == 1
    assert resolver.resolve_existing_profile(credential).browser_profile.is_dir()
    assert (legacy_root / "browser_profile" / "session.bin").read_bytes() == b"legacy session"
    assert (legacy_root / "config.json").exists()
    with pytest.raises(FileExistsError, match="already exists"):
        asyncio.run(migrator.migrate(credential, confirmed=True, dry_run=False))


def test_failed_legacy_validation_does_not_publish_or_modify_source(tmp_path) -> None:
    browser = FakeBrowser(authenticated=False)
    legacy_root, resolver, migrator = make_migrator(tmp_path, browser)
    credential = CredentialRef("zlibrary", "rejected")

    with pytest.raises(DiandianError) as raised:
        asyncio.run(migrator.migrate(credential, confirmed=True, dry_run=False))

    assert raised.value.code is ErrorCode.AUTH_REQUIRED
    assert resolver.profile_exists(credential) is False
    assert (legacy_root / "browser_profile" / "session.bin").read_bytes() == b"legacy session"


def test_plaintext_config_cleanup_is_separate_confirmed_metadata_only_operation(
    tmp_path, monkeypatch
) -> None:
    browser = FakeBrowser()
    legacy_root, _resolver, migrator = make_migrator(tmp_path, browser)
    config_path = legacy_root / "config.json"
    original_os_open = os.open

    def guarded_open(path, *args, **kwargs):
        if Path(path) == config_path:
            raise AssertionError("cleanup must not read legacy config.json")
        return original_os_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", guarded_open)
    with pytest.raises(DiandianError, match="separate confirmation"):
        migrator.cleanup_plaintext_config(confirmed=False)
    assert migrator.cleanup_plaintext_config(confirmed=True) is True
    assert migrator.cleanup_plaintext_config(confirmed=True) is False


def test_plaintext_config_cleanup_rejects_symlink(tmp_path) -> None:
    browser = FakeBrowser()
    legacy_root, _resolver, migrator = make_migrator(tmp_path, browser)
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")
    config = legacy_root / "config.json"
    config.unlink()
    config.symlink_to(tmp_path / "outside-config")
    with pytest.raises(UnsafePathError, match="non-symlink"):
        migrator.cleanup_plaintext_config(confirmed=True)


def test_legacy_migration_rejects_insecure_or_symlinked_source(tmp_path) -> None:
    browser = FakeBrowser()
    legacy_root, _resolver, migrator = make_migrator(tmp_path, browser)
    session_file = legacy_root / "browser_profile" / "session.bin"
    if os.name != "nt":
        session_file.chmod(0o644)
        with pytest.raises(UnsafePathError, match="permissions"):
            asyncio.run(
                migrator.migrate(
                    CredentialRef("zlibrary", "insecure"),
                    confirmed=True,
                    dry_run=False,
                )
            )

    if hasattr(os, "symlink"):
        session_file.unlink()
        session_file.symlink_to(tmp_path / "outside")
        with pytest.raises(UnsafePathError, match="non-symlink"):
            asyncio.run(
                migrator.migrate(
                    CredentialRef("zlibrary", "symlink"),
                    confirmed=True,
                    dry_run=False,
                )
            )
