#!/usr/bin/env python3
"""Prove Catalog fence authorization and Claim serialize on the Job row lock."""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request, uuid
URL=os.environ.get("OPSWEAVE_URL","http://127.0.0.1:18181")
DB=os.environ.get("OPSWEAVE_TEST_DATABASE_URL","postgres://postgres:postgres@127.0.0.1:5432/opsweave")
TOKEN=json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"]
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
DATASET="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PIPELINE="two-node-bulk"

def request(method,path,body=None,headers=None,timeout=20):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(URL+path,data=data,method=method)
    req.add_header("authorization",f"Bearer {TOKEN}")
    if data: req.add_header("content-type","application/json")
    for k,v in (headers or {}).items(): req.add_header(k,v)
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r: return r.status,json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: body=json.loads(e.read() or b"{}")
        except Exception: body={}
        return e.code,body

def psql(q):
    return subprocess.run(["psql",DB,"-qAt","-c",q],check=True,capture_output=True,text=True).stdout.strip()

def worker(instance,boot):
    ident=json.load(open(os.path.join(ROOT,"data-ci/node-a/node-identity.json")))
    gen=next(n["generation"] for n in request("GET","/api/v1/nodes")[1] if n["id"]==ident["nodeId"])
    wid=f"n:{ident['nodeId']}:i:{instance}:b:{boot}"
    headers={"authorization":f"Bearer {ident['credential']}","x-opsweave-node-id":ident["nodeId"],"x-opsweave-instance-id":instance,"x-opsweave-node-generation":str(gen),"x-opsweave-boot-id":boot,"x-opsweave-worker-id":wid}
    body={"workerId":wid,"nodeId":ident["nodeId"],"instanceId":instance,"bootId":boot,"version":"0.0.3"}
    return headers,body

def instance_id():
    data=request("GET","/api/v1/plugins/opsweave.data-catalog")[1]
    return next(i["id"] for d in data["deployments"] for i in d["instances"] if i["state"]=="READY")

def submit():
    status,body=request("POST","/api/v1/jobs",{"pipelineId":PIPELINE,"pipelineRevision":1,"input":{},"maxAttempts":2,"timeoutSeconds":300},{"idempotency-key":f"lock-{uuid.uuid4()}"})
    assert status==201,(status,body)
    return body["jobId"]

def hold_fence(job,lease,fence,appname):
    env=os.environ.copy(); env["PGAPPNAME"]=appname
    proc=subprocess.Popen(["psql",DB,"-qAt"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    proc.stdin.write("BEGIN;\nSELECT authorized FROM kernel.fence_authorize_effect('%s','%s',%d,'sink','%s',1);\n"%(job,lease,fence,DATASET))
    proc.stdin.flush()
    return proc

def wait_pid(appname):
    for _ in range(100):
        pid=psql(f"SELECT pid FROM pg_stat_activity WHERE application_name='{appname}' AND state='idle in transaction';")
        if pid: return int(pid)
        time.sleep(0.1)
    raise RuntimeError("lock session did not become idle in transaction")

def main():
    iid=instance_id(); failures=[]
    for mode in ("commit","rollback"):
        job=submit()
        headers,body=worker(iid,str(uuid.uuid4()))
        status,claim=request("POST",f"/internal/v1/pipeline-jobs/{job}/claim",body,headers)
        if status!=200: failures.append(f"{mode}: initial claim {status}"); continue
        lease=claim["leaseId"]; fence=claim["fencingSequence"]
        appname=f"opsweave-lock-{mode}-{uuid.uuid4()}"
        proc=hold_fence(job,lease,fence,appname)
        try:
            pid=wait_pid(appname)
            headers2,body2=worker(iid,str(uuid.uuid4()))
            result={}
            def claim_b():
                result["value"]=request("POST",f"/internal/v1/pipeline-jobs/{job}/claim",body2,headers2,timeout=30)
            thread=threading.Thread(target=claim_b); thread.start()
            blocked=0; blockers=[]
            for _ in range(50):
                rows=psql(f"SELECT count(*) FROM pg_stat_activity a WHERE a.pid <> {pid} AND {pid} = ANY(pg_blocking_pids(a.pid));")
                if int(rows or 0)>0:
                    blocked=int(rows); blockers=psql(f"SELECT string_agg(pid::text,',') FROM pg_stat_activity a WHERE {pid}=ANY(pg_blocking_pids(a.pid));"); break
                time.sleep(0.1)
            if blocked<1: failures.append(f"{mode}: no pg_blocking_pids wait observed")
            if mode=="commit": proc.stdin.write("COMMIT;\n")
            else: proc.stdin.write("ROLLBACK;\n")
            proc.stdin.flush(); thread.join(timeout=20)
            if thread.is_alive(): failures.append(f"{mode}: claim still blocked")
            status_after,_=result.get("value",(0,{}))
            if status_after!=409: failures.append(f"{mode}: claim after lock release={status_after}, expected 409")
            print(f"catalog lock {mode}: holder={pid} blocked={blocked} blockers={blockers} claim={status_after}")
        finally:
            try: proc.stdin.write("ROLLBACK;\n"); proc.stdin.close()
            except Exception: pass
            proc.wait(timeout=10)
    if failures:
        for f in failures: print("FAIL "+f)
        return 1
    print("Catalog Lock Race Golden Path: PASS"); return 0

if __name__=="__main__": sys.exit(main())
