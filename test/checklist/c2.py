import os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from drive import App
OUT = os.environ.get("CHECKLIST_OUT", "/tmp/code-checklist/")
os.makedirs(OUT, exist_ok=True)
app = App("/home/alanleal/Projects/writting-harness", OUT + "c2.log", cols=200, rows=40)
app.type("/resume"); app.key("enter")
s = app.wait_screen("Sessions in this folder", 10)
print("\n".join(l[:100] for l in s.split("\n")[1:7]))
app.key("enter")
s = app.wait_screen(lambda s: "Sessions in this folder" not in s, 10)
warn = [l[:100] for l in s.split("\n") if "is running this session" in l]
print("warning shown:", warn)
app.close()
