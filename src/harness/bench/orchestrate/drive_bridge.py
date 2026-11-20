#!/usr/bin/env python3
"""A bridge to test/drive.py's App for the orchestration benchmark's runner: one JSON command per
line on stdin, one JSON answer per line on stdout. Commands: start (folder, log, args), send (text),
screen (the app's text screen), close. The app stays alive between commands, so node can read its log
and session file while it runs."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "test")))

from drive import App  # noqa: E402

app = None


def answer(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        command = json.loads(line)
    except Exception as e:
        answer(ok=False, error="not JSON: %s" % e)
        continue
    op = command.get("op", "")
    try:
        if op == "start":
            app = App(command["folder"], command["log"], args=tuple(command.get("args", [])), cols=int(command.get("cols", 200)), rows=int(command.get("rows", 50)))
            answer(ok=True)
        elif op == "send":
            app.paste(command["text"])
            app.key("enter")
            answer(ok=True)
        elif op == "screen":
            answer(ok=True, screen=app.screen())
        elif op == "close":
            app.close()
            answer(ok=True)
            break
        else:
            answer(ok=False, error="unknown op: " + op)
    except Exception as e:
        answer(ok=False, error="%s: %s" % (type(e).__name__, e))
