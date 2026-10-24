#!/usr/bin/env python3
"""Real HTTP/PostgreSQL claim concurrency check (no database shortcuts)."""
import concurrent.futures, json, os, subprocess, sys, urllib.error, urllib.request, uuid
URL = os.environ.get("OPSWEAVE_URL", "http://127.0.0.1:18181")
DB = os.environ.get("OPSWEAVE_TEST_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/opsweave")
TOKEN = json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"]
PIPELINE = "two-node-bulk"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def request(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("authorization", f"Bearer {TOKEN}")
    if data is not None: req.add_header("content-type", "application/json")
    for key, value in (headers or {}).items(): req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try: payload = json.loads(error.read() or b"{}")
        except Exception: payload = {}
        return error.code, payload

def psql(query):
    return subprocess.run(["psql", DB, "-qAt", "-c", query], check=True, capture_output=True, text=True).stdout.strip()

def worker_identity(instance_id, boot_id):
    identity = json.load(open(os.path.join(ROOT, "data-ci/node-a/node-identity.json")))
    generation = next(n["generation"] for n in request("GET", "/api/v1/nodes")[1] if n["id"] == identity["nodeId"])
    worker_id = f"n:{identity['nodeId']}:i:{instance_id}:b:{boot_id}"
    headers = {"authorization": f"Bearer {identity['credential']}", "x-opsweave-node-id": identity["nodeId"], "x-opsweave-instance-id": instance_id, "x-opsweave-node-generation": str(generation), "x-opsweave-boot-id": boot_id, "x-opsweave-worker-id": worker_id}
    body = {"workerId": worker_id, "nodeId": identity["nodeId"], "instanceId": instance_id, "bootId": boot_id, "version": "0.0.3"}
    return headers, body

def instance_id():
    data = request("GET", "/api/v1/plugins/opsweave.data-catalog")[1]
    return next(i["id"] for d in data["deployments"] for i in d["instances"] if i["state"] == "READY")

def submit(index):
    status, body = request("POST", "/api/v1/jobs", {"pipelineId": PIPELINE, "pipelineRevision": 1, "input": {}, "maxAttempts": 3, "timeoutSeconds": 300}, {"idempotency-key": f"claim-concurrency-{index}-{uuid.uuid4()}"})
    assert status == 201, (status, body)
    return body["jobId"]

def main():
    iid = instance_id(); failures = []
    for concurrency in (2, 8, 16, 32):
        job = submit(f"{concurrency}")
        identities = [worker_identity(iid, str(uuid.uuid4())) for _ in range(concurrency)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            results = list(pool.map(lambda pair: request("POST", f"/internal/v1/pipeline-jobs/{job}/claim", pair[1], pair[0]), identities))
        statuses = [status for status, _ in results]
        if statuses.count(200) != 1: failures.append(f"{concurrency}: expected one claim, got {statuses}")
        active = int(psql(f"SELECT count(*) FROM kernel.pipeline_job_leases WHERE job_id='{job}' AND status='ACTIVE';"))
        fences = psql(f"SELECT count(*) || ':' || COALESCE(max(fencing_sequence),0) FROM kernel.pipeline_job_leases WHERE job_id='{job}';")
        if active != 1: failures.append(f"{concurrency}: active leases={active}")
        if fences != "1:1": failures.append(f"{concurrency}: lease/fence={fences}")
        print(f"claim concurrency {concurrency}: statuses={statuses.count(200)}x200 active={active} leaseFence={fences}")
    jobs = [submit(f"multi-{i}") for i in range(8)]
    identities = [worker_identity(iid, str(uuid.uuid4())) for _ in range(8)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda pair: request("POST", f"/internal/v1/pipeline-jobs/{pair[0]}/claim", pair[1][1], pair[1][0]), zip(jobs, identities)))
    if any(status != 200 for status, _ in results): failures.append(f"multi-job claims were {[s for s,_ in results]}")
    assigned = psql(f"SELECT count(DISTINCT current_lease_id) FROM kernel.pipeline_jobs WHERE job_id IN ({','.join(chr(39)+j+chr(39) for j in jobs)});")
    if assigned != "8": failures.append(f"multi-job distinct leases={assigned}")
    print(f"multi-job claim: {assigned} distinct leases across 8 jobs")
    # Claim-Next concurrency: one queued Job must yield exactly one claim.
    next_job = submit("claim-next-single")
    identities = [worker_identity(iid, str(uuid.uuid4())) for _ in range(8)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda pair: request("POST", "/internal/v1/pipeline-jobs/claim-next", pair[1], pair[0]), identities))
    single_statuses = [status for status, _ in results]
    if single_statuses.count(200) != 1 or any(s not in (200, 204) for s in single_statuses):
        failures.append(f"claim-next single statuses={single_statuses}")
    if psql(f"SELECT status FROM kernel.pipeline_jobs WHERE job_id='{next_job}';") != "CLAIMED":
        failures.append("claim-next single job was not claimed")
    # Claim-Next with several queued Jobs must distribute them exactly once.
    next_jobs = [submit(f"claim-next-{i}") for i in range(8)]
    claimed = []
    statuses = []
    for attempt in range(3):
        next_identities = [worker_identity(iid, str(uuid.uuid4())) for _ in range(8)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda pair: request("POST", "/internal/v1/pipeline-jobs/claim-next", pair[1][1], pair[1][0]), zip(next_jobs, next_identities)))
        statuses.extend(status for status, _ in results)
        for status, body in results:
            if status == 200 and body.get("jobId"):
                claimed.append(body["jobId"])
        claimed = list(dict.fromkeys(claimed))
        if len(claimed) == 8:
            break
    claimed_status = psql(f"SELECT count(*) FROM kernel.pipeline_jobs WHERE job_id IN ({','.join(chr(39)+j+chr(39) for j in next_jobs)}) AND status='CLAIMED';")
    if len(set(claimed)) != 8 or claimed_status != "8":
        failures.append(f"claim-next multi statuses={statuses} jobs={claimed} claimed={claimed_status}")
    print(f"claim-next: single={single_statuses.count(200)}x200 multi={len(set(claimed))} distinct")
    # True /claim-next fan-out at 2/8/16/32 workers.
    for concurrency in (2, 8, 16, 32):
        jobs = [submit(f"claim-next-fanout-{concurrency}-{i}") for i in range(concurrency)]
        identities = [worker_identity(iid, str(uuid.uuid4())) for _ in range(concurrency)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            results = list(pool.map(lambda pair: request("POST", "/internal/v1/pipeline-jobs/claim-next", pair[1], pair[0]), identities))
        statuses = [status for status, _ in results]
        assigned = [body.get("jobId") for status, body in results if status == 200]
        db_assigned = psql(f"SELECT count(DISTINCT current_lease_id) FROM kernel.pipeline_jobs WHERE job_id IN ({','.join(chr(39)+j+chr(39) for j in jobs)});")
        if statuses.count(200) != concurrency or len(set(assigned)) != concurrency or db_assigned != str(concurrency):
            failures.append(f"claim-next fanout {concurrency}: statuses={statuses} assigned={assigned} db={db_assigned}")
        print(f"claim-next fanout {concurrency}: {statuses.count(200)}x200 distinct={len(set(assigned))} dbLeases={db_assigned}")
    empty_identity = worker_identity(iid, str(uuid.uuid4()))
    empty = request("POST", "/internal/v1/pipeline-jobs/claim-next", empty_identity[1], empty_identity[0])
    if empty[0] != 204:
        failures.append(f"empty claim-next returned {empty[0]}")
    print(f"claim-next empty queue: status={empty[0]}")
    if failures:
        print("\n".join("FAIL " + failure for failure in failures)); return 1
    print("Claim Concurrency Golden Path: PASS"); return 0

if __name__ == "__main__": sys.exit(main())
