# Titles and the status bar, live: a real turn in a temp repository with its own WIDECODE_HOME, whose
# config adds a fourth status line running scripts/statusline.sh (a Claude Code status
# line script). Checks the title Claude writes replaces the prompt, the bar's context, limits and
# cache, and the script's line. Cleans up the session folder the turn creates.
import json, shutil
from common import *
home = tempfile.mkdtemp(prefix="widecode-home-")
script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "statusline.sh")
lines = [["project", "branch", "model", "effort", "mode", "title", "spacer", "note"], ["context", "limit5h", "limitWeek", "cache"], ["activity", "tools", "calls", "thinking", "cost", "duration"], [{"command": os.path.abspath(script)}]]
os.makedirs(home, exist_ok=True)
open(os.path.join(home, "config.json"), "w").write(json.dumps({"titles": {"auto": True, "model": "haiku"}, "statusline": {"separator": " │ ", "lines": lines}}))
os.environ["WIDECODE_HOME"] = home
d = repo()
app = App(d, OUT + "c14.log", ["--model", "haiku", "--effort", "low"], cols=200, rows=40)
mark = len(app.text_log())
app.type("Reply with exactly: PONG"); app.key("enter")
idle(app, mark, 90)
t0 = time.time()
s = app.wait_screen(lambda s: "Reply with exactly" not in s.split("\n")[-4] and "PONG" in s and app.wait_log(r"title [0-9a-f-]+: ", 0.1) is not None, 30)
title = app.wait_log(r"title [0-9a-f-]+: ([^\n]+)", 1)
print("title from Claude:", title.group(1) if title else None, "after %.1f s" % (time.time() - t0))
time.sleep(0.5)
s = app.screen()
bar = s.split("\n")[-4:]
print("----- the status bar"); print("\n".join(bar))
sessions = os.listdir(os.path.join(home, "sessions"))
print("~/.widecode session files:", sessions)
rec = json.load(open(os.path.join(home, "sessions", sessions[0]))) if sessions else {}
print("stored:", {k: rec.get(k) for k in ["title", "titleBy", "costUsd", "model"]})
app.close()
project = os.path.expanduser("~/.claude/projects/" + "".join(c if c.isalnum() else "-" for c in d))
if os.path.isdir(project): shutil.rmtree(project)
shutil.rmtree(home)
shutil.rmtree(d)
