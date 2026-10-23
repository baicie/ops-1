#!/usr/bin/env python3
"""Contract + semantic conformance checks for the 0.0.3 design draft.

This is intentionally not a pipeline executor. It proves the contract files are
valid and that the required static semantics are unambiguous before any runtime
implementation is allowed past Gate 0.0.3.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "contracts" / "schema"
EXAMPLES = ROOT / "contracts" / "examples"
FAILURES: list[str] = []


def load(path: Path):
    with path.open() as handle:
        return json.load(handle)


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
        jsonschema.Draft202012Validator(schema).iter_errors(document),
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


def validate_pipeline(pipeline: dict, registry: dict) -> list[str]:
    errors: list[str] = []
    nodes = pipeline.get("nodes", [])
    edges = pipeline.get("edges", [])
    if not 1 <= len(nodes) <= 64:
        errors.append("NODE_LIMIT")
    if len(edges) > 128:
        errors.append("EDGE_LIMIT")
    registry_by_type = {
        (entry["type"], entry["typeVersion"]): entry for entry in registry.get("entries", [])
    }
    node_by_id: dict[str, dict] = {}
    for node in nodes:
        if node["nodeId"] in node_by_id:
            errors.append(f"DUPLICATE_NODE:{node['nodeId']}")
        node_by_id[node["nodeId"]] = node
        if (node["type"], node["typeVersion"]) not in registry_by_type:
            errors.append(f"UNKNOWN_NODE_TYPE:{node['nodeId']}")
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
    for node in nodes:
        for port in node.get("inputs", []):
            if port.get("required") and not any(
                edge["toNode"] == node["nodeId"] and edge["toPort"] == port["name"] for edge in edges
            ):
                errors.append(f"REQUIRED_INPUT_MISSING:{node['nodeId']}.{port['name']}")
    try:
        topo_order(nodes, edges)
    except ValueError as exc:
        errors.append(str(exc))
    return errors


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


def main() -> int:
    pipeline_schema = check_schema(SCHEMAS / "pipeline-ir.v1.schema.json")
    job_schema = check_schema(SCHEMAS / "durable-job.v1.schema.json")
    if pipeline_schema is None or job_schema is None:
        print("TYPED PIPELINE CONTRACT FAILED")
        return 1
    pipeline = load(EXAMPLES / "pipeline-definition.json")
    registry = load(EXAMPLES / "node-registry.json")
    plan = load(EXAMPLES / "pipeline-execution-plan.json")
    job = load(EXAMPLES / "job.json")
    lease = load(EXAMPLES / "job-lease.json")
    revision = load(EXAMPLES / "pipeline-revision.json")
    run = load(EXAMPLES / "pipeline-run.json")
    checkpoint = load(EXAMPLES / "job-checkpoint.json")
    result = load(EXAMPLES / "job-result.json")
    validate(pipeline, pipeline_schema, "pipeline-definition.json")
    validate(registry, sub_schema(pipeline_schema, "NodeRegistry"), "node-registry.json")
    validate(plan, sub_schema(pipeline_schema, "PipelineExecutionPlan"), "pipeline-execution-plan.json")
    validate(job, job_schema, "job.json")
    validate(lease, sub_schema(job_schema, "JobLease"), "job-lease.json")
    validate(revision, sub_schema(pipeline_schema, "PipelineRevision"), "pipeline-revision.json")
    validate(run, sub_schema(pipeline_schema, "PipelineRun"), "pipeline-run.json")
    validate(checkpoint, sub_schema(job_schema, "Checkpoint"), "job-checkpoint.json")
    validate(result, sub_schema(job_schema, "JobResult"), "job-result.json")

    errors = validate_pipeline(pipeline, registry)
    if errors:
        FAILURES.extend(f"valid pipeline: {error}" for error in errors)
    if topo_order(pipeline["nodes"], pipeline["edges"]) != [
        "source", "parse", "map", "filter", "validate", "sink"
    ]:
        FAILURES.append("canonical order is not deterministic")

    # Negative semantics: each mutation must be rejected, not accepted as a
    # weaker pipeline.
    type_mismatch = json.loads(json.dumps(pipeline))
    type_mismatch["edges"][1]["dataType"] = "string"
    if "TYPE_MISMATCH:parse->map" not in validate_pipeline(type_mismatch, registry):
        FAILURES.append("type mismatch was not rejected")

    cycle = json.loads(json.dumps(pipeline))
    cycle["edges"].append({
        "fromNode": "sink", "fromPort": "records", "toNode": "source", "toPort": "records", "dataType": "json"
    })
    if "CYCLE" not in validate_pipeline(cycle, registry):
        FAILURES.append("cycle was not rejected")

    unknown = json.loads(json.dumps(pipeline))
    unknown["nodes"][0]["type"] = "builtin.unknown.node"
    if not any(error.startswith("UNKNOWN_NODE_TYPE:") for error in validate_pipeline(unknown, registry)):
        FAILURES.append("unknown node type was not rejected")

    too_many = json.loads(json.dumps(pipeline))
    too_many["nodes"] = too_many["nodes"] + [too_many["nodes"][-1].copy() for _ in range(60)]
    if "NODE_LIMIT" not in validate_pipeline(too_many, registry):
        FAILURES.append("node limit was not rejected")

    if not validate_transition("QUEUED", "CLAIMED"):
        FAILURES.append("valid QUEUED->CLAIMED transition rejected")
    if validate_transition("SUCCEEDED", "RUNNING"):
        FAILURES.append("terminal SUCCEEDED->RUNNING transition accepted")
    if validate_transition("CLAIMED", "SUCCEEDED"):
        FAILURES.append("CLAIMED->SUCCEEDED transition accepted without RUNNING")
    if not (1 <= lease["fencingToken"]["sequence"]):
        FAILURES.append("fencing sequence is not positive")
    if lease["fencingToken"]["sequence"] <= 1:
        FAILURES.append("stale fencing token fixture is not stale")

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

    if FAILURES:
        print("TYPED PIPELINE CONTRACT FAILED")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("TYPED PIPELINE CONTRACT PASS")
    print("  pipeline schema: valid")
    print("  durable job schema: valid")
    print("  examples: 9 validated")
    print("  DAG/type/cycle/limits/state/fencing checks: valid")
    print("  OpenAPI operations: 10 checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
