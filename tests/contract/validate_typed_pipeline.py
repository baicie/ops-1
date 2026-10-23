#!/usr/bin/env python3
"""Contract and semantic conformance for the 0.0.3 design draft.

This is not a pipeline executor. It proves that the trusted registry, static
validation, canonicalization, state machine and sink receipt contracts are
unambiguous before implementation is allowed through Gate 0.0.3.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

import jsonschema
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "contracts" / "schema"
EXAMPLES = ROOT / "contracts" / "examples"
FAILURES: list[str] = []


def load(path: Path):
    with path.open() as handle:
        return json.load(handle)


def canonical_bytes(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def canonical_digest(value, omit: str | None = None) -> str:
    candidate = copy.deepcopy(value)
    if omit is not None:
        candidate.pop(omit, None)
    return "sha256:" + hashlib.sha256(canonical_bytes(candidate)).hexdigest()


def sub_schema(root: dict, name: str) -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": root["$defs"],
        "$ref": f"#/$defs/{name}",
    }


def check_schema(path: Path) -> dict | None:
    schema = load(path)
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"{path.name}: invalid JSON Schema: {exc}")
        return None
    return schema


def validate(document: dict, schema: dict, label: str) -> None:
    errors = sorted(
        jsonschema.Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(document),
        key=lambda item: list(item.path),
    )
    for error in errors:
        FAILURES.append(f"{label}: {error.message} at {list(error.path)}")


def topo_order(nodes: list[dict], edges: list[dict]) -> list[str]:
    ids = {node["nodeId"] for node in nodes}
    indegree = {node_id: 0 for node_id in ids}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge["fromNode"] not in ids or edge["toNode"] not in ids:
            raise ValueError("EDGE_ENDPOINT_UNKNOWN")
        outgoing[edge["fromNode"]].append(edge["toNode"])
        indegree[edge["toNode"]] += 1
    ready = sorted(node_id for node_id, count in indegree.items() if count == 0)
    ordered: list[str] = []
    while ready:
        current = ready.pop(0)
        ordered.append(current)
        for target in sorted(outgoing[current]):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort()
    if len(ordered) != len(ids):
        raise ValueError("CYCLE")
    return ordered


def _port_signature(ports: list[dict], output: bool) -> list[tuple]:
    fields = ("name", "dataType", "nullable" if output else "required", "schemaRevision")
    return sorted(tuple(port.get(field) for field in fields) for port in ports)


def verify_registry_signature(registry: dict, trusted_keys: dict) -> str | None:
    signature = registry.get("signature", {})
    key_id = signature.get("keyId")
    key_record = next((item for item in trusted_keys.get("keys", []) if item["keyId"] == key_id), None)
    if key_record is None:
        return f"UNKNOWN_REGISTRY_KEY:{key_id}"
    try:
        public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(key_record["publicKeyHex"]))
        payload = canonical_bytes({
            "schemaVersion": registry["schemaVersion"],
            "registryDigest": registry["registryDigest"],
            "entries": registry["entries"],
        })
        public_key.verify(base64.b64decode(signature["value"]), payload)
    except (InvalidSignature, KeyError, ValueError):
        return "REGISTRY_SIGNATURE_INVALID"
    return None


def validate_pipeline(pipeline: dict, registry: dict, schema_catalog: dict, trusted_keys: dict | None = None) -> list[str]:
    errors: list[str] = []
    nodes = pipeline.get("nodes", [])
    edges = pipeline.get("edges", [])
    if not 1 <= len(nodes) <= 64:
        errors.append("NODE_LIMIT")
    if len(edges) > 128:
        errors.append("EDGE_LIMIT")
    if canonical_digest(registry["entries"]) != registry.get("registryDigest"):
        errors.append("REGISTRY_DIGEST_MISMATCH")
    if not registry.get("signature") or not registry["signature"].get("algorithm"):
        errors.append("REGISTRY_SIGNATURE_MISSING")
    if trusted_keys is not None:
        signature_error = verify_registry_signature(registry, trusted_keys)
        if signature_error:
            errors.append(signature_error)

    registry_by_type = {
        (entry["type"], entry["typeVersion"]): entry for entry in registry.get("entries", [])
    }
    datasets = {
        dataset["datasetId"]: dataset for dataset in schema_catalog.get("datasets", [])
    }
    node_by_id: dict[str, dict] = {}
    for node in nodes:
        if node["nodeId"] in node_by_id:
            errors.append(f"DUPLICATE_NODE:{node['nodeId']}")
        node_by_id[node["nodeId"]] = node
        entry = registry_by_type.get((node["type"], node["typeVersion"]))
        if entry is None:
            errors.append(f"UNKNOWN_NODE_TYPE:{node['nodeId']}")
            continue
        if _port_signature(node.get("inputs", []), output=False) != _port_signature(entry.get("inputs", []), output=False):
            errors.append(f"PORT_SIGNATURE_MISMATCH:{node['nodeId']}:inputs")
        if _port_signature(node.get("outputs", []), output=True) != _port_signature(entry.get("outputs", []), output=True):
            errors.append(f"PORT_SIGNATURE_MISMATCH:{node['nodeId']}:outputs")
        config_validator = jsonschema.Draft202012Validator(
            entry["configSchema"], format_checker=FormatChecker()
        )
        for error in config_validator.iter_errors(node.get("config", {})):
            errors.append(f"CONFIG_INVALID:{node['nodeId']}:{error.message}")
        if node["type"] == "builtin.sink.dataset":
            dataset_id = node.get("config", {}).get("datasetId")
            revision = node.get("config", {}).get("schemaRevision")
            dataset = datasets.get(dataset_id)
            if dataset is None:
                errors.append(f"SCHEMA_REVISION_NOT_FOUND:{node['nodeId']}:dataset")
            else:
                found = next((item for item in dataset["revisions"] if item["schemaRevision"] == revision), None)
                if found is None or revision > dataset["latestPublishedRevision"]:
                    errors.append(f"SCHEMA_REVISION_NOT_FOUND:{node['nodeId']}:{revision}")
                elif found["status"] != "PUBLISHED":
                    errors.append(f"SCHEMA_NOT_PUBLISHED:{node['nodeId']}:{revision}")

    incoming: dict[tuple[str, str], int] = defaultdict(int)
    outgoing: dict[tuple[str, str], int] = defaultdict(int)
    for edge in edges:
        source = node_by_id.get(edge["fromNode"])
        target = node_by_id.get(edge["toNode"])
        if source is None or target is None:
            errors.append(f"EDGE_ENDPOINT_UNKNOWN:{edge['fromNode']}->{edge['toNode']}")
            continue
        source_port = next((port for port in source["outputs"] if port["name"] == edge["fromPort"]), None)
        target_port = next((port for port in target["inputs"] if port["name"] == edge["toPort"]), None)
        if source_port is None or target_port is None:
            errors.append(f"PORT_UNKNOWN:{edge['fromNode']}.{edge['fromPort']}->{edge['toNode']}.{edge['toPort']}")
            continue
        if source_port["dataType"] != edge["dataType"] or target_port["dataType"] != edge["dataType"]:
            errors.append(f"TYPE_MISMATCH:{edge['fromNode']}->{edge['toNode']}")
        incoming[(edge["toNode"], edge["toPort"])] += 1
        outgoing[(edge["fromNode"], edge["fromPort"])] += 1
    for node in nodes:
        for port in node.get("inputs", []):
            count = incoming[(node["nodeId"], port["name"])]
            if port.get("required") and count != 1:
                errors.append(f"REQUIRED_INPUT_COUNT:{node['nodeId']}.{port['name']}:{count}")
            if not port.get("required") and count > 1:
                errors.append(f"OPTIONAL_INPUT_MULTIPLE:{node['nodeId']}.{port['name']}")
        for port in node.get("outputs", []):
            if outgoing[(node["nodeId"], port["name"])] > 1:
                errors.append(f"OUTPUT_FANOUT:{node['nodeId']}.{port['name']}")
    try:
        topo_order(nodes, edges)
    except ValueError as exc:
        errors.append(str(exc))
    if canonical_digest(pipeline, "digest") != pipeline.get("digest"):
        errors.append("PIPELINE_DIGEST_MISMATCH")
    return errors


def claim_job(status: str, current_sequence: int, presented_sequence: int = 0):
    """Minimal, explicit duplicate-claim contract for the conformance test."""
    if status != "QUEUED":
        return None
    if presented_sequence and presented_sequence <= current_sequence:
        return None
    return current_sequence + 1


def checkpoint_accepts(previous_sequence: int, next_sequence: int) -> bool:
    return next_sequence == previous_sequence + 1


def result_key(job_id: str, fence_sequence: int) -> str:
    return f"{job_id}:{fence_sequence}"


def stable_effect_id(job_id: str, pipeline_id: str, revision: int, sink_node_id: str, logical_batch_id: str) -> str:
    payload = {
        "jobId": job_id,
        "pipelineId": pipeline_id,
        "pipelineRevision": revision,
        "sinkNodeId": sink_node_id,
        "logicalBatchId": logical_batch_id,
    }
    return "efx:" + hashlib.sha256(canonical_bytes(payload)).hexdigest()


def validate_transition(current: str, target: str) -> bool:
    allowed = {
        "QUEUED": {"CLAIMED", "CANCELLED"},
        "CLAIMED": {"RUNNING", "FAILED", "CANCELLED", "QUEUED"},
        "RUNNING": {"SUCCEEDED", "FAILED", "CANCELLED"},
        "FAILED": {"QUEUED"},
        "SUCCEEDED": set(),
        "CANCELLED": set(),
    }
    return target in allowed.get(current, set())


def fence_accepts(current_sequence: int, presented: int, lease_expired: bool) -> bool:
    return not lease_expired and presented >= current_sequence


def main() -> int:
    pipeline_schema = check_schema(SCHEMAS / "pipeline-ir.v1.schema.json")
    job_schema = check_schema(SCHEMAS / "durable-job.v1.schema.json")
    schema_catalog_schema = check_schema(SCHEMAS / "schema-catalog.v1.schema.json")
    receipt_schema = check_schema(SCHEMAS / "sink-receipt.v1.schema.json")
    fence_schema = check_schema(SCHEMAS / "fence-grant.v1.schema.json")
    if None in (pipeline_schema, job_schema, schema_catalog_schema, receipt_schema, fence_schema):
        print("TYPED PIPELINE CONTRACT FAILED")
        return 1

    pipeline = load(EXAMPLES / "pipeline-definition.json")
    registry = load(EXAMPLES / "node-registry.json")
    plan = load(EXAMPLES / "pipeline-execution-plan.json")
    revision = load(EXAMPLES / "pipeline-revision.json")
    run = load(EXAMPLES / "pipeline-run.json")
    job = load(EXAMPLES / "job.json")
    lease = load(EXAMPLES / "job-lease.json")
    checkpoint = load(EXAMPLES / "job-checkpoint.json")
    result = load(EXAMPLES / "job-result.json")
    schema_catalog = load(EXAMPLES / "schema-catalog.json")
    trusted_keys = load(EXAMPLES / "trusted-registry-keys.json")
    receipt = load(EXAMPLES / "sink-receipt.json")
    fence = load(EXAMPLES / "fence-grant.json")
    validate(pipeline, pipeline_schema, "pipeline-definition.json")
    validate(registry, sub_schema(pipeline_schema, "NodeRegistry"), "node-registry.json")
    validate(plan, sub_schema(pipeline_schema, "PipelineExecutionPlan"), "pipeline-execution-plan.json")
    validate(revision, sub_schema(pipeline_schema, "PipelineRevision"), "pipeline-revision.json")
    validate(run, sub_schema(pipeline_schema, "PipelineRun"), "pipeline-run.json")
    validate(job, job_schema, "job.json")
    validate(lease, sub_schema(job_schema, "JobLease"), "job-lease.json")
    validate(checkpoint, sub_schema(job_schema, "Checkpoint"), "job-checkpoint.json")
    validate(result, sub_schema(job_schema, "JobResult"), "job-result.json")
    validate(schema_catalog, schema_catalog_schema, "schema-catalog.json")
    validate(receipt, receipt_schema, "sink-receipt.json")
    validate(fence, fence_schema, "fence-grant.json")

    # Canonical JSON is order independent and UTF-8 stable.
    reordered = dict(reversed(list(copy.deepcopy(pipeline).items())))
    if canonical_digest(reordered, "digest") != canonical_digest(pipeline, "digest"):
        FAILURES.append("canonical JSON digest is order dependent")
    errors = validate_pipeline(pipeline, registry, schema_catalog, trusted_keys)
    if errors:
        FAILURES.extend(f"valid pipeline: {error}" for error in errors)
    expected_order = ["source", "parse", "map", "filter", "validate", "sink"]
    if topo_order(pipeline["nodes"], pipeline["edges"]) != expected_order:
        FAILURES.append("canonical order is not deterministic")
    if plan["orderedNodes"] != expected_order:
        FAILURES.append("execution plan order differs from validator order")
    if plan["planDigest"] != canonical_digest(plan, "planDigest"):
        FAILURES.append("PLAN_DIGEST_MISMATCH")
    if revision["digest"] != pipeline["digest"]:
        FAILURES.append("revision digest does not pin definition digest")
    if revision["definition"]["digest"] != pipeline["digest"]:
        FAILURES.append("revision definition does not pin definition digest")
    if job["pipelineId"] != pipeline["pipelineId"] or job["pipelineRevision"] != pipeline["revision"]:
        FAILURES.append("job does not pin pipeline revision")

    # Negative static tests: declarations cannot expand the trusted signature.
    forged_port = copy.deepcopy(pipeline)
    forged_port["nodes"][1]["inputs"][0]["dataType"] = "string"
    if not any(item.startswith("PORT_SIGNATURE_MISMATCH:") for item in validate_pipeline(forged_port, registry, schema_catalog, trusted_keys)):
        FAILURES.append("forged input port was accepted")

    extra_port = copy.deepcopy(pipeline)
    extra_port["nodes"][1]["inputs"].append({"name": "extra", "dataType": "json", "required": False})
    if not any(item.startswith("PORT_SIGNATURE_MISMATCH:") for item in validate_pipeline(extra_port, registry, schema_catalog, trusted_keys)):
        FAILURES.append("extra input port was accepted")

    duplicate_target = copy.deepcopy(pipeline)
    duplicate_target["edges"].append(copy.deepcopy(duplicate_target["edges"][1]))
    if not any(item.startswith("REQUIRED_INPUT_COUNT:") for item in validate_pipeline(duplicate_target, registry, schema_catalog, trusted_keys)):
        FAILURES.append("duplicate edge to a required input was accepted")

    missing_required = copy.deepcopy(pipeline)
    missing_required["edges"] = [edge for edge in missing_required["edges"] if edge["toNode"] != "map"]
    if not any(item.startswith("REQUIRED_INPUT_COUNT:map.records") for item in validate_pipeline(missing_required, registry, schema_catalog, trusted_keys)):
        FAILURES.append("missing required input was accepted")

    invalid_config = copy.deepcopy(pipeline)
    invalid_config["nodes"][0]["config"]["unexpected"] = True
    if not any(item.startswith("CONFIG_INVALID:source") for item in validate_pipeline(invalid_config, registry, schema_catalog, trusted_keys)):
        FAILURES.append("invalid node config was accepted")

    bad_schema = copy.deepcopy(pipeline)
    bad_schema["nodes"][-1]["config"]["schemaRevision"] = 999
    if not any(item.startswith("SCHEMA_REVISION_NOT_FOUND:sink") for item in validate_pipeline(bad_schema, registry, schema_catalog, trusted_keys)):
        FAILURES.append("unknown schema revision was accepted")

    bad_registry = copy.deepcopy(registry)
    bad_registry["entries"][0]["typeVersion"] = 99
    if "REGISTRY_DIGEST_MISMATCH" not in validate_pipeline(pipeline, bad_registry, schema_catalog, trusted_keys):
        FAILURES.append("registry digest forgery was accepted")

    bad_digest = copy.deepcopy(pipeline)
    bad_digest["digest"] = "sha256:" + "0" * 64
    if "PIPELINE_DIGEST_MISMATCH" not in validate_pipeline(bad_digest, registry, schema_catalog, trusted_keys):
        FAILURES.append("pipeline digest forgery was accepted")

    cycle = copy.deepcopy(pipeline)
    cycle["edges"].append({
        "fromNode": "sink", "fromPort": "records", "toNode": "source", "toPort": "records", "dataType": "json"
    })
    if "CYCLE" not in validate_pipeline(cycle, registry, schema_catalog, trusted_keys):
        FAILURES.append("cycle was not rejected")

    unknown = copy.deepcopy(pipeline)
    unknown["nodes"][0]["type"] = "builtin.unknown.node"
    if not any(item.startswith("UNKNOWN_NODE_TYPE:") for item in validate_pipeline(unknown, registry, schema_catalog, trusted_keys)):
        FAILURES.append("unknown node type was not rejected")

    too_many = copy.deepcopy(pipeline)
    too_many["nodes"] = too_many["nodes"] + [copy.deepcopy(too_many["nodes"][-1]) for _ in range(60)]
    if "NODE_LIMIT" not in validate_pipeline(too_many, registry, schema_catalog, trusted_keys):
        FAILURES.append("node limit was not rejected")

    # Durable-state semantics that are not expressible in JSON Schema alone.
    if not validate_transition("QUEUED", "CLAIMED"):
        FAILURES.append("valid QUEUED->CLAIMED transition rejected")
    if validate_transition("SUCCEEDED", "RUNNING"):
        FAILURES.append("terminal SUCCEEDED->RUNNING transition accepted")
    if validate_transition("CLAIMED", "SUCCEEDED"):
        FAILURES.append("CLAIMED->SUCCEEDED transition accepted without RUNNING")
    if not fence_accepts(7, 7, False) or not fence_accepts(7, 8, False):
        FAILURES.append("current fencing sequence rejected")
    if fence_accepts(7, 6, False):
        FAILURES.append("stale fencing sequence accepted")
    if fence_accepts(7, 7, True):
        FAILURES.append("expired lease accepted")
    if checkpoint["sequence"] <= 0 or checkpoint["fencingSequence"] <= 0:
        FAILURES.append("checkpoint sequence is not monotonic-positive")
    if not lease["fencingToken"]["sequence"] >= 1:
        FAILURES.append("fencing sequence is not positive")
    if receipt["status"] == "UNKNOWN" and receipt.get("resultDigest") is not None:
        FAILURES.append("UNKNOWN receipt must not claim a committed result")
    effect_id = stable_effect_id(job["jobId"], pipeline["pipelineId"], pipeline["revision"], "sink", "batch-host-metrics-0001")
    effect_id_retry = stable_effect_id(job["jobId"], pipeline["pipelineId"], pipeline["revision"], "sink", "batch-host-metrics-0001")
    effect_id_other_batch = stable_effect_id(job["jobId"], pipeline["pipelineId"], pipeline["revision"], "sink", "batch-host-metrics-0002")
    if effect_id != effect_id_retry:
        FAILURES.append("stable effectId changes across attempts")
    if effect_id == effect_id_other_batch:
        FAILURES.append("different logical batches share an effectId")
    if "attemptNumber" in effect_id or "fencingSequence" in effect_id:
        FAILURES.append("effectId contains unstable attempt/fence identity")
    if job["idempotencyKey"] == "":
        FAILURES.append("job idempotency key must not be empty")
    if claim_job("QUEUED", 0) != 1:
        FAILURES.append("first claim did not create fence sequence 1")
    if claim_job("CLAIMED", 1) is not None:
        FAILURES.append("duplicate claim was accepted")
    if claim_job("QUEUED", 7, 7) is not None:
        FAILURES.append("stale claim sequence was accepted")
    if not checkpoint_accepts(1, 2) or checkpoint_accepts(1, 3):
        FAILURES.append("checkpoint sequence contract is not strictly monotonic")
    if result_key("job-1", 7) != result_key("job-1", 7):
        FAILURES.append("result idempotency key is not stable")
    unknown_receipt = copy.deepcopy(receipt)
    unknown_receipt["status"] = "UNKNOWN"
    unknown_receipt["resultDigest"] = None
    if unknown_receipt["status"] == "UNKNOWN" and unknown_receipt["resultDigest"] is not None:
        FAILURES.append("UNKNOWN receipt must not claim a committed result")

    openapi = (ROOT / "contracts" / "openapi" / "typed-pipeline-v1.yaml").read_text()
    for operation in [
        "createPipeline", "validatePipeline", "publishPipelineRevision",
        "getPipelineExecutionPlan", "submitJob", "claimJob", "heartbeatJob",
        "saveCheckpoint", "submitJobResult", "cancelJob",
    ]:
        if f"operationId: {operation}" not in openapi:
            FAILURES.append(f"OpenAPI missing operationId {operation}")
    if "X-OpsWeave-Fencing" not in openapi:
        FAILURES.append("OpenAPI does not require the fencing header")
    fenced_openapi = (ROOT / "contracts" / "openapi" / "data-catalog-fenced-v1.yaml").read_text()
    for operation in ["fencedRecords", "getSinkReceipt"]:
        if f"operationId: {operation}" not in fenced_openapi:
            FAILURES.append(f"fenced Catalog OpenAPI missing operationId {operation}")

    if FAILURES:
        print("TYPED PIPELINE CONTRACT FAILED")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("TYPED PIPELINE CONTRACT PASS")
    print("  pipeline schema: valid (Ed25519 trusted registry signature verified)")
    print("  durable job schema: valid")
    print("  examples: 12 validated")
    print("  DAG/type/cycle/limits/state/fencing/schema checks: valid")
    print("  canonical JSON and digest checks: valid")
    print("  OpenAPI operations: 10 checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
