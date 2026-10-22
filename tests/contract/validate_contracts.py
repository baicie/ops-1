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


    # --- 0.0.2 Data Foundation contracts ---------------------------------
    data_schema_specs = {
        "capability-fabric.v1.schema.json": {
            "CapabilityDescriptor": "capability-descriptor.json",
            "CapabilityGrant": "capability-grant.json",
        },
        "data-catalog.v1.schema.json": {
            "SchemaDefinition": "data-catalog-schema.json",
            "DatasetWriteRequest": "data-catalog-write.json",
            "DatasetWriteReceipt": "data-catalog-receipt.json",
        },
        "data-integration.v1.schema.json": {
            "DataSource": "data-integration-source.json",
            "PreviewResult": "data-integration-preview.json",
            "IngestionRun": "data-integration-run.json",
        },
        "plugin-storage.v1.schema.json": {
            "PluginStorage": "plugin-storage.json",
        },
    }
    for schema_name, examples in data_schema_specs.items():
        schema = schemas.get(schema_name)
        if schema is None:
            FAILURES.append(f"{schema_name}: data foundation schema missing")
            continue
        validator = jsonschema.Draft202012Validator(schema)
        for definition, example_name in examples.items():
            example_path = CONTRACTS / "examples" / example_name
            if definition not in schema.get("$defs", {}) and not (
                schema_name == "plugin-storage.v1.schema.json" and definition == "PluginStorage"
            ):
                FAILURES.append(f"{schema_name}: missing $defs/{definition}")
                continue
            instance = load(example_path)
            if definition not in schema.get("$defs", {}):
                definition_schema = schema
            else:
                definition_schema = {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$defs": schema["$defs"],
                    "$ref": f"#/$defs/{definition}",
                }
            for error in sorted(
                jsonschema.Draft202012Validator(definition_schema).iter_errors(instance),
                key=lambda item: list(item.path),
            ):
                FAILURES.append(f"{example_name}: {error.message}")

    # A schema revision must be a positive immutable version; a preview must
    # declare readOnly=true. These are negative contract tests, not runtime
    # authorization tests.
    catalog_schema = schemas.get("data-catalog.v1.schema.json")
    if catalog_schema:
        bad_write = load(CONTRACTS / "examples" / "data-catalog-write.json")
        bad_write["schemaRevision"] = 0
        catalog_write_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": catalog_schema["$defs"],
            "$ref": "#/$defs/DatasetWriteRequest",
        }
        if jsonschema.Draft202012Validator(catalog_write_schema).is_valid(bad_write):
            FAILURES.append("catalog accepted schemaRevision=0")
    integration_schema = schemas.get("data-integration.v1.schema.json")
    if integration_schema:
        bad_preview = load(CONTRACTS / "examples" / "data-integration-preview.json")
        bad_preview["readOnly"] = False
        preview_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": integration_schema["$defs"],
            "$ref": "#/$defs/PreviewResult",
        }
        if jsonschema.Draft202012Validator(preview_schema).is_valid(bad_preview):
            FAILURES.append("integration accepted a writable preview")

    # OpenAPI contract presence and operation IDs are part of the executable
    # contract discovery test even without a full OpenAPI resolver.
    try:
        import yaml
    except ImportError:
        FAILURES.append("PyYAML is required for OpenAPI contract checks")
        yaml = None
    if yaml is not None:
        openapi_requirements = {
            "capability-v1.yaml": [
                "/capabilities", "/capabilities/{name}/{major}/resolve",
                "/capability-grants", "/plugin-storage/{pluginId}",
            ],
            "data-catalog-v1.yaml": [
                "/datasets", "/datasets/{datasetId}/schemas/drafts",
                "/datasets/{datasetId}/schemas/{revision}/publish",
                "/datasets/{datasetId}/records",
            ],
            "data-integration-v1.yaml": [
                "/sources", "/sources/{sourceId}/preview",
                "/sources/{sourceId}/ingestion-specs",
                "/ingestion-runs",
            ],
        }
        for filename, required_paths in openapi_requirements.items():
            document = yaml.safe_load((CONTRACTS / "openapi" / filename).read_text())
            for path in required_paths:
                if path not in document.get("paths", {}):
                    FAILURES.append(f"{filename}: missing path {path}")
            operation_ids = []
            for path in document.get("paths", {}).values():
                for operation in path.values():
                    if isinstance(operation, dict) and "operationId" in operation:
                        operation_ids.append(operation["operationId"])
            if len(operation_ids) != len(set(operation_ids)):
                FAILURES.append(f"{filename}: duplicate operationId")

            def check_refs(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key == "$ref" and isinstance(child, str) and child.startswith("../schema/"):
                            target, _, fragment = child.partition("#")
                            schema_path = (CONTRACTS / "openapi" / target).resolve()
                            try:
                                target_schema = json.loads(schema_path.read_text())
                            except Exception as exc:
                                FAILURES.append(f"{filename}: unresolved $ref {child}: {exc}")
                                continue
                            pointer = fragment.lstrip("/").split("/") if fragment else []
                            node = target_schema
                            for segment in pointer:
                                if not segment:
                                    continue
                                if isinstance(node, dict) and segment in node:
                                    node = node[segment]
                                else:
                                    FAILURES.append(f"{filename}: unresolved $ref {child}")
                                    break
                        else:
                            check_refs(child)
                elif isinstance(value, list):
                    for child in value:
                        check_refs(child)
            check_refs(document)

    storage_schema = schemas.get("plugin-storage.v1.schema.json")
    if storage_schema is None:
        FAILURES.append("plugin-storage.v1.schema.json: missing storage ownership contract")

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
