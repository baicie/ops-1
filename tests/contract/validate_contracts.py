#!/usr/bin/env python3
"""Validate every published schema/example and the generated plugin bundles."""
import json
import hashlib
import sys
import zipfile
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"
FAILURES = []


def load(path: Path):
    with path.open() as handle:
        return json.load(handle)


def check_schema(path: Path):
    schema = load(path)
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"{path.relative_to(ROOT)}: invalid schema: {exc}")
        return None
    return schema


def validate(path: Path, schema_path: Path):
    schema = check_schema(schema_path)
    if schema is None:
        return
    validator = jsonschema.Draft202012Validator(schema)
    document = load(path)
    for error in sorted(validator.iter_errors(document), key=lambda item: list(item.path)):
        FAILURES.append(f"{path.relative_to(ROOT)}: {error.message}")


def main() -> int:
    schemas = {}
    for schema_path in sorted((CONTRACTS / "schema").glob("*.json")):
        schema = check_schema(schema_path)
        if schema is not None:
            schemas[schema_path.name] = schema

    mapping = {
        "plugin-manifest.json": "plugin-manifest.v1.schema.json",
        "plugin-runtime-info.json": "plugin-runtime-info.v1.schema.json",
        "node-observation.json": "node-observation.v1.schema.json",
        "deployment.json": "deployment.v1.schema.json",
        "log-event.json": "log-event.v1.schema.json",
        "frontend-asset-index.json": "frontend-asset-index.v1.schema.json",
    }
    for example, schema in mapping.items():
        validate(CONTRACTS / "examples" / example, CONTRACTS / "schema" / schema)

    # Negative contract checks: v1.0 must not be read as v1.1, tag images must be rejected.
    manifest_schema = schemas["plugin-manifest.v1.schema.json"]
    v10 = load(CONTRACTS / "examples" / "plugin-manifest.json")
    v10["schemaVersion"] = "1.0"
    if jsonschema.Draft202012Validator(manifest_schema).is_valid(v10):
        FAILURES.append("schema accepted schemaVersion 1.0")
    tag_manifest = load(CONTRACTS / "examples" / "plugin-manifest.json")
    tag_manifest["backend"]["imageRef"] = "registry.example.invalid/opsweave/hello:latest"
    if jsonschema.Draft202012Validator(manifest_schema).is_valid(tag_manifest):
        FAILURES.append("schema accepted an unpinned image tag")

    # Generated bundles: schema-check the embedded manifest, asset index and
    # recompute the three hashes without trusting the packer.
    bundle_dir = ROOT / "dist" / "plugins"
    if bundle_dir.exists():
        for bundle_path in sorted(bundle_dir.glob("*.plugin.zip")):
            try:
                with zipfile.ZipFile(bundle_path) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    errors = list(jsonschema.Draft202012Validator(manifest_schema).iter_errors(manifest))
                    for error in errors:
                        FAILURES.append(f"{bundle_path.name} manifest: {error.message}")
                    if manifest.get("frontend"):
                        index = json.loads(archive.read(manifest["frontend"]["assetIndex"]))
                        for error in jsonschema.Draft202012Validator(schemas["frontend-asset-index.v1.schema.json"]).iter_errors(index):
                            FAILURES.append(f"{bundle_path.name} asset index: {error.message}")
                        index_digest = "sha256:" + hashlib.sha256(archive.read(manifest["frontend"]["assetIndex"])).hexdigest()
                        if index_digest != manifest["frontend"]["assetIndexDigest"]:
                            FAILURES.append(f"{bundle_path.name}: assetIndexDigest mismatch")
                        remote_digest = "sha256:" + hashlib.sha256(archive.read(manifest["frontend"]["remoteEntry"])).hexdigest()
                        if remote_digest != manifest["frontend"]["remoteEntryDigest"]:
                            FAILURES.append(f"{bundle_path.name}: remoteEntryDigest mismatch")
                print(f"  ok bundle {bundle_path.name}")
            except Exception as exc:  # noqa: BLE001
                FAILURES.append(f"{bundle_path.name}: {exc}")
    else:
        print("  (no dist/plugins yet; bundle checks skipped)")

    if FAILURES:
        print("CONTRACT VALIDATION FAILED")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("contract validation passed")
    print(f"  schemas: {len(schemas)}")
    print(f"  examples validated: {len(mapping)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
