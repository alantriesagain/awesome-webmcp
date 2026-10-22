from common import *
def procs():
    r = subprocess.run(["pgrep", "-af", "--", "--no-session-persistence"], capture_output=True, text=True)
    out = []
    for line in r.stdout.splitlines():
        pid = line.split()[0]
        if "pgrep" in line or "zsh -c" in line or "python3" in line.split()[1]:
            continue
        ppid = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", pid], capture_output=True, text=True).stdout.strip()
        out.append(pid + " (" + ppid + ") " + " ".join(line.split()[1:3]))
    return out
d = repo()
app = App(d, OUT + "c13.log", LIVE, cols=200, rows=40)
print("app pid", app.pid)
app.type('Use the Bash tool to run exactly: python3 -c "import time; time.sleep(30)" and then say finished.'); app.key("enter")
app.wait_screen(lambda s: "⏺ Bash python3" in s, 60)
print("while running:", procs())
t0 = time.time()
app.key("ctrl-c"); time.sleep(0.3); app.key("ctrl-c")
for i in range(20):
    time.sleep(0.25)
    p = procs()
    if not p:
        print("all gone after %.2f s; app running: %s" % (time.time() - t0, app.running()))
        break
else:
    print("still there after 5 s:", procs())
app.close()
