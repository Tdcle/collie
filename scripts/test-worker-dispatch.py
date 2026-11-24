"""Run against a locally built Collie. The Hub, node, CLI, DB and HTTP tunnel are real.
A Unix socket fixture controls terminal timing. All network listeners are loopback."""
import json, os, pathlib, re, socketserver, sqlite3, subprocess, sys, tempfile, threading, time, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(tempfile.mkdtemp(prefix="collie-state-", dir="/tmp"))
binary = str(pathlib.Path(sys.argv[1]).resolve())
print("run directory", root, flush=True)
processes = []
def wait(check, seconds=22):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.22)
    raise AssertionError("timed out waiting for " + str(check))

def environment(name):
    home = root / name
    tools = home / "bin"
    tools.mkdir(parents=True)
    for exe in ("codex","claude","agy","gemini"):
        path = tools / exe
        path.write_text("#!/bin/sh\nexit 1\n")
        path.chmod(0o755)
    (home/".codex").mkdir()
    (home/".codex/auth.json").write_text('{"OPENAI_API_KEY":"fixture"}')
    return dict(HOME=str(home), PATH=str(tools)+":/usr/bin:/bin", COLLIE_HOME=str(home/".collie"),
                HERDR_SOCKET_PATH=str(home/"herdr.sock"), SHELL="/bin/sh", TERM="xterm")

local, remote = environment("hub"), environment("node")
def run(env,*args):
    return subprocess.run([binary,*args],env=env,cwd=env["HOME"],text=True,capture_output=True,timeout=35)
def start(env,*args):
    exe = str(pathlib.Path(sys.argv[2]).resolve()) if env == remote and len(sys.argv)>2 else binary
    with open(root/(pathlib.Path(env["HOME"]).name+".log"),"a") as f:
        proc = subprocess.Popen([exe,*args],env=env,cwd=env["HOME"],stdout=f,stderr=f)
    processes.append(proc)
    return proc
data=pathlib.Path(local["COLLIE_HOME"])
def api(path, body=None):
    req=urllib.request.Request("http://"+(data/"addr").read_text().strip()+"/api/"+path,
        headers={"Authorization":"Bearer "+(data/"token").read_text().strip(),"Content-Type":"application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.load(urllib.request.urlopen(req,timeout=8))

class Terminal(socketserver.StreamRequestHandler):
    def handle(self):
        req=json.loads(self.rfile.readline())
        try:
            result=self.server.fixture.call(req["method"],req["params"])
            answer={"result":result}
        except ValueError as e: answer={"error":{"code":"launch_name_error","message":str(e)}}
        self.wfile.write((json.dumps(dict(id=req["id"],**answer))+"\n").encode())
class Socket(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True

class Herdr:
    def __init__(self,env):
        self.home=pathlib.Path(env["HOME"])
        self.agents={}; self.labels={}; self.prompts={}; self.screens={}
        self.fail=False; self.router_prompts=[]
        self.socket=Socket(env["HERDR_SOCKET_PATH"],Terminal); self.socket.fixture=self
        threading.Thread(target=self.socket.serve_forever,daemon=True).start()
    def add(self,pane,name,kind):
        id=str(uuid.uuid4())
        folder=self.home/".codex/sessions/2026/11/24"
        folder.mkdir(parents=True,exist_ok=True)
        path=folder/("rollout-"+id+".jsonl")
        path.touch()
        self.agents[pane]=dict(name=name,pane_id=pane,workspace_id=pane.split(":")[0],agent=kind,
            agent_status="done",cwd=str(self.home),interactive_ready=True,agent_session=dict(kind="path",value=str(path)))
        self.screens[pane]="OpenAI Codex\n⣿⣿⣿ WELCOME ⣿⣿⣿\n› Ask Codex to do anything"
    def call(self,m,p):
        if m=="workspace.create":
            ws="w"+str(len(self.labels)+1); self.labels[ws]=p["label"]
            return {"workspace":{"workspace_id":ws},"root_pane":{"pane_id":ws+":p1"}}
        if m=="agent.start":
            if self.fail: raise ValueError("simulated CLI launch failure")
            self.add(p["pane_id"],p["name"],p["kind"])
        if m=="workspace.list": return {"workspaces":[{"workspace_id":k,"label":v} for k,v in self.labels.items()]}
        if m in ("pane.list","agent.list"): return {m.split(".")[0]+"s": list(self.agents.values())}
        if m=="agent.get": return {"agent":self.agents.get(p["target"],{})}
        if m=="agent.prompt":
            pane=p["target"]; text=p["text"]
            self.prompts[pane]=text
            if self.agents[pane]["name"]=="collie":
                self.router_prompts.append(text)
                if "finished a turn." in text or "report from " in text:
                    # Simulated router sends the same user-facing reply a live router would.
                    api("super/reply",{"text":"E2E result relayed","thread":"chat:main"})
        if m=="pane.read": return {"read":{"text":self.screens.get(p["pane_id"],"")}}
        if m=="workspace.close":
            self.agents.pop(p["workspace_id"]+":p1",None)
        return {}
    def pane(self,name):
        return next((k for k,a in self.agents.items() if a["name"]==name),None)
    def message(self,pane,role,text,phase=None):
        entry={"type":"message","role":role,"content":[{"type":"input_text" if role=="user" else "output_text","text":text}]}
        if phase: entry["phase"]=phase
        path=self.agents[pane]["agent_session"]["value"]
        with open(path,"a") as f: f.write(json.dumps({"type":"response_item","payload":entry})+"\n")

posts=[]
class Webhook(BaseHTTPRequestHandler):
    def do_POST(self):
        posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(200);self.end_headers();self.wfile.write(b'{"code":0}')
    def log_message(self,*args): pass
def notices():
    return sum("E2E result relayed" in json.dumps(post) for post in posts)

def listing(): return run(local,"list").stdout.split("projects (")[0]
def show(name): return run(local,"show",name).stdout
def start_hub():
    proc=start(local,"serve","--addr","127.0.0.1:0")
    wait(lambda:(data/"addr").exists())
    return proc
def stop(p):
    p.terminate();p.wait(12)
def events(name):
    return [e for e in api("super")["entries"] if e.get("ref")==name]
def done(name): return [e for e in events(name) if e["tone"]=="done"]
def spawn(name,machine):
    r=run(local,"spawn","--name",name,"--kind","codex","--machine",machine,"--cwd","~","return fixture result")
    return r
def machine_line(machine):
    return next((line for line in listing().splitlines() if line.strip().startswith(machine+" ")),"")

try:
    hubterm,nodeterm=Herdr(local),Herdr(remote)
    hubterm.add("w0:p1","collie","codex")
    hook=ThreadingHTTPServer(("127.0.0.1",0),Webhook)
    threading.Thread(target=hook.serve_forever,daemon=True).start()
    hub=start_hub()
    addr=(data/"addr").read_text().strip()
    code=api("pair/new",{"kind":"machine"})["code"]
    node=start(remote,"node","--hub","http://"+addr,"--code",code,"--name","lab-node","--ui","off")
    wait(lambda:"lab-node" in listing())
    mid=json.loads((pathlib.Path(remote["COLLIE_HOME"])/"node.json").read_text())["id"]
    print("fresh machines\n"+listing(),flush=True)
    assert "codex:untried" in machine_line("hub") and "codex:untried" in machine_line(mid)
    stop(node); stop(hub)
    with sqlite3.connect(data/"herd.db") as db:
        for name,machine,kind,status,note in [
            ("old-win",mid,"claude","failed","legacy login failure"),
            ("old-mac","","codex","failed","old binary missing")]:
            w=dict(name=name,machine=machine,kind=kind,status=status,note=note,ended=True,
                   created_at="2026-01-02T03:04:05Z",thread="chat:main")
            db.execute("insert into workers values (?,?,?)",(name,1767323045,json.dumps(w)))
    hub=start_hub()
    node=start(remote,"node","--hub","http://"+(data/"addr").read_text().strip(),"--ui","off")
    wait(lambda:"online" in machine_line(mid))
    print("legacy history\n"+listing(),flush=True)
    assert "old binary missing" in machine_line("hub") and "legacy login failure" in machine_line(mid)
    settings=api("super/settings")["settings"]
    api("super/settings",{"settings":dict(settings,notify_webhook="http://127.0.0.1:%d/"%hook.server_port, notify_level="normal",dream_at="off")})
    nodeterm.fail=True
    r=spawn("retry",mid)
    assert r.returncode and "simulated CLI launch failure" in r.stderr,r
    assert "simulated CLI launch failure" in machine_line(mid)
    print("failed remote launch",machine_line(mid),flush=True)
    nodeterm.fail=False
    api("super/settings",{"settings":dict(api("super/settings")["settings"],paused=True)})
    r=spawn("retry",mid); assert r.returncode==0,r
    pane=wait(lambda:nodeterm.pane("retry"))
    for raw, expected in [("unknown","waiting"),("working","waiting"),("blocked","blocked"),("done","waiting")]:
        nodeterm.agents[pane]["agent_status"] = raw
        time.sleep(2)
        display = show("retry")
        worker_rows = run(local,"list").stdout.split("workers:\n",1)[1].split("sessions (",1)[0]
        assert "status: "+expected+" " in display,display
        assert re.search(r"^\s*retry\s+codex\s+"+expected+r"\s+thread=",worker_rows,re.M),worker_rows
        assert not nodeterm.prompts.get(pane) and not done("retry")
        print(f"queued raw={raw}, show/list={expected}, completions=0",flush=True)
    api("super/settings",{"settings":dict(api("super/settings")["settings"],paused=False)})
    brief=wait(lambda:nodeterm.prompts.get(pane))
    time.sleep(6) # outlast the original idle timeout
    assert "status: done" not in show("retry") and not done("retry") and not notices()
    nodeterm.message(pane,"user",'You are worker "retry", managed by Collie (an older dispatch).')
    nodeterm.message(pane,"assistant","previous reply","final_answer")
    time.sleep(2)
    assert not done("retry")
    nodeterm.message(pane,"user",brief)
    nodeterm.message(pane,"assistant","checking","commentary")
    time.sleep(2)
    assert not done("retry") and not notices()
    print("welcome / old result / commentary: 0 completions",flush=True)
    nodeterm.message(pane,"assistant","FAST REMOTE RESULT","final_answer")
    wait(lambda:done("retry"))
    wait(lambda:notices()==1,35)
    assert len(done("retry"))==1
    assert "codex:replied" in machine_line(mid) and "simulated CLI launch failure" not in machine_line(mid)
    assert "legacy login failure" in machine_line(mid)
    print("fast reply, working never sampled: 1 event, 1 router webhook",machine_line(mid),flush=True)
    r=spawn("explicit","hub");assert r.returncode==0,r
    lp=wait(lambda:hubterm.pane("explicit"))
    wait(lambda:hubterm.prompts.get(lp))
    hubterm.agents[lp]["agent_status"]="working"
    wait(lambda:"status: working" in show("explicit"))
    assert run(local,"report","--worker","explicit","EXPLICIT RESULT").returncode==0
    hubterm.agents[lp]["agent_status"]="done"
    wait(lambda:notices()==2,40)
    assert len(done("explicit"))==1 and "EXPLICIT RESULT" in done("explicit")[0]["text"]
    assert "old binary missing" not in machine_line("hub")
    print("explicit report: 1 event, 1 additional router webhook",machine_line("hub"),flush=True)
    r=spawn("modal",mid);assert r.returncode==0,r
    mp=wait(lambda:nodeterm.pane("modal"))
    wait(lambda:nodeterm.prompts.get(mp))
    nodeterm.agents[mp]["agent_status"]="blocked"
    nodeterm.screens[mp]="Allow this action?\n1. Yes\n2. No"
    wait(lambda:any(e["tone"]=="blocked" for e in events("modal")))
    assert not done("modal")
    print("modal: blocked event, 0 completions",flush=True)
    r=spawn("quota-stop","hub");assert r.returncode==0,r
    qp=wait(lambda:hubterm.pane("quota-stop"))
    wait(lambda:hubterm.prompts.get(qp))
    hubterm.screens[qp]="Error: usage limit reached"
    wait(lambda:"status: failed" in show("quota-stop"))
    assert not done("quota-stop")
    print("quota failure: 0 completions",machine_line("hub"),flush=True)
    assert notices()==2
    stop(node);stop(hub)
    hub=start_hub()
    wait(lambda:"offline" in machine_line(mid))
    assert "legacy login failure" in machine_line(mid) and "codex:blocked (modal " in machine_line(mid)
    print("restarted with node offline\n"+listing(),flush=True)
    print("PASS",flush=True)
finally:
    for proc in reversed(processes):
        if proc.poll() is None: stop(proc)
