"""HTTP surface for vault configuration and Obsidian export (C2)."""

from __future__ import annotations

from pathlib import Path

from tests.integration.test_local_api_app import (
    ApiHarness,
    complete_local_import,
    open_harness,
)


def configure(api: ApiHarness, vault: Path):
    return api.client.put(
        "/api/obsidian/vault",
        json={"name": "My Vault", "root_path": str(vault)},
        headers=api.write_headers(),
    )


def test_configures_a_vault_and_exports_a_book(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    with open_harness(tmp_path / "app") as api:
        _, book_id = complete_local_import(api)
        configured = configure(api, vault)
        assert configured.status_code == 200, configured.text
        assert configured.json()["data"]["vault"]["name"] == "My Vault"

        exported = api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        )
        assert exported.status_code == 200, exported.text
        data = exported.json()["data"]
        kinds = sorted(item["target_kind"] for item in data["exports"])
        assert kinds == ["book", "highlights", "notes", "summary"]
        assert all(item["outcome"] == "created" for item in data["exports"])
        assert data["conflicts"] == []
        assert all(item["deep_link"].startswith("obsidian://") for item in data["exports"])
        assert len(list(vault.rglob("*.md"))) == 4


def test_a_second_export_is_unchanged_and_adds_no_file(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    with open_harness(tmp_path / "app") as api:
        _, book_id = complete_local_import(api)
        configure(api, vault)
        api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        )
        again = api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        )
        assert all(item["outcome"] == "unchanged" for item in again.json()["data"]["exports"])
        assert len(list(vault.rglob("*.md"))) == 4


def test_a_manual_edit_produces_a_reported_conflict(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    with open_harness(tmp_path / "app") as api:
        _, book_id = complete_local_import(api)
        configure(api, vault)
        first = api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        ).json()["data"]
        notes_file = next(
            vault / item["relative_path"]
            for item in first["exports"]
            if item["target_kind"] == "notes"
        )
        notes_file.write_text(
            notes_file.read_text(encoding="utf-8") + "\n我手写的一段。\n", encoding="utf-8"
        )

        # Add a note so the render genuinely differs from what was exported.
        api.client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "新的锚定笔记。"},
            headers=api.write_headers(),
        )
        second = api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        ).json()["data"]
        conflicts = second["conflicts"]
        assert [item["target_kind"] for item in conflicts] == ["notes"]
        assert "我手写的一段。" in notes_file.read_text(encoding="utf-8")


def test_export_without_a_vault_is_refused(tmp_path: Path) -> None:
    with open_harness(tmp_path / "app") as api:
        _, book_id = complete_local_import(api)
        response = api.client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=api.write_headers()
        )
        assert response.status_code == 422, response.text


def test_rejects_a_relative_vault_path_and_an_unknown_book(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    with open_harness(tmp_path / "app") as api:
        bad = api.client.put(
            "/api/obsidian/vault",
            json={"name": "v", "root_path": "relative/path"},
            headers=api.write_headers(),
        )
        assert bad.status_code == 422, bad.text
        configure(api, vault)
        missing = api.client.post(
            "/api/books/missing/obsidian-export", json={}, headers=api.write_headers()
        )
        assert missing.status_code == 404


def test_vault_configuration_requires_write_credentials(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    with open_harness(tmp_path / "app") as api:
        response = api.client.put(
            "/api/obsidian/vault",
            json={"name": "v", "root_path": str(vault)},
            headers=api.read_headers(),
        )
        assert response.status_code in {401, 403}
