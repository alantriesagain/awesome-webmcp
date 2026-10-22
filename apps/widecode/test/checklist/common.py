import os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from drive import App
OUT = os.environ.get("CHECKLIST_OUT", "/tmp/code-checklist/")
os.makedirs(OUT, exist_ok=True)
LIVE = ["--model", "haiku", "--effort", "low", "--ephemeral"]

def repo(git=True):
    d = tempfile.mkdtemp(prefix="code-check-")
    os.makedirs(os.path.join(d, "src"))
    open(os.path.join(d, "README.md"), "w").write("# Demo\nA small demo project.\n")
    open(os.path.join(d, "list.txt"), "w").write("one\ntwo\nthree\n")
    open(os.path.join(d, "src", "app.js"), "w").write("".join("const line%d = %d;\n" % (i, i) for i in range(1, 31)))
    if git:
        g = lambda *a: subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", *a], check=True, capture_output=True)
        g("init", "-q"); g("add", "."); g("commit", "-qm", "init")
    return d

def idle(app, after, timeout=120):
    """Wait for the turn that started after log offset `after` to end."""
    return app.wait_log(r"claude idle", timeout, after)

def chat(s, width=100):
    """The chat column's text, one line per row."""
    return "\n".join(l[1:width - 1].rstrip() for l in s.split("\n")[1:-2])

def show(title, s):
    print("----- " + title)
    print(chat(s))
