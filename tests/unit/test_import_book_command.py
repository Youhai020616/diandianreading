from __future__ import annotations

from dataclasses import replace

import pytest

from diandianreading.domain import PreparationManifest, StorageKey
from tests.support import make_import_command


def test_import_command_requires_title_parts_unique_assets_and_contiguous_sequences(
    tmp_path,
) -> None:
    base = make_import_command(tmp_path, part_count=2)

    with pytest.raises(ValueError, match="title"):
        replace(base, title=" ")
    with pytest.raises(ValueError, match="At least one"):
        replace(base, parts=())
    with pytest.raises(ValueError, match="identities must be unique"):
        replace(
            base,
            derived_assets=(
                replace(
                    base.asset,
                    storage_key=StorageKey("derived/asset-1/root-copy.md"),
                ),
            ),
        )
    with pytest.raises(ValueError, match="belong to"):
        replace(base, parts=(replace(base.parts[0], asset_id="unknown-asset"),))
    with pytest.raises(ValueError, match="contiguous"):
        replace(base, parts=(replace(base.parts[0], sequence=1),))


def test_import_command_requires_a_root_and_parent_before_each_derived_asset(tmp_path) -> None:
    base = make_import_command(tmp_path, part_count=1)
    with pytest.raises(ValueError, match="root DocumentAsset"):
        replace(
            base,
            asset=replace(base.asset, derived_from_asset_id="outside-command"),
        )
    parent = replace(
        base.asset,
        id="derived-parent",
        storage_key=StorageKey("derived/asset-1/parent.md"),
        sha256="parent-hash",
        derived_from_asset_id=base.asset.id,
    )
    child = replace(
        parent,
        id="derived-child",
        storage_key=StorageKey("derived/asset-1/child.md"),
        sha256="child-hash",
        derived_from_asset_id=parent.id,
    )

    with pytest.raises(ValueError, match="existing parent"):
        replace(base, derived_assets=(child, parent))

    command = replace(
        base,
        derived_assets=(parent, child),
        parts=(replace(base.parts[0], asset_id=child.id),),
    )
    assert command.derived_assets == (parent, child)


def test_import_command_requires_unique_part_identities_and_content(tmp_path) -> None:
    base = make_import_command(tmp_path, part_count=2)

    with pytest.raises(ValueError, match="identities must be unique"):
        replace(base, parts=(base.parts[0], replace(base.parts[1], id=base.parts[0].id)))
    with pytest.raises(ValueError, match="content must be unique"):
        replace(
            base,
            parts=(base.parts[0], replace(base.parts[1], sha256=base.parts[0].sha256)),
        )


def test_import_command_manifest_must_describe_root_asset(tmp_path) -> None:
    base = make_import_command(tmp_path, part_count=1)
    manifest = PreparationManifest(
        root_asset_id="another-root",
        storage_key=StorageKey("manifests/another-root/manifest.json"),
        sha256="manifest-hash",
    )

    with pytest.raises(ValueError, match="command root asset"):
        replace(base, manifest=manifest)
