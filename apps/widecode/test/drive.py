#!/usr/bin/env python3
"""Drive dist/widecode in a pseudo-terminal as a user would: keys, text, mouse presses, and the screen
read back (F12 makes the app write its screen's text to its --log file). The checklist
(checklist.py) is built on it; it needs `claude` on PATH for anything that talks to Claude."""
import os
import pty
import re
import select
import struct
import termios
import fcntl
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BINARY = os.path.join(HERE, "..", "..", "..", "dist", "widecode")

KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "shift-tab": "\x1b[Z", "space": " ", "backspace": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "pgup": "\x1b[5~", "pgdn": "\x1b[6~", "home": "\x1b[H", "end": "\x1b[F", "ctrl-home": "\x1b[1;5H", "ctrl-end": "\x1b[1;5F",
    "f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS", "f5": "\x1b[15~", "f6": "\x1b[17~", "f12": "\x1b[24~", "ctrl-c": "\x03",
    "alt-left": "\x1b[1;3D", "alt-right": "\x1b[1;3C", "alt-up": "\x1b[1;3A", "alt-down": "\x1b[1;3B", "alt-enter": "\x1b\r", "alt-backspace": "\x1b\x7f",
    "ctrl-left": "\x1b[1;5D", "ctrl-right": "\x1b[1;5C", "delete": "\x1b[3~",
}


def ctrl(letter):
    """The byte a terminal sends for Ctrl and a letter (Ctrl+/ and Ctrl+_ are 0x1f)."""
    if letter in ("/", "_"):
        return "\x1f"
    return chr(ord(letter.lower()) - 96)


def alt(letter):
    """Esc then the letter, as a terminal sends Alt and a letter."""
    return "\x1b" + letter


class App:
    def __init__(self, folder, log, args=(), cols=200, rows=50):
        self.log = log
        self.cols = cols
        self.rows = rows
        self.dumps = 0
        if os.path.exists(log):
            os.remove(log)
        env = dict(os.environ)
        env.pop("CLAUDECODE", None)
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)
        env["TERM"] = "xterm-256color"
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.chdir(folder)
            os.execve(BINARY, [BINARY, "--dir", folder, "--log", log, *args], env)
        self.pid = pid
        self.fd = fd
        self.alive = True
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()
        self.wait_log(r"tree files=", 15)

    def _drain(self):
        while self.alive:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.2)
                if r and not os.read(self.fd, 65536):
                    break
            except OSError:
                break

    def send(self, s):
        os.write(self.fd, s.encode())

    def key(self, name, times=1, pause=0.05):
        for _ in range(times):
            self.send(KEYS[name])
            time.sleep(pause)

    def type(self, text):
        self.send(text)
        time.sleep(0.1)

    def paste(self, text):
        self.send("\x1b[200~" + text + "\x1b[201~")
        time.sleep(0.1)

    def press(self, x, y):
        """A left press and release at cell (x, y), 0-based."""
        self.send("\x1b[<0;%d;%dM" % (x + 1, y + 1))
        time.sleep(0.03)
        self.send("\x1b[<0;%d;%dm" % (x + 1, y + 1))
        time.sleep(0.2)

    def drag(self, x0, y0, x1, y1):
        """A left press at (x0, y0), a move to (x1, y1) with the button held, and the release there."""
        self.send("\x1b[<0;%d;%dM" % (x0 + 1, y0 + 1))
        time.sleep(0.03)
        self.send("\x1b[<32;%d;%dM" % (x1 + 1, y1 + 1))
        time.sleep(0.03)
        self.send("\x1b[<0;%d;%dm" % (x1 + 1, y1 + 1))
        time.sleep(0.2)

    def wheel(self, x, y, down, times=1):
        for _ in range(times):
            self.send("\x1b[<%d;%d;%dM" % (65 if down else 64, x + 1, y + 1))
            time.sleep(0.03)

    def text_log(self):
        try:
            with open(self.log, encoding="utf-8", errors="replace") as f:
                return f.read()
        except FileNotFoundError:
            return ""

    def wait_log(self, pattern, timeout=60, after=0):
        """Wait until the log (from offset `after`) matches; answers the match or None."""
        end = time.time() + timeout
        rx = re.compile(pattern)
        while time.time() < end:
            m = rx.search(self.text_log(), after)
            if m:
                return m
            time.sleep(0.2)
        return None

    def screen(self):
        """The screen's text, as the app painted it."""
        self.dumps += 1
        n = self.dumps
        mark = len(self.text_log())
        self.key("f12")
        m = self.wait_log(r"screen %d frame ([0-9.]+) ms\n([\s\S]*?)\nend screen %d" % (n, n), 10, mark)
        if m is None:
            raise RuntimeError("no screen dump")
        self.last_frame_ms = float(m.group(1))
        return m.group(2)

    def wait_screen(self, needle, timeout=90):
        """Read screens until one contains `needle` (a string or a function of the screen)."""
        end = time.time() + timeout
        s = ""
        while time.time() < end:
            s = self.screen()
            if (needle(s) if callable(needle) else needle in s):
                return s
            time.sleep(0.7)
        raise RuntimeError("timed out waiting for %r; last screen:\n%s" % (needle, s))

    @staticmethod
    def find(screen, needle):
        """The (x, y) of `needle` on the screen, or None."""
        for y, line in enumerate(screen.split("\n")):
            x = line.find(needle)
            if x >= 0:
                return (x, y)
        return None

    def running(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def close(self, timeout=10):
        if self.running():
            self.key("ctrl-c")
            time.sleep(0.3)
            self.key("ctrl-c")
        end = time.time() + timeout
        while time.time() < end and self.running():
            time.sleep(0.1)
        if self.running():
            os.kill(self.pid, 9)
        self.alive = False
