#!/usr/bin/env python3
"""Process E2E on macOS/Linux: python3 scripts/test-send-receipts.py ./collie [old-collie]."""
import json
import os
import signal
import socketserver
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from contextlib import ExitStack
from pathlib import Path
from urllib.request import Request, urlopen


def until(check, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {check}")


def run(root, stack, binary, old):
    counts = Counter()
    release = threading.Event()
    transcript = root / "node/.claude/projects/test/e2e.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.touch()

    class LocalPeer(socketserver.StreamRequestHandler):
        def handle(self):
            data = json.loads(self.rfile.readline())
            if data.get("type") == "user":
                envelope = data["message"]["content"]
                text = envelope.split("\n\n")[-1].split("\n</")[0]
                assert data["session_id"] == "e2e"
                counts[text] += 1
                if text == "lost-external":
                    release.wait(10)
                if text != "no-transcript-ack":
                    with transcript.open("a") as f:
                        print(json.dumps({"type": "queue-operation", "content": envelope}), file=f)
                return

            method = data["method"]
            if method == "agent.prompt":
                text = data["params"]["text"]
                assert data["params"]["target"] == "w1:p1"
                counts[text] += 1
                if text in ("lost-pane", "crash-window"):
                    release.wait(15)
            result = {"workspace.list": {"workspaces": []}, "agent.list": {"agents": []},
                      "pane.list": {"panes": []}}.get(method, {})
            try:
                self.wfile.write(json.dumps({"id": data["id"], "result": result}).encode() + b"\n")
            except BrokenPipeError:
                pass

    class SocketServer(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    for filename in ("hub.sock", "node.sock", "peer.sock"):
        server = stack.enter_context(SocketServer(str(root / filename), LocalPeer))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.shutdown)

    # Advertise one isolated Codex App thread through its normal index and IPC.
    codex_home = root / "node/.codex"
    (codex_home / "ipc").mkdir(parents=True)
    with sqlite3.connect(codex_home / "state_5.sqlite") as db:
        db.execute("""CREATE TABLE threads (id, name, title, first_user_message, cwd, rollout_path,
                   created_at_ms, created_at, updated_at_ms, updated_at, originator, model,
                   reasoning_effort, archived, source)""")
        db.execute("""INSERT INTO threads VALUES ('e2e-codex', 'test', '', '', ?, '', NULL, unixepoch(),
                   NULL, unixepoch(), 'Codex Desktop', '', '', 0, 'vscode')""", (str(root),))

    class CodexApp(socketserver.StreamRequestHandler):
        def handle(self):
            while header := self.rfile.read(4):
                request = json.loads(self.rfile.read(struct.unpack("<I", header)[0]))
                reply = {"type": "response", "requestId": request["requestId"], "resultType": "success"}
                if request["method"] == "thread-owner-discovery":
                    reply["handledByClientId"] = "test-window"
                elif request["method"] in ("thread-follower-start-turn", "thread-follower-steer-turn"):
                    params = request["params"]
                    assert params["conversationId"] == "e2e-codex"
                    turn = params.get("turnStart") or params["turnSteer"]
                    text = turn["request"]["input"][0]["text"]
                    counts[text] += 1
                    if text == "codex-backend-lost":
                        return
                raw = json.dumps(reply).encode()
                self.wfile.write(struct.pack("<I", len(raw)) + raw)

    codex_app = stack.enter_context(SocketServer(str(codex_home / "ipc/ipc.sock"), CodexApp))
    threading.Thread(target=codex_app.serve_forever, daemon=True).start()
    stack.callback(codex_app.shutdown)

    # Hide all real terminal processes and use only a synthetic Claude registration.
    (root / "bin").mkdir()
    ps = root / "bin/ps"
    ps.write_text("#!/bin/sh\nexit 0\n")
    ps.chmod(0o700)
    reg = root / f"node/.claude/sessions/{os.getpid()}.json"
    reg.parent.mkdir()
    reg.write_text(json.dumps({"pid": os.getpid(), "sessionId": "e2e", "cwd": str(root),
                               "entrypoint": "claude-desktop", "peerProtocol": 1,
                               "messagingSocketPath": str(root / "peer.sock")}))

    def env(role):
        home = root / role
        home.mkdir(exist_ok=True)
        return {"HOME": str(home), "COLLIE_HOME": str(home / ".collie"),
                "PATH": f"{root}/bin:/usr/bin:/bin", "TMPDIR": str(root)}

    def start(role, *args, exe=binary):
        proc = subprocess.Popen([exe, *args], env=env(role), cwd=root,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def stop():
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        stack.callback(stop)
        return proc

    def cli(*args, ok=True):
        proc = start("hub", *args)
        out, err = proc.communicate(timeout=35)
        assert (proc.returncode == 0) == ok, (args, out, err)
        return json.loads(out) if out.strip() else err

    addrfile = root / "hub/.collie/addr"
    def start_hub(addr, exe=binary):
        proc = start("hub", "serve", "--addr", addr, "--socket", str(root / "hub.sock"), exe=exe)
        until(lambda: addrfile.exists() and addrfile.stat().st_size)
        return proc

    hub = start_hub("127.0.0.1:0")
    addr = addrfile.read_text().strip()
    token = (addrfile.parent / "token").read_text().strip()
    def api(path, data=None):
        req = Request("http://" + addr + path, data=json.dumps(data).encode() if data else None,
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urlopen(req, timeout=5) as res:
            return json.load(res)

    node_args = ("node", "--socket", str(root / "node.sock"), "--ui", "off")
    code = api("/api/pair/new", {"kind": "machine"})["code"]
    node = start("node", *node_args, "--hub", addr, "--code", code, "--name", "sandbox")
    def online():
        return next((d["id"] for d in api("/api/devices")["devices"] if d["online"]), "")
    machine = until(online)
    pane = "w1:p1@" + machine
    external = f"claude-{os.getpid()}@{machine}"

    def count(text):
        assert counts[text] == 1, (text, counts)
        print(f"{text}: actual sends = 1", flush=True)

    codex = "cx-e2e-codex@" + machine
    for to, text in [("w1:p1", "local-pane"), (pane, "normal-pane"),
                     (external, "normal-external"), (codex, "normal-codex")]:
        receipt = cli("send", to, text)
        assert receipt["status"] == "accepted" and receipt["to"] == to
        assert cli("receipt", receipt["id"])["status"] == "accepted"
        assert receipt["ok"]
        assert cli("send", "--id", receipt["id"], to, text) == receipt
        assert "different target or text" in cli("send", "--id", receipt["id"], to, "changed", ok=False)
        count(text)

    assert "different target or text" in cli("send", "--id", receipt["id"], pane, text, ok=False)

    v = cli("send", codex, "codex-backend-lost", ok=False)
    assert v["status"] == "unconfirmed"
    assert cli("receipt", v["id"]) == v
    assert cli("send", "--id", v["id"], codex, "codex-backend-lost", ok=False) == v
    count("codex-backend-lost")

    def db_status(role, rid):
        with sqlite3.connect(root / role / ".collie/herd.db") as db:
            row = db.execute("SELECT status FROM send_receipts WHERE id=?", (rid,)).fetchone()
            return row and row[0]

    # Hold herdr's ack after the observable effect, inspect and race the first request.
    pending = start("hub", "send", pane, "lost-pane")
    line = pending.stderr.readline()
    assert line.startswith("receipt: "), line
    rid = line.split()[1]
    until(lambda: counts["lost-pane"])
    assert cli("receipt", rid)["status"] == "unconfirmed"
    assert cli("send", "--id", rid, pane, "lost-pane", ok=False)["status"] == "unconfirmed"
    count("lost-pane")

    external_pending = start("hub", "send", "--id", "lost-external", external, "lost-external")
    until(lambda: counts["lost-external"])
    assert cli("receipt", "lost-external")["status"] == "unconfirmed"
    # Freeze the real hub before the node replies. The CLI reaches its real 30s
    # deadline. Kill the frozen hub, discarding the unread tunnel response.
    hub.send_signal(signal.SIGSTOP)
    release.set()
    until(lambda: db_status("node", rid) == "accepted")
    assert db_status("hub", rid) == "unconfirmed"
    until(lambda: db_status("node", "lost-external") == "accepted")
    assert db_status("hub", "lost-external") == "unconfirmed"
    out, err = pending.communicate(timeout=35)
    assert pending.returncode != 0 and "timeout" in err.lower() and rid in err, (out, err)
    print(f"{rid}: CLI timed out; SQLite node=accepted, hub=unconfirmed", flush=True)
    _, err = external_pending.communicate(timeout=35)
    assert external_pending.returncode != 0 and "timeout" in err.lower(), err
    hub.kill()
    hub.wait()
    node.kill()
    node.wait()
    addrfile.unlink()
    # A worker can have the same spelling as a local sidebar ID.
    with sqlite3.connect(addrfile.parent / "herd.db") as db:
        wk = {"name": "cl-fixture", "thread": "fixture", "status": "starting"}
        db.execute("INSERT INTO workers(name,created_at,data) VALUES(?, ?, ?)",
                   (wk["name"], int(time.time()), json.dumps(wk)))
    hub = start_hub(addr)
    queued = cli("send", "--id", "worker-name", "cl-fixture", "queued-work")
    assert queued["trigger"] and cli("receipt", "worker-name")["status"] == "queued"
    assert cli("send", "--id", "worker-name", "cl-fixture", "queued-work") == queued
    assert cli("receipt", rid)["status"] == "unconfirmed"  # offline
    node = start("node", *node_args)
    until(online)
    assert cli("receipt", rid)["status"] == "accepted"
    assert cli("send", "--id", rid, pane, "lost-pane")["status"] == "accepted"
    count("lost-pane")

    # Retry against the receiver before a query can populate the hub cache.
    assert cli("send", "--id", "lost-external", external, "lost-external")["status"] == "accepted"
    assert cli("receipt", "lost-external")["status"] == "accepted"
    count("lost-external")

    # Node dies between the side effect and its outcome commit.
    release.clear()
    pending = start("hub", "send", "--id", "crash", pane, "crash-window")
    until(lambda: counts["crash-window"])
    node.kill()
    node.wait()
    release.set()
    pending.communicate(timeout=35)
    node = start("node", *node_args)
    until(online)
    assert cli("receipt", "crash")["status"] == "unconfirmed"
    assert cli("send", "--id", "crash", pane, "crash-window", ok=False)["status"] == "unconfirmed"
    count("crash-window")

    # An inbox write with no session acknowledgement must retain its uncertainty.
    v = cli("send", external, "no-transcript-ack", ok=False)
    assert v["status"] == "unconfirmed"
    assert cli("send", "--id", v["id"], external, "no-transcript-ack", ok=False) == v
    count("no-transcript-ack")

    if old:
        node.kill()
        node.wait()
        until(lambda: not online())
        legacy = start("node", *node_args, exe=old)
        until(online)
        v = cli("send", "--id", "mixed", pane, "old-node", ok=False)
        assert v["status"] == "unconfirmed" and "updated node" in v["detail"], v
        assert counts["old-node"] == 0
        old_send = start("hub", "send", pane, "legacy-pane", exe=old)
        out, err = old_send.communicate(timeout=35)
        assert old_send.returncode == 0 and json.loads(out)["ok"], (out, err)
        count("legacy-pane")
        legacy.kill()
        legacy.wait()
        until(lambda: not online())
        node = start("node", *node_args)
        until(online)
        assert cli("send", "--id", "mixed", pane, "old-node")["status"] == "accepted"
        count("old-node")
        hub.kill()
        hub.wait()
        addrfile.unlink()
        start_hub(addr, exe=old)
        until(online)
        err = cli("send", "--id", "old-hub", pane, "old-hub", ok=False)
        assert "unconfirmed" in err and counts["old-hub"] == 0, err
        print("unsupported hub: actual sends = 0")
    print("PASS", flush=True)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="collie-e2e-", dir="/tmp") as tmp, ExitStack() as cleanup:
        run(Path(tmp), cleanup, str(Path(sys.argv[1]).resolve()),
            str(Path(sys.argv[2]).resolve()) if len(sys.argv) > 2 else None)
