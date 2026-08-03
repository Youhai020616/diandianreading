from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "src" / "diandianreading"


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative = path.relative_to(ROOT / "src").with_suffix("")
    module_parts = relative.parts
    current_package = module_parts if path.name == "__init__.py" else module_parts[:-1]
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            modules.add(_resolve_from_import(current_package, node.level, node.module))
    return {module for module in modules if module}


def _resolve_from_import(
    current_package: tuple[str, ...],
    level: int,
    module: str | None,
) -> str:
    if level == 0:
        return module or ""
    keep = len(current_package) - (level - 1)
    if keep < 0:
        return module or ""
    base = current_package[:keep]
    suffix = tuple(module.split(".")) if module else ()
    return ".".join((*base, *suffix))


def test_relative_import_resolution_cannot_bypass_boundaries() -> None:
    assert (
        _resolve_from_import(
            ("diandianreading", "domain"),
            2,
            "infrastructure",
        )
        == "diandianreading.infrastructure"
    )


def test_domain_has_no_framework_or_outer_layer_dependencies() -> None:
    forbidden = {
        "fastapi",
        "playwright",
        "notebooklm",
        "sqlite3",
        "diandianreading.application",
        "diandianreading.infrastructure",
        "diandianreading.interfaces",
        "diandianreading.worker",
    }
    violations: list[str] = []
    for path in (PACKAGE / "domain").rglob("*.py"):
        for module in imported_modules(path):
            if any(module == prefix or module.startswith(f"{prefix}.") for prefix in forbidden):
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []


def test_application_does_not_import_infrastructure_interfaces_or_databases() -> None:
    forbidden = {
        "playwright",
        "notebooklm",
        "sqlite3",
        "diandianreading.infrastructure",
        "diandianreading.interfaces",
        "diandianreading.worker",
    }
    violations: list[str] = []
    for path in (PACKAGE / "application").rglob("*.py"):
        for module in imported_modules(path):
            if any(module == prefix or module.startswith(f"{prefix}.") for prefix in forbidden):
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []


def test_main_application_never_imports_notebooklm_internal_modules() -> None:
    violations: list[str] = []
    for path in PACKAGE.rglob("*.py"):
        for module in imported_modules(path):
            if module.startswith("notebooklm._"):
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []
