from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

import diandianreading.infrastructure.browser_runtime as browser_module
from diandianreading.infrastructure.browser_runtime import (
    BROWSER_MANIFEST_FILENAME,
    BrowserRuntimeError,
    BrowserRuntimeManager,
    BrowserRuntimeState,
)


def create_fake_browser(output: Path, quiet: bool, *, content: str = "browser") -> None:
    del quiet
    executable = output / "chromium-1228" / "chrome-mac" / "Chromium"
    executable.parent.mkdir(parents=True)
    executable.write_text(content, encoding="utf-8")
    executable.chmod(0o700)


def test_reports_missing_browser_support_without_mutating_the_home(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(browser_module, "_installed_playwright_version", lambda: None)
    root = tmp_path / "home" / "browsers"
    manager = BrowserRuntimeManager(root)

    assert manager.inspect().state is BrowserRuntimeState.SUPPORT_MISSING
    assert not root.exists()
    with pytest.raises(BrowserRuntimeError, match="support is not installed"):
        manager.provision()


def test_provisions_validates_and_configures_one_private_revision(tmp_path, monkeypatch) -> None:
    root = tmp_path / "home" / "browsers"
    manager = BrowserRuntimeManager(
        root,
        playwright_version="1.61.0",
        installer=create_fake_browser,
    )

    status = manager.provision(quiet=True)

    assert status.state is BrowserRuntimeState.READY
    assert status.playwright_version == "1.61.0"
    assert status.revision == "chromium-1228"
    assert status.installed_bytes == len("browser")
    version_root = root / "playwright-1.61.0"
    manifest = json.loads((version_root / BROWSER_MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert manifest["executable"] == "chromium-1228/chrome-mac/Chromium"
    assert len(manifest["executable_sha256"]) == 64
    assert stat_mode(root) == 0o700

    configured = manager.configure_environment()
    assert configured.state is BrowserRuntimeState.READY
    assert os.environ["PLAYWRIGHT_BROWSERS_PATH"] == str(version_root)
    assert manager.provision().state is BrowserRuntimeState.READY
    assert not list(root.glob(".staging-*"))
    assert not list(root.glob(".previous-*"))


def test_detects_integrity_damage_and_force_replaces_it_atomically(tmp_path) -> None:
    root = tmp_path / "home" / "browsers"
    calls = 0

    def installer(output: Path, quiet: bool) -> None:
        nonlocal calls
        calls += 1
        create_fake_browser(output, quiet, content=f"browser-{calls}")

    manager = BrowserRuntimeManager(root, playwright_version="1.61.0", installer=installer)
    assert manager.provision().state is BrowserRuntimeState.READY
    executable = root / "playwright-1.61.0" / "chromium-1228" / "chrome-mac" / "Chromium"
    executable.write_text("tampered", encoding="utf-8")
    assert manager.inspect().state is BrowserRuntimeState.CORRUPT
    with pytest.raises(BrowserRuntimeError, match="--force"):
        manager.provision()

    replaced = manager.provision(force=True)

    assert replaced.state is BrowserRuntimeState.READY
    assert executable.read_text(encoding="utf-8") == "browser-2"
    assert not list(root.glob(".previous-*"))


def test_failed_replacement_keeps_the_previous_complete_revision(tmp_path) -> None:
    root = tmp_path / "home" / "browsers"
    original = BrowserRuntimeManager(
        root,
        playwright_version="1.61.0",
        installer=create_fake_browser,
    )
    assert original.provision().state is BrowserRuntimeState.READY

    def fail_install(output: Path, quiet: bool) -> None:
        del output, quiet
        raise subprocess.CalledProcessError(1, ["playwright", "install"])

    replacement = BrowserRuntimeManager(
        root,
        playwright_version="1.61.0",
        installer=fail_install,
    )
    with pytest.raises(BrowserRuntimeError, match="failed safely"):
        replacement.provision(force=True)

    assert original.inspect().state is BrowserRuntimeState.READY
    assert not list(root.glob(".staging-*"))
    assert not list(root.glob(".previous-*"))


def test_reports_a_different_installed_playwright_version(tmp_path) -> None:
    root = tmp_path / "home" / "browsers"
    old = BrowserRuntimeManager(
        root,
        playwright_version="1.60.0",
        installer=create_fake_browser,
    )
    assert old.provision().state is BrowserRuntimeState.READY

    current = BrowserRuntimeManager(root, playwright_version="1.61.0")

    assert current.inspect().state is BrowserRuntimeState.VERSION_MISMATCH


def test_refuses_a_symbolic_link_browser_root(tmp_path) -> None:
    target = tmp_path / "outside"
    target.mkdir()
    root = tmp_path / "home" / "browsers"
    root.parent.mkdir()
    root.symlink_to(target, target_is_directory=True)
    manager = BrowserRuntimeManager(
        root, playwright_version="1.61.0", installer=create_fake_browser
    )

    assert manager.inspect().state is BrowserRuntimeState.CORRUPT
    with pytest.raises(BrowserRuntimeError, match="symbolic link"):
        manager.provision()


def test_force_replacement_unlinks_a_version_symlink_without_touching_its_target(
    tmp_path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    root = tmp_path / "home" / "browsers"
    root.mkdir(parents=True, mode=0o700)
    destination = root / "playwright-1.61.0"
    destination.symlink_to(outside, target_is_directory=True)
    manager = BrowserRuntimeManager(
        root,
        playwright_version="1.61.0",
        installer=create_fake_browser,
    )

    assert manager.inspect().state is BrowserRuntimeState.CORRUPT
    assert manager.provision(force=True).state is BrowserRuntimeState.READY
    assert marker.read_text(encoding="utf-8") == "keep"
    assert destination.is_dir()
    assert not destination.is_symlink()


def test_manifest_rejects_unknown_fields(tmp_path) -> None:
    root = tmp_path / "home" / "browsers"
    manager = BrowserRuntimeManager(
        root,
        playwright_version="1.61.0",
        installer=create_fake_browser,
    )
    assert manager.provision().state is BrowserRuntimeState.READY
    manifest_path = root / "playwright-1.61.0" / BROWSER_MANIFEST_FILENAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["unexpected"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert manager.inspect().state is BrowserRuntimeState.CORRUPT


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
