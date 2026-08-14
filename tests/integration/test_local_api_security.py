from __future__ import annotations

import hashlib
import hmac
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

from diandianreading.infrastructure.local_api import (
    BootstrapAuthenticationError,
    BrowserSessionCredentials,
    CsrfValidationError,
    InstallTokenSecret,
    InstallTokenStore,
    InstallTokenStoreError,
    LocalApiSecurityCapacityError,
    LocalApiSecurityConfig,
    LocalApiSecurityConfigurationError,
    LocalApiSecurityService,
    SessionAuthenticationError,
)
from diandianreading.infrastructure.persistence import SQLiteDatabase

FIXED_NOW = datetime(2026, 8, 3, 12, 0, tzinfo=UTC)


def fetch_one(
    connection: sqlite3.Connection,
    statement: str,
    parameters: tuple[object, ...] = (),
) -> sqlite3.Row:
    row = cast(sqlite3.Row | None, connection.execute(statement, parameters).fetchone())
    assert row is not None
    return row


@dataclass(slots=True)
class MutableClock:
    value: datetime = FIXED_NOW

    def __call__(self) -> datetime:
        return self.value

    def advance(self, duration: timedelta) -> None:
        self.value += duration


def make_security(
    tmp_path: Path,
    *,
    config: LocalApiSecurityConfig | None = None,
) -> tuple[
    SQLiteDatabase,
    InstallTokenStore,
    InstallTokenSecret,
    MutableClock,
    LocalApiSecurityService,
]:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    assert database.migrate() >= 6
    store = InstallTokenStore(tmp_path / "credentials" / "local-api")
    install_token = store.ensure_initial()
    clock = MutableClock()
    service = LocalApiSecurityService(database, store, config=config, clock=clock)
    return database, store, install_token, clock, service


def issue_session(service: LocalApiSecurityService) -> BrowserSessionCredentials:
    bootstrap = service.issue_bootstrap()
    return service.consume_bootstrap(bootstrap.nonce)


def test_database_persists_only_domain_separated_digests(tmp_path: Path) -> None:
    database, _, install_token, _, service = make_security(tmp_path)

    bootstrap = service.issue_bootstrap(timedelta(seconds=30))
    with database.connect() as connection:
        nonce_row = fetch_one(
            connection,
            "SELECT nonce_digest, install_token_generation FROM browser_bootstrap_nonces",
        )
    nonce_digest = cast(str, nonce_row[0])
    assert nonce_digest != bootstrap.nonce
    assert nonce_digest != hashlib.sha256(bootstrap.nonce.encode()).hexdigest()
    assert len(nonce_digest) == 64

    credentials = service.consume_bootstrap(bootstrap.nonce)
    with database.connect() as connection:
        session_row = fetch_one(
            connection,
            """
            SELECT session_token_digest, csrf_token_digest, install_token_generation
            FROM browser_sessions
            """,
        )
        nonce_row = fetch_one(
            connection,
            "SELECT nonce_digest, consumed_at FROM browser_bootstrap_nonces",
        )
    nonce_digest = cast(str, nonce_row[0])
    session_digest = cast(str, session_row[0])
    csrf_digest = cast(str, session_row[1])
    assert nonce_row[1] is not None
    assert len(session_digest) == 64
    assert len(csrf_digest) == 64
    assert session_digest != hashlib.sha256(credentials.session_token.encode()).hexdigest()
    assert csrf_digest != hashlib.sha256(credentials.csrf_token.encode()).hexdigest()
    assert len({nonce_digest, session_digest, csrf_digest}) == 3

    database_bytes = database.path.read_bytes()
    for raw_secret in (
        install_token.token,
        bootstrap.nonce,
        credentials.session_token,
        credentials.csrf_token,
    ):
        assert raw_secret.encode() not in database_bytes
        assert raw_secret not in repr(bootstrap)
        assert raw_secret not in repr(credentials)


def test_bootstrap_is_one_time_expiring_generation_bound_and_uniform(tmp_path: Path) -> None:
    _, store, _, clock, service = make_security(tmp_path)
    issued = service.issue_bootstrap(timedelta(seconds=2))

    with pytest.raises(BootstrapAuthenticationError) as wrong:
        _ = service.consume_bootstrap("wrong-bootstrap-value")
    credentials = service.consume_bootstrap(issued.nonce)
    with pytest.raises(BootstrapAuthenticationError) as replayed:
        _ = service.consume_bootstrap(issued.nonce)
    assert str(wrong.value) == str(replayed.value)
    assert issued.nonce not in str(replayed.value)
    assert credentials.session_token not in str(replayed.value)

    expired = service.issue_bootstrap(timedelta(seconds=1))
    clock.advance(timedelta(seconds=1))
    with pytest.raises(BootstrapAuthenticationError) as expiry_error:
        _ = service.consume_bootstrap(expired.nonce)
    assert str(expiry_error.value) == str(wrong.value)

    old_generation = service.issue_bootstrap()
    rotated = store.rotate()
    with pytest.raises(BootstrapAuthenticationError) as generation_error:
        _ = service.consume_bootstrap(old_generation.nonce)
    assert str(generation_error.value) == str(wrong.value)

    current = service.issue_bootstrap()
    assert current.install_token_generation == rotated.generation
    _ = service.consume_bootstrap(current.nonce)


def test_missing_install_token_recovery_revokes_all_browser_credentials(tmp_path: Path) -> None:
    database, store, original, clock, service = make_security(tmp_path)
    pending = service.issue_bootstrap()
    credentials = issue_session(service)
    session = service.authenticate_session(credentials.session_token)
    assert service.is_session_active(session)

    store.path.unlink()
    replacement_store = InstallTokenStore(store.path.parent)
    replacement = replacement_store.ensure_initial()
    recovered = LocalApiSecurityService(database, replacement_store, clock=clock)
    recovered.recover_after_install_token_loss()

    assert replacement.token != original.token
    with pytest.raises(BootstrapAuthenticationError):
        _ = recovered.consume_bootstrap(pending.nonce)
    with pytest.raises(SessionAuthenticationError):
        _ = recovered.authenticate_session(credentials.session_token)
    with database.connect() as connection:
        revoked = fetch_one(
            connection,
            "SELECT revoked_at, revoked_reason FROM browser_sessions",
        )
    assert revoked[0] is not None
    assert revoked[1] == "security_recovery"


def test_session_idle_absolute_revoke_and_csrf_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = LocalApiSecurityConfig(
        bootstrap_ttl=timedelta(seconds=30),
        idle_ttl=timedelta(seconds=10),
        absolute_ttl=timedelta(seconds=25),
    )
    database, _, _, clock, service = make_security(tmp_path, config=config)

    idle_credentials = issue_session(service)
    clock.advance(timedelta(seconds=10))
    with pytest.raises(SessionAuthenticationError):
        _ = service.authenticate_session(idle_credentials.session_token)

    absolute_credentials = issue_session(service)
    clock.advance(timedelta(seconds=9))
    first_refresh = service.authenticate_session(absolute_credentials.session_token)
    assert first_refresh.idle_expires_at == clock.value + timedelta(seconds=10)
    clock.advance(timedelta(seconds=9))
    second_refresh = service.authenticate_session(absolute_credentials.session_token)
    assert second_refresh.idle_expires_at == absolute_credentials.absolute_expires_at
    clock.advance(timedelta(seconds=7))
    with pytest.raises(SessionAuthenticationError):
        _ = service.authenticate_session(absolute_credentials.session_token)

    csrf_credentials = issue_session(service)
    session = service.authenticate_session(csrf_credentials.session_token)
    service.validate_csrf(session, csrf_credentials.csrf_token, csrf_credentials.csrf_token)

    original_compare = hmac.compare_digest
    comparisons: list[tuple[object, object]] = []

    def recording_compare(left: object, right: object) -> bool:
        comparisons.append((left, right))
        if isinstance(left, bytes) and isinstance(right, bytes):
            return original_compare(left, right)
        if isinstance(left, str) and isinstance(right, str):
            return original_compare(left, right)
        return False

    monkeypatch.setattr(hmac, "compare_digest", recording_compare)
    with pytest.raises(CsrfValidationError) as csrf_mismatch:
        service.validate_csrf(session, "wrong", "wrong")
    assert len(comparisons) == 2
    comparisons.clear()
    with pytest.raises(CsrfValidationError) as csrf_double_submit_mismatch:
        service.validate_csrf(session, csrf_credentials.csrf_token, "different")
    assert len(comparisons) == 2
    assert str(csrf_mismatch.value) == str(csrf_double_submit_mismatch.value)
    assert csrf_credentials.csrf_token not in str(csrf_double_submit_mismatch.value)

    assert service.revoke_session(session)
    assert not service.revoke_session(session)
    assert not service.is_session_active(session)
    with pytest.raises(SessionAuthenticationError):
        _ = service.authenticate_session(csrf_credentials.session_token)
    with database.connect() as connection:
        revoked = fetch_one(
            connection,
            "SELECT revoked_at, revoked_reason FROM browser_sessions WHERE id = ?",
            (session.session_id,),
        )
    assert revoked[0] is not None
    assert revoked[1] == "logout"


def test_sse_active_recheck_does_not_extend_idle_and_rotation_invalidates(
    tmp_path: Path,
) -> None:
    config = LocalApiSecurityConfig(
        idle_ttl=timedelta(seconds=5),
        absolute_ttl=timedelta(seconds=30),
    )
    database, store, _, clock, service = make_security(tmp_path, config=config)
    credentials = issue_session(service)
    session = service.authenticate_session(credentials.session_token)

    with database.connect() as connection:
        before = fetch_one(
            connection,
            "SELECT last_seen_at, idle_expires_at, version FROM browser_sessions WHERE id = ?",
            (session.session_id,),
        )
    clock.advance(timedelta(seconds=4))
    assert service.is_session_active(session)
    assert service.is_session_active(session)
    with database.connect() as connection:
        after = fetch_one(
            connection,
            "SELECT last_seen_at, idle_expires_at, version FROM browser_sessions WHERE id = ?",
            (session.session_id,),
        )
    assert after == before

    clock.advance(timedelta(seconds=1))
    assert not service.is_session_active(session)

    current_credentials = issue_session(service)
    current_session = service.authenticate_session(current_credentials.session_token)
    assert service.is_session_active(current_session)
    _ = store.rotate()
    assert not service.is_session_active(current_session)
    with pytest.raises(SessionAuthenticationError):
        _ = service.authenticate_session(current_credentials.session_token)


def test_sse_active_recheck_fails_closed_when_token_state_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, store, _, _, service = make_security(tmp_path)
    credentials = issue_session(service)
    session = service.authenticate_session(credentials.session_token)

    def unavailable_generation() -> int:
        raise InstallTokenStoreError

    monkeypatch.setattr(store, "current_generation", unavailable_generation)
    assert not service.is_session_active(session)


def test_cleanup_observes_retention_and_per_table_limit(tmp_path: Path) -> None:
    config = LocalApiSecurityConfig(
        bootstrap_ttl=timedelta(seconds=1),
        idle_ttl=timedelta(seconds=1),
        absolute_ttl=timedelta(seconds=2),
        nonce_retention=timedelta(seconds=1),
        session_retention=timedelta(seconds=1),
        max_nonce_rows=10,
        max_session_rows=10,
        cleanup_limit=1,
    )
    database, _, _, clock, service = make_security(tmp_path, config=config)

    revoked_credentials = issue_session(service)
    revoked_session = service.authenticate_session(revoked_credentials.session_token)
    assert service.revoke_session(revoked_session)
    _ = issue_session(service)
    _ = service.issue_bootstrap()

    clock.advance(timedelta(milliseconds=500))
    retained = service.cleanup()
    assert retained.bootstrap_nonces_deleted == 0
    assert retained.browser_sessions_deleted == 0

    clock.advance(timedelta(seconds=2))
    results = [service.cleanup(), service.cleanup(), service.cleanup()]
    assert all(result.bootstrap_nonces_deleted <= 1 for result in results)
    assert all(result.browser_sessions_deleted <= 1 for result in results)
    assert sum(result.bootstrap_nonces_deleted for result in results) == 3
    assert sum(result.browser_sessions_deleted for result in results) == 2

    with database.connect() as connection:
        nonce_count = cast(
            int,
            fetch_one(connection, "SELECT COUNT(*) FROM browser_bootstrap_nonces")[0],
        )
        session_count = cast(
            int,
            fetch_one(connection, "SELECT COUNT(*) FROM browser_sessions")[0],
        )
    assert nonce_count == 0
    assert session_count == 0
    with pytest.raises(LocalApiSecurityConfigurationError):
        _ = service.cleanup(limit=2)


def test_row_caps_fail_closed_and_failed_session_insert_does_not_consume_nonce(
    tmp_path: Path,
) -> None:
    config = LocalApiSecurityConfig(
        nonce_retention=timedelta(days=1),
        session_retention=timedelta(days=1),
        max_nonce_rows=1,
        max_session_rows=1,
        cleanup_limit=1,
    )
    database, _, _, _, service = make_security(tmp_path, config=config)

    first = service.issue_bootstrap()
    with pytest.raises(LocalApiSecurityCapacityError):
        _ = service.issue_bootstrap()
    _ = service.consume_bootstrap(first.nonce)

    with database.connect(immediate=True) as connection:
        _ = connection.execute("DELETE FROM browser_bootstrap_nonces")
    second = service.issue_bootstrap()
    with pytest.raises(LocalApiSecurityCapacityError):
        _ = service.consume_bootstrap(second.nonce)
    with database.connect() as connection:
        nonce = fetch_one(
            connection,
            "SELECT consumed_at, version FROM browser_bootstrap_nonces",
        )
    assert nonce[0] is None
    assert nonce[1] == 0


def test_nonce_and_session_verification_call_compare_digest_on_misses(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, _, service = make_security(tmp_path)
    original_compare = hmac.compare_digest
    calls: list[tuple[object, object]] = []

    def recording_compare(left: object, right: object) -> bool:
        calls.append((left, right))
        if isinstance(left, bytes) and isinstance(right, bytes):
            return original_compare(left, right)
        if isinstance(left, str) and isinstance(right, str):
            return original_compare(left, right)
        return False

    monkeypatch.setattr(hmac, "compare_digest", recording_compare)
    with pytest.raises(BootstrapAuthenticationError):
        _ = service.consume_bootstrap("missing")
    assert len(calls) == 1

    calls.clear()
    with pytest.raises(SessionAuthenticationError):
        _ = service.authenticate_session("missing")
    assert len(calls) == 1
