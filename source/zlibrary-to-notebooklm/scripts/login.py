#!/usr/bin/env python3
"""
Z-Library Login - 一次性登录，保存会话状态

类似 notebooklm login 的工作方式
"""

import argparse
import json
import os
import sys
import tempfile
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlparse, urlunsplit

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    print("❌ Playwright 未安装")
    print("请运行: pip install playwright")
    sys.exit(1)


DEFAULT_LOGIN_URL = "https://z-library.sk/"
LOGIN_URL_ENV = "ZLIBRARY_LOGIN_URL"


def https_url(value: str) -> str:
    """Validate a user-supplied HTTPS login URL without embedded credentials."""
    if any(ord(character) < 32 for character in value):
        raise argparse.ArgumentTypeError("登录地址不能包含控制字符")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise argparse.ArgumentTypeError("登录地址必须是包含有效域名的 HTTPS URL")
    if parsed.username or parsed.password:
        raise argparse.ArgumentTypeError("登录地址不能包含用户名或密码")
    return value


def display_url(value: str) -> str:
    """Return a URL safe for terminal output by removing query and fragment."""
    parsed = urlparse(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", ""))


def validate_final_url(current_url: str, configured_url: str) -> None:
    """Reject HTTPS downgrades and untrusted cross-host navigation before capture."""
    try:
        current = urlparse(https_url(current_url))
    except argparse.ArgumentTypeError as exc:
        raise ValueError(f"浏览器最终地址不安全: {exc}") from exc

    configured = urlparse(configured_url)
    configured_host = (configured.hostname or "").lower()
    allowed_hosts = {configured_host}
    if configured_host.startswith("www."):
        allowed_hosts.add(configured_host[4:])
    else:
        allowed_hosts.add(f"www.{configured_host}")
    if (current.hostname or "").lower() not in allowed_hosts:
        raise ValueError("浏览器跳转到了未配置的域名；请确认可信入口后通过 --url 显式指定最终地址")


def atomic_write_storage_state(path: Path, state: dict[str, object]) -> None:
    """Write a private storage-state snapshot without exposing a partial file."""
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(state, temporary_file, ensure_ascii=False)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
        path.chmod(0o600)
    except BaseException:
        with suppress(OSError):
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)
        raise


class LoginArgs(argparse.Namespace):
    def __init__(self, url: str) -> None:
        super().__init__()
        self.url: str = url


def parse_args(argv: list[str] | None = None) -> LoginArgs:
    parser = argparse.ArgumentParser(description="登录 Z-Library 并保存浏览器会话")
    _ = parser.add_argument(
        "--url",
        type=https_url,
        default=None,
        help=f"登录入口（默认: {DEFAULT_LOGIN_URL}；也可设置 {LOGIN_URL_ENV}）",
    )
    parsed = parser.parse_args(argv)
    if parsed.url is not None:
        return LoginArgs(parsed.url)

    configured_default = os.environ.get(LOGIN_URL_ENV, DEFAULT_LOGIN_URL)
    try:
        return LoginArgs(https_url(configured_default))
    except argparse.ArgumentTypeError as exc:
        parser.error(f"{LOGIN_URL_ENV}: {exc}")


def zlibrary_login(login_url: str) -> bool:
    """打开登录入口并安全保存浏览器会话。"""
    config_dir = Path.home() / ".zlibrary"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_dir.chmod(0o700)
    storage_state = config_dir / "storage_state.json"

    print("=" * 70)
    print("🔐 Z-Library 登录")
    print("=" * 70)
    print()
    safe_login_url = display_url(login_url)
    print(f"登录入口: {safe_login_url}")
    print("说明:")
    print("  1. 浏览器会自动打开登录入口")
    print("  2. 请手动完成登录（如果需要）")
    print("  3. 登录成功后，回到终端按 ENTER")
    print("  4. 会话状态将被保存，后续无需再次登录")
    print()

    with sync_playwright() as p:
        browser = None
        try:
            print("🚀 启动浏览器...")
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(config_dir / "browser_profile"),
                headless=False,
                args=["--disable-blink-features=AutomationControlled"],
            )
            page = browser.pages[0] if browser.pages else browser.new_page()

            print("📖 访问登录入口...")
            _ = page.goto(login_url, wait_until="domcontentloaded", timeout=30_000)
            validate_final_url(page.url, login_url)

            print()
            print("=" * 70)
            print("📋 操作步骤:")
            print("=" * 70)
            print("1. 在浏览器中完成登录（如果未登录）")
            print("2. 等待看到已登录的主页")
            print("3. 回到终端，按 ENTER 继续")
            print("=" * 70)
            print()

            _ = input("✅ 已完成登录？按 ENTER 保存会话... ")
            validate_final_url(page.url, login_url)
            captured_state = browser.storage_state()
            atomic_write_storage_state(storage_state, dict(captured_state))

            print()
            print("✅ 会话已保存！")
            print(f"📁 位置: {storage_state}")
            print()
            print("💡 现在可以运行自动化脚本了：")
            print('   python scripts/upload.py "<你有合法访问权的书籍 URL>"')
            print()
            return True
        except KeyboardInterrupt:
            print("\n⚠️  登录已取消")
            return False
        except PlaywrightError as exc:
            print(f"❌ 浏览器访问失败: {type(exc).__name__}")
            if "ERR_CONNECTION_CLOSED" in str(exc):
                print()
                print("连接在显示登录页面之前被关闭，这不是账号或密码错误。")
                print(f"请先确认普通浏览器能够访问同一地址: {safe_login_url}")
                print("如果你有合法且可访问的入口，请使用：")
                print('  python scripts/login.py --url "https://你的可访问入口/"')
            return False
        except ValueError as exc:
            print(f"❌ 登录入口安全检查失败: {exc}")
            return False
        except OSError as exc:
            print(f"❌ 本地文件错误: {exc}")
            return False
        finally:
            if browser is not None:
                browser.close()


def main(argv: list[str] | None = None) -> int:
    """运行登录命令并返回适合自动化使用的退出码。"""
    args = parse_args(argv)
    return 0 if zlibrary_login(args.url) else 1


if __name__ == "__main__":
    sys.exit(main())
