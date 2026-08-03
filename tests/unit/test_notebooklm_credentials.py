from __future__ import annotations

import hashlib
import json
import os
import stat
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.notebooklm import CredentialPathResolver


def write_private_text(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    return path


def write_storage_state(resolver: CredentialPathResolver, credential: CredentialRef) -> Path:
    profile = resolver.prepare_profile_directory(credential)
    return write_private_text(
        profile / "storage_state.json",
        json.dumps({"cookies": [], "origins": []}),
    )


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


def test_resolver_exposes_immutable_complete_profile_bundle(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "work account")

    paths = resolver.prepare_profile(credential)

    digest = hashlib.sha256(credential.profile.encode()).hexdigest()
    expected_key = f"profile-{digest[:32]}"
    assert paths.provider_root == resolver.provider_root
    assert paths.profile_key == expected_key
    assert resolver.profile_key(credential.profile) == expected_key
    assert resolver.safe_profile_key(credential.profile) == expected_key
    assert paths.profile_directory == resolver.provider_root / "profiles" / expected_key
    assert paths.browser_profile == paths.profile_directory / "browser_profile"
    assert paths.storage_state == paths.profile_directory / "storage_state.json"
    assert paths.context == paths.profile_directory / "context.json"
    assert paths.storage_context == paths.profile_directory / "storage_state.json.context.json"
    assert paths.master_token == paths.profile_directory / "master_token.json"
    assert paths.browser_profile.is_dir()
    assert resolver.profile_exists(credential)
    with pytest.raises(FrozenInstanceError):
        paths.profile_key = "not-safe"  # type: ignore[misc]


def test_resolver_maps_missing_or_invalid_storage_state_to_auth_required(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "missing")

    with pytest.raises(DiandianError) as missing:
        resolver.resolve_storage_state(credential)
    assert missing.value.code is ErrorCode.AUTH_REQUIRED
    assert str(tmp_path) not in missing.value.public_message

    path = resolver.prepare_profile_directory(credential) / "storage_state.json"
    write_private_text(path, "not-json")
    with pytest.raises(DiandianError) as invalid:
        resolver.resolve_storage_state(credential)
    assert invalid.value.code is ErrorCode.AUTH_REQUIRED

    write_private_text(path, json.dumps({"origins": []}))
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
        write_private_text(outside, json.dumps({"cookies": []}))
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


def test_secure_tree_normalizes_vendor_modes_after_type_and_owner_validation(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "normalize")
    paths = resolver.prepare_profile(credential)
    nested = paths.browser_profile / "nested"
    nested.mkdir(mode=0o700)
    artifact = nested / "Cookies"
    artifact.write_bytes(b"opaque browser state")
    write_private_text(paths.storage_state, json.dumps({"cookies": []}))

    if os.name != "nt":
        nested.chmod(0o755)
        artifact.chmod(0o644)
        paths.storage_state.chmod(0o640)

    resolver.secure_profile_tree(paths)

    resolver.validate_profile_tree(paths)
    if os.name != "nt":
        assert stat.S_IMODE(nested.stat().st_mode) == 0o700
        assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
        assert stat.S_IMODE(paths.storage_state.stat().st_mode) == 0o600


def test_delete_profile_removes_all_artifacts_but_isolates_siblings_and_provider_files(
    tmp_path,
) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    target = CredentialRef("notebooklm", "target")
    sibling = CredentialRef("notebooklm", "sibling")
    target_paths = resolver.prepare_profile(target)
    sibling_paths = resolver.prepare_profile(sibling)

    for path in (
        target_paths.storage_state,
        target_paths.context,
        target_paths.storage_context,
        target_paths.master_token,
        target_paths.browser_profile / "Cookies",
    ):
        write_private_text(path, "managed secret artifact")
    sibling_marker = write_private_text(sibling_paths.browser_profile / "marker", "keep")
    provider_marker = write_private_text(resolver.provider_root / "sentinel", "keep")

    assert resolver.delete_profile(target) is True

    assert not target_paths.profile_directory.exists()
    assert resolver.profile_exists(sibling)
    assert sibling_marker.read_text(encoding="utf-8") == "keep"
    assert provider_marker.read_text(encoding="utf-8") == "keep"
    assert resolver.delete_profile(target) is False


def test_delete_profile_rejects_nested_symlinks_and_public_permissions(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    symlinked = CredentialRef("notebooklm", "symlinked")
    symlinked_paths = resolver.prepare_profile(symlinked)
    outside = write_private_text(tmp_path / "outside", "keep")

    if hasattr(os, "symlink"):
        link = symlinked_paths.browser_profile / "escape"
        link.symlink_to(outside)
        with pytest.raises(UnsafePathError, match="symbolic links"):
            resolver.delete_profile(symlinked)
        assert outside.read_text(encoding="utf-8") == "keep"
        assert symlinked_paths.profile_directory.exists()

    if os.name == "nt":
        return

    permissive = CredentialRef("notebooklm", "permissive")
    permissive_paths = resolver.prepare_profile(permissive)
    artifact = write_private_text(permissive_paths.browser_profile / "Cookies", "secret")
    artifact.chmod(0o644)
    with pytest.raises(UnsafePathError, match="permissions"):
        resolver.delete_profile(permissive)
    assert permissive_paths.profile_directory.exists()
