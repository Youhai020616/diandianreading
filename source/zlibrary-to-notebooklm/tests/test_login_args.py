from __future__ import annotations

import argparse
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import login


class LoginArgumentTests(unittest.TestCase):
    def test_uses_project_default_when_no_override_exists(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            _ = os.environ.pop(login.LOGIN_URL_ENV, None)
            args = login.parse_args([])

        self.assertEqual(args.url, "https://z-library.sk/")

    def test_environment_overrides_project_default(self) -> None:
        with patch.dict(
            os.environ,
            {login.LOGIN_URL_ENV: "https://account.example/"},
            clear=False,
        ):
            args = login.parse_args([])

        self.assertEqual(args.url, "https://account.example/")

    def test_cli_url_overrides_environment(self) -> None:
        with patch.dict(
            os.environ,
            {login.LOGIN_URL_ENV: "https://environment.example/"},
            clear=False,
        ):
            args = login.parse_args(["--url", "https://cli.example/"])

        self.assertEqual(args.url, "https://cli.example/")

    def test_rejects_non_https_cli_url(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            _ = login.parse_args(["--url", "http://example.com/"])

        self.assertEqual(raised.exception.code, 2)

    def test_valid_cli_url_overrides_invalid_environment(self) -> None:
        with patch.dict(os.environ, {login.LOGIN_URL_ENV: "http://invalid.example/"}, clear=False):
            args = login.parse_args(["--url", "https://valid.example/"])

        self.assertEqual(args.url, "https://valid.example/")

    def test_help_ignores_invalid_environment_default(self) -> None:
        with (
            patch.dict(os.environ, {login.LOGIN_URL_ENV: "http://invalid.example/"}, clear=False),
            self.assertRaises(SystemExit) as raised,
        ):
            _ = login.parse_args(["--help"])

        self.assertEqual(raised.exception.code, 0)

    def test_rejects_invalid_environment_url(self) -> None:
        with (
            patch.dict(os.environ, {login.LOGIN_URL_ENV: ""}, clear=False),
            self.assertRaises(SystemExit) as raised,
        ):
            _ = login.parse_args([])

        self.assertEqual(raised.exception.code, 2)

    def test_rejects_url_userinfo_and_control_characters(self) -> None:
        for value in ("https://user:secret@example.com/", "https://example.com/\nnext"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                _ = login.https_url(value)

    def test_display_url_removes_query_and_fragment(self) -> None:
        rendered = login.display_url("https://example.com/login?token=secret#fragment")
        self.assertEqual(rendered, "https://example.com/login")
        self.assertNotIn("secret", rendered)

    def test_final_url_rejects_downgrade_and_cross_host(self) -> None:
        for current in ("http://z-library.sk/", "https://lookalike.example/"):
            with self.subTest(current=current), self.assertRaises(ValueError):
                login.validate_final_url(current, "https://z-library.sk/")

        login.validate_final_url("https://www.z-library.sk/home", "https://z-library.sk/")

    def test_storage_state_is_written_atomically_with_private_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "storage_state.json"
            login.atomic_write_storage_state(
                destination,
                {"cookies": [{"name": "session", "value": "secret"}]},
            )

            self.assertEqual(
                json.loads(destination.read_text(encoding="utf-8"))["cookies"][0]["name"], "session"
            )
            if os.name != "nt":
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_main_passes_resolved_default_to_login(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(login, "zlibrary_login", return_value=True) as mocked_login,
        ):
            _ = os.environ.pop(login.LOGIN_URL_ENV, None)
            exit_code = login.main([])

        self.assertEqual(exit_code, 0)
        mocked_login.assert_called_once_with("https://z-library.sk/")


if __name__ == "__main__":
    _ = unittest.main()
