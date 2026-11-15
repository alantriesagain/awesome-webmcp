import os, sys, time, re
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from drive import App
OUT = os.environ.get("CHECKLIST_OUT", "/tmp/code-checklist/")
os.makedirs(OUT, exist_ok=True)
app = App("/home/alanleal/Projects/bootstrapp", OUT + "c1.log", cols=200, rows=50)
s = app.screen()
open(OUT + "c1-start.txt", "w").write(s)
app.type("/resume"); app.key("enter")
s = app.wait_screen("Sessions in this folder", 10)
open(OUT + "c1-list.txt", "w").write(s)
t0 = time.time()
app.key("enter")
s = app.wait_screen(lambda s: "Sessions in this folder" not in s, 10)
print("resume to painted: %.2f s (frame %.1f ms)" % (time.time() - t0, app.last_frame_ms))
open(OUT + "c1-resumed.txt", "w").write(s)
frames = []
for i in range(12):
    app.key("pgup")
    frames.append(app.screen() and app.last_frame_ms)
print("PgUp frames ms:", ["%.1f" % f for f in frames])
t0 = time.time()
app.key("ctrl-home")
s = app.wait_screen(lambda s: True, 10)
print("load earlier + top: %.2f s" % (time.time() - t0))
open(OUT + "c1-earlier.txt", "w").write(s)
x, y = 40, 20
for i in range(5):
    app.wheel(x, y, True, 3)
s = app.screen()
print("wheel frame %.1f ms" % app.last_frame_ms)
app.close()
print(re.findall(r"resumed [^\n]*", app.text_log()))
