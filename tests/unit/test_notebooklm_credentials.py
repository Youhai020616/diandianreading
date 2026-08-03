from __future__ import annotations

import json
import os
import stat

import pytest

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.notebooklm import CredentialPathResolver


def write_storage_state(resolver: CredentialPathResolver, credential: CredentialRef) -> object:
    profile = resolver.prepare_profile_directory(credential)
    path = profile / "storage_state.json"
    path.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    return path


def test_resolver_maps_opaque_profile_to_private_hashed_path(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "personal account")
    path = write_storage_state(resolver, credential)

    resolved = resolver.resolve_storage_state(credential)

    assert resolved == path
    assert resolved.is_absolute()
    assert credential.profile not in str(resolved)
    assert resolved.parent.name.startswith("profile-")
    if os.name != "nt":
        assert stat.S_IMODE(resolved.stat().st_mode) == 0o600
        assert stat.S_IMODE(resolved.parent.stat().st_mode) == 0o700


def test_resolver_maps_missing_or_invalid_storage_state_to_auth_required(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "missing")

    with pytest.raises(DiandianError) as missing:
        resolver.resolve_storage_state(credential)
    assert missing.value.code is ErrorCode.AUTH_REQUIRED
    assert str(tmp_path) not in missing.value.public_message

    path = resolver.prepare_profile_directory(credential) / "storage_state.json"
    path.write_text("not-json", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    with pytest.raises(DiandianError) as invalid:
        resolver.resolve_storage_state(credential)
    assert invalid.value.code is ErrorCode.AUTH_REQUIRED

    path.write_text(json.dumps({"origins": []}), encoding="utf-8")
    with pytest.raises(DiandianError) as missing_cookies:
        resolver.resolve_storage_state(credential)
    assert missing_cookies.value.code is ErrorCode.AUTH_REQUIRED


def test_resolver_rejects_wrong_provider_permissions_and_symlinks(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "secure")
    path = write_storage_state(resolver, credential)

    with pytest.raises(ValueError, match="cannot use provider"):
        resolver.resolve_storage_state(CredentialRef("other", "secure"))

    if os.name != "nt":
        path.chmod(0o644)
        with pytest.raises(UnsafePathError, match="permissions"):
            resolver.resolve_storage_state(credential)
        path.chmod(0o600)

    if hasattr(os, "symlink"):
        path.unlink()
        outside = tmp_path / "outside.json"
        outside.write_text(json.dumps({"cookies": []}), encoding="utf-8")
        if os.name != "nt":
            outside.chmod(0o600)
        path.symlink_to(outside)
        with pytest.raises(UnsafePathError, match="regular non-symlink"):
            resolver.resolve_storage_state(credential)


def test_resolver_rejects_symlink_component_in_credential_root(tmp_path) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    linked_root = tmp_path / "credentials"
    linked_root.symlink_to(outside, target_is_directory=True)

    with pytest.raises(UnsafePathError, match="cannot contain symlinks"):
        CredentialPathResolver(linked_root)
