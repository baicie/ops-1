#!/usr/bin/env python3
"""Real PostgreSQL/HTTP publish concurrency: no 500, no double publish."""
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = sys.argv[1]
TOKEN = sys.argv[2]
PIPE = "host-metrics-pipeline"
HEADERS = {"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}


def call(method, path, body=None, headers=None):
    merged = dict(HEADERS)
    if headers:
        merged.update(headers)
    req = urllib.request.Request(
        URL + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=merged,
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            payload = {"raw": raw.decode(errors="replace")}
        return error.code, payload


def draft():
    status, payload = call("POST", f"/api/v1/pipelines/{PIPE}/drafts", {})
    assert status == 201, (status, payload)
    return payload["draftId"]


def publish(draft_id, key):
    return call(
        "POST",
        f"/api/v1/pipelines/{PIPE}/drafts/{draft_id}/publish",
        {},
        {"idempotency-key": key, "if-match": "1"},
    )


status, before = call("GET", f"/api/v1/pipelines/{PIPE}")
assert status == 200
before_rev = before["latestRevision"]
before_count = len(before["revisions"])

# 8 concurrent publishes across two drafts with the SAME key.
d1, d2 = draft(), draft()
key = f"race-same-key-{os.getpid()}"
with ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(lambda i: publish(d1 if i % 2 == 0 else d2, key), range(8)))
codes = [code for code, _ in results]
assert 500 not in codes, results
assert codes.count(200) == 1, results
assert all(code in (200, 409) for code in codes), results

status, after = call("GET", f"/api/v1/pipelines/{PIPE}")
assert after["latestRevision"] == before_rev + 1, (before_rev, after["latestRevision"])
assert len(after["revisions"]) == before_count + 1
assert all(
    item["code"] == "IDEMPOTENCY_CONFLICT"
    for code, item in results
    if code == 409
)

# 8 concurrent publishes of the SAME draft with DIFFERENT keys: one revision.
d3 = draft()
with ThreadPoolExecutor(max_workers=8) as pool:
    results2 = list(pool.map(lambda i: publish(d3, f"race-diff-{i}-{os.getpid()}"), range(8)))
codes2 = [code for code, _ in results2]
assert 500 not in codes2, results2
assert codes2.count(200) == 1, results2
assert all(code in (200, 409) for code in codes2), results2
status, final = call("GET", f"/api/v1/pipelines/{PIPE}")
assert final["latestRevision"] == before_rev + 2, final["latestRevision"]
assert len(final["revisions"]) == before_count + 2

# Lost-response replay uses the same draft, key and revision.
winning_index = codes.index(200)
winner = results[winning_index][1]
winning_draft = d1 if winning_index % 2 == 0 else d2
replay_status, replay = publish(winning_draft, key)
assert replay_status == 200, (replay_status, replay)
assert replay["revision"] == winner["revision"]

print(f"PASS publish concurrency same-key-8={codes} diff-key-8={codes2} revisions={final['latestRevision']}")
print("Publish Concurrency: PASS")
