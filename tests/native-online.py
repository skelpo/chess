"""Online play in the native binary, driven through a pseudo-terminal against a local server.

Usage: python3 tests/native-online.py <tuichess binary>   (server: node server/src/main.ts, or $CHESS_SERVER)
"""
import os, pty, sys, time, json, subprocess, tempfile, select, urllib.request, re
binary = sys.argv[1]
port = 19000 + os.getpid() % 900
data = tempfile.mkdtemp()
srv = subprocess.Popen([os.environ.get("CHESS_SERVER") or "node"] + ([] if os.environ.get("CHESS_SERVER") else ["server/src/main.ts"]),
    env={**os.environ, "PORT": str(port), "CHESS_DATA": data + "/d.json"}, stdout=subprocess.DEVNULL)
base = f"http://127.0.0.1:{port}"
for _ in range(100):
    try: urllib.request.urlopen(base + "/health"); break
    except Exception: time.sleep(0.05)
def call(method, path, token=None, body=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json", **({"authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
pid, fd = pty.fork()
if pid == 0:
    os.environ["TUICHESS_HOME"] = data + "/home"; os.environ["TERM"] = "xterm-256color"
    os.execv(binary, [binary, "--online", "--server", base])
screen = ""
def read(t=0.3):
    global screen
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: screen += os.read(fd, 65536).decode("utf8", "replace")
            except OSError: return
def last(): return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", screen.split("\x1b[2J")[-1])
def wait(text, t=8):
    end = time.time() + t
    while time.time() < end:
        read(0.1)
        if text in last(): return
    print("TIMEOUT waiting for", repr(text)); print(last()); srv.kill(); sys.exit(1)
def type_(s):
    os.write(fd, s.encode()); read(0.15)
wait("PLAY ONLINE")
type_("perry_t\r"); wait("ONLINE · PERRY_T")
assert json.load(open(data + "/home/accounts.json"))[base]["name"] == "perry_t"
bob = call("POST", "/v1/register", body={"name": "py_bob"})["token"]
wait("py_bob")  # long poll delivers the new player
type_("play\r"); wait("Waiting for an opponent")
call("POST", "/v1/action", bob, {"type": "queue"}); wait("YOUR MOVE")
wait("10+5")  # both clocks and the time control
assert re.search(r"White\s+perry_t \(you\)\s+▶ (10:00|9:5\d)", last()), last()
type_("e2e4\r"); wait("PY_BOB TO MOVE")
call("POST", "/v1/action", bob, {"type": "move", "uci": "e7e5"}); wait("YOUR MOVE")
# arrows: cursor starts at e4 after our move; move to g1 and play g1f3
for k in ["\x1b[C", "\x1b[C", "\x1b[B", "\x1b[B", "\x1b[B"]: type_(k)
type_(" "); type_("\x1b[D"); type_("\x1b[A"); type_("\x1b[A"); type_(" ")
wait("PY_BOB TO MOVE")
st = call("GET", "/v1/state", bob)
assert st["game"]["moves"] == ["e2e4", "e7e5", "g1f3"], st["game"]["moves"]
call("POST", "/v1/action", bob, {"type": "resign"}); wait("You won by resignation")
t = time.time(); type_("quit\r")
os.waitpid(pid, 0); took = time.time() - t
print("native online ok; quit took %.2fs" % took)
assert took < 2
srv.kill()
