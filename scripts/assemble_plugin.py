#!/usr/bin/env python3
"""Assemble a plugin bundle staging directory from a manifest template.

The OCI backend image is referenced by digest; it is never copied into the ZIP.
The signed manifest digests are filled by `opsctl bundle`.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--image-ref", required=True)
    parser.add_argument("--frontend-dist", type=Path)
    args = parser.parse_args()

    manifest = json.loads(args.template.read_text())
    manifest["version"] = args.version
    manifest["backend"]["imageRef"] = args.image_ref
    if args.frontend_dist:
        if manifest.get("frontend") is None:
            raise SystemExit("template has no frontend section")
        if args.out.exists():
            shutil.rmtree(args.out)
        frontend = args.out / "frontend"
        frontend.mkdir(parents=True, exist_ok=True)
        assets = []
        for source in sorted(args.frontend_dist.rglob("*")):
            if not source.is_file() or source.suffix == ".map":
                continue
            relative = source.relative_to(args.frontend_dist)
            destination = frontend / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            assets.append({
                "path": "frontend/" + relative.as_posix(),
                "size": destination.stat().st_size,
                "sha256": sha256(destination),
            })
        index = {"version": "1", "assets": assets}
        (frontend / "asset-index.json").write_text(
            json.dumps(index, separators=(",", ":"), sort_keys=False) + "\n"
        )
        manifest["frontend"]["assetIndex"] = "frontend/asset-index.json"
    else:
        if args.out.exists():
            shutil.rmtree(args.out)
        args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=False) + "\n"
    )
    print(f"assembled {args.out} ({manifest['id']}@{args.version})")


if __name__ == "__main__":
    main()
