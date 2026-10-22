// The vi keymap, chosen with "keymap": "vi" in config.json or /keymap vi: the composer has an
// insert mode (the keys as they are) and a normal mode, Esc from the one to the other. The
// composer starts in insert mode after each message. Normal mode is a layer over the "input"
// scope that takes every key: a count, then a motion (h j k l w b e 0 ^ $ gg G, the arrows, Enter
// sends), an operator (d c y) with a motion or doubled for the line, or a command (x X D C s S J ~
// p P u Ctrl+R r i a I A o O), kept in one register. In normal mode Esc interrupts the agent while
// it works (the shell's Esc, which the layer passes on). The composer's border says the mode. In
// the code column: j k scroll, gg and G go to the top and the end.

const u = widecode.util;

/** A grapheme's class, as vi counts words: 0 blank, 1 a word character, 2 anything else (punctuation). */
const kind = (g: string): number => {
  if (g.trim().length === 0) return 0;
  const c = g.codePointAt(0) ?? 0;
  if (c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127) return 1;
  return 2;
};

/** The composer as the plugin edits it: lines as graphemes, the caret. */
interface Text {
  lines: string[][];
  row: number;
  col: number;
}

/** Where a motion ends, and how an operator takes the span to it. */
interface Target {
  row: number;
  col: number;
  /** "exclusive" (to the character before), "inclusive" (that character too), "line" (whole lines). */
  span: string;
}

/** What yank or delete kept. */
interface Register {
  text: string;
  linewise: boolean;
}

const INSERT = "-- INSERT --";
const NORMAL = "-- NORMAL --";

widecode.plugin({
  id: "vi",
  activate(api) {
    let mode = "insert";
    /** The count typed so far (0 for none), the operator waiting for a motion ("" for none), a key waiting for its argument (r), and g pressed once. */
    let count = 0;
    let operator = "";
    let pending = "";
    let gPressed = false;
    let register: Register = { text: "", linewise: false };
    let codeG = false;

    const read = (): Text => {
      const c = api.composer.get();
      return { lines: c.lines.map((l) => u.graphemes(l)), row: c.row, col: c.col };
    };
    const write = (t: Text): void => api.composer.set(t.lines.map((l) => l.join("")), t.row, t.col);
    const lineOf = (t: Text, row: number): string[] => t.lines[row] ?? [];
    /** The last column the caret may sit on in normal mode (on a character). */
    const lastCol = (t: Text, row: number): number => Math.max(0, lineOf(t, row).length - 1);
    const clampNormal = (t: Text): Text => ({ lines: t.lines, row: Math.max(0, Math.min(t.row, t.lines.length - 1)), col: Math.max(0, Math.min(t.col, lastCol(t, Math.max(0, Math.min(t.row, t.lines.length - 1))))) });

    const setMode = (m: string): void => {
      const from = mode;
      mode = m;
      count = 0;
      operator = "";
      pending = "";
      gPressed = false;
      normal.off();
      if (api.state.keymap() !== "vi") {
        api.composer.setLabel("You");
        return;
      }
      if (m === "normal") {
        normal.on();
        // Leaving insert mode, the caret steps back onto the character before it, as vi has it.
        const t = read();
        write(clampNormal(from === "insert" ? { lines: t.lines, row: t.row, col: Math.max(0, t.col - 1) } : t));
      }
      api.composer.setLabel(m === "normal" ? NORMAL : INSERT);
    };

    // Motions: where the caret goes from `t`, `n` times.
    const firstNonBlank = (line: string[]): number => {
      let i = 0;
      while (i < line.length && kind(line[i]) === 0) i++;
      return Math.min(i, Math.max(0, line.length - 1));
    };
    /** The next word's start after (row, col), across lines; null at the end. */
    const wordForward = (t: Text, row: number, col: number): { row: number; col: number } | null => {
      let r = row;
      let c = col;
      const line = lineOf(t, r);
      if (c < line.length) {
        const k = kind(line[c]);
        if (k !== 0) while (c < line.length && kind(line[c]) === k) c++;
        while (c < line.length && kind(line[c]) === 0) c++;
        if (c < line.length) return { row: r, col: c };
      }
      // On to the next line's first word.
      while (r + 1 < t.lines.length) {
        r++;
        const l = lineOf(t, r);
        let i = 0;
        while (i < l.length && kind(l[i]) === 0) i++;
        if (i < l.length || l.length === 0) return { row: r, col: i };
      }
      return null;
    };
    const wordBack = (t: Text, row: number, col: number): { row: number; col: number } => {
      let r = row;
      let c = col;
      for (;;) {
        const line = lineOf(t, r);
        let i = Math.min(c, line.length) - 1;
        while (i >= 0 && kind(line[i]) === 0) i--;
        if (i >= 0) {
          const k = kind(line[i]);
          while (i > 0 && kind(line[i - 1]) === k) i--;
          return { row: r, col: i };
        }
        if (r === 0) return { row: 0, col: 0 };
        r--;
        c = lineOf(t, r).length;
      }
    };
    const wordEnd = (t: Text, row: number, col: number): { row: number; col: number } => {
      let r = row;
      let c = col + 1;
      for (;;) {
        const line = lineOf(t, r);
        while (c < line.length && kind(line[c]) === 0) c++;
        if (c < line.length) {
          const k = kind(line[c]);
          while (c + 1 < line.length && kind(line[c + 1]) === k) c++;
          return { row: r, col: c };
        }
        if (r + 1 >= t.lines.length) return { row: r, col: Math.max(0, line.length - 1) };
        r++;
        c = 0;
      }
    };

    /** The motion key `k` from `t`, `n` times (`counted`: a count was typed; G goes to line n then); null for a key that is no motion. */
    const motion = (t: Text, k: string, n: number, counted: boolean): Target | null => {
      const line = lineOf(t, t.row);
      if (k === "h" || k === "left" || k === "backspace") return { row: t.row, col: Math.max(0, t.col - n), span: "exclusive" };
      if (k === "l" || k === "right" || k === " ") return { row: t.row, col: Math.min(line.length, t.col + n), span: "exclusive" };
      if (k === "j" || k === "down") return { row: Math.min(t.lines.length - 1, t.row + n), col: t.col, span: "line" };
      if (k === "k" || k === "up") return { row: Math.max(0, t.row - n), col: t.col, span: "line" };
      if (k === "0" || k === "home") return { row: t.row, col: 0, span: "exclusive" };
      if (k === "^") return { row: t.row, col: firstNonBlank(line), span: "exclusive" };
      if (k === "$" || k === "end") {
        const row = Math.min(t.lines.length - 1, t.row + n - 1);
        return { row, col: Math.max(0, lineOf(t, row).length - 1), span: "inclusive" };
      }
      if (k === "w") {
        let at = { row: t.row, col: t.col };
        for (let i = 0; i < n; i++) {
          const next = wordForward(t, at.row, at.col);
          if (next === null) {
            const last = lineOf(t, at.row).length;
            return { row: at.row, col: last, span: "exclusive" };
          }
          at = next;
        }
        return { row: at.row, col: at.col, span: "exclusive" };
      }
      if (k === "b") {
        let at = { row: t.row, col: t.col };
        for (let i = 0; i < n; i++) at = wordBack(t, at.row, at.col);
        return { row: at.row, col: at.col, span: "exclusive" };
      }
      if (k === "e") {
        let at = { row: t.row, col: t.col };
        for (let i = 0; i < n; i++) at = wordEnd(t, at.row, at.col);
        return { row: at.row, col: at.col, span: "inclusive" };
      }
      if (k === "G") return { row: counted ? Math.min(t.lines.length - 1, n - 1) : t.lines.length - 1, col: 0, span: "line" };
      if (k === "gg") return { row: Math.min(t.lines.length - 1, Math.max(0, n - 1)), col: 0, span: "line" };
      return null;
    };

    /** The text from the caret to `target` taken out of `t` (kept in the register), or copied when `yank`. */
    const apply = (t: Text, target: Target, op: string): void => {
      let from = { row: t.row, col: t.col };
      let to = { row: target.row, col: target.col };
      if (from.row > to.row || (from.row === to.row && from.col > to.col)) {
        const swap = from;
        from = to;
        to = swap;
      }
      const linewise = target.span === "line";
      let taken: string[];
      let lines = t.lines.map((l) => l.slice());
      if (linewise) {
        taken = lines.slice(from.row, to.row + 1).map((l) => l.join(""));
        if (op !== "y") {
          lines.splice(from.row, to.row - from.row + 1);
          if (op === "c") lines.splice(from.row, 0, []);
          if (lines.length === 0) lines = [[]];
        }
      } else {
        const endCol = target.span === "inclusive" ? to.col + 1 : to.col;
        if (from.row === to.row) {
          taken = [lines[from.row].slice(from.col, endCol).join("")];
          if (op !== "y") lines[from.row].splice(from.col, endCol - from.col);
        } else {
          taken = [lines[from.row].slice(from.col).join("")];
          for (let r = from.row + 1; r < to.row; r++) taken.push(lines[r].join(""));
          taken.push(lines[to.row].slice(0, endCol).join(""));
          if (op !== "y") {
            const joined = lines[from.row].slice(0, from.col).concat(lines[to.row].slice(endCol));
            lines.splice(from.row, to.row - from.row + 1, joined);
          }
        }
      }
      register = { text: taken.join("\n"), linewise };
      if (op === "y") {
        write({ lines: t.lines, row: from.row, col: linewise ? t.col : from.col });
        return;
      }
      const row = Math.min(from.row, lines.length - 1);
      const col = linewise ? (op === "c" ? 0 : firstNonBlank(lines[row])) : from.col;
      write({ lines, row, col });
      if (op === "c") setMode("insert");
      else write(clampNormal(read()));
    };

    /** Put the register after (`after`) or before the caret, `n` times. */
    const put = (t: Text, after: boolean, n: number): void => {
      if (register.text.length === 0) return;
      const lines = t.lines.map((l) => l.slice());
      if (register.linewise) {
        const at = after ? t.row + 1 : t.row;
        const added: string[][] = [];
        for (let i = 0; i < n; i++) for (const l of register.text.split("\n")) added.push(u.graphemes(l));
        lines.splice(at, 0, ...added);
        write({ lines, row: at, col: firstNonBlank(added[0] ?? []) });
        return;
      }
      const text = register.text.repeat(n);
      const parts = text.split("\n").map((l) => u.graphemes(l));
      const line = lines[t.row] ?? [];
      const at = after && line.length > 0 ? t.col + 1 : t.col;
      const before = line.slice(0, at);
      const rest = line.slice(at);
      if (parts.length === 1) {
        lines[t.row] = before.concat(parts[0], rest);
        write({ lines, row: t.row, col: at + parts[0].length - 1 });
      } else {
        const made = [before.concat(parts[0])];
        for (let i = 1; i < parts.length - 1; i++) made.push(parts[i]);
        made.push(parts[parts.length - 1].concat(rest));
        lines.splice(t.row, 1, ...made);
        write({ lines, row: t.row + parts.length - 1, col: Math.max(0, parts[parts.length - 1].length - 1) });
      }
    };

    /** A key in normal mode. */
    const normalKey = (key: widecode.Key): boolean => {
      const k = key.name === "char" && !key.ctrl && !key.alt ? key.text : key.ctrl && key.name === "char" ? "ctrl+" + key.text : key.name;
      // Keys of the shell and the chat come before this; a key with a modifier the mode does not use is left alone.
      if (key.alt || (key.ctrl && k !== "ctrl+r")) return false;
      if (key.name === "paste") return true;
      const t = read();
      const n = Math.max(1, count);
      const counted = count > 0;
      if (pending === "r") {
        pending = "";
        count = 0;
        if (key.name === "char" && lineOf(t, t.row).length > 0) {
          for (let i = 0; i < n && t.col + i < lineOf(t, t.row).length; i++) t.lines[t.row][t.col + i] = key.text;
          write({ lines: t.lines, row: t.row, col: Math.min(t.col + n - 1, lastCol(t, t.row)) });
        }
        return true;
      }
      if (k === "escape") {
        if (operator.length > 0 || count > 0 || pending.length > 0 || gPressed) {
          count = 0;
          operator = "";
          pending = "";
          gPressed = false;
          return true;
        }
        // Nothing pending: the shell's Esc (an interrupt while the agent works).
        return false;
      }
      if (k === "enter") {
        count = 0;
        operator = "";
        api.keys.run("editor.submit", 1);
        setMode("insert");
        return true;
      }
      if (/^[0-9]$/.test(k) && !(k === "0" && count === 0)) {
        count = count * 10 + Number(k);
        return true;
      }
      if (k === "g" && !gPressed) {
        gPressed = true;
        return true;
      }
      const mk = gPressed && k === "g" ? "gg" : k;
      gPressed = false;
      // An operator doubled works on the line (dd, cc, yy); with a motion, on the span to it.
      if (operator.length > 0) {
        const op = operator;
        operator = "";
        count = 0;
        if (k === op) {
          apply(t, { row: Math.min(t.lines.length - 1, t.row + n - 1), col: 0, span: "line" }, op);
          return true;
        }
        const target = motion(t, mk, n, counted);
        if (target !== null) {
          // cw on a word changes to its end, as vi has it.
          if (op === "c" && k === "w" && t.col < lineOf(t, t.row).length && kind(lineOf(t, t.row)[t.col]) !== 0) {
            const e = wordEnd(t, t.row, t.col - 1);
            apply(t, { row: e.row, col: e.col, span: "inclusive" }, op);
          } else apply(t, target, op);
        }
        return true;
      }
      if (k === "d" || k === "c" || k === "y") {
        operator = k;
        return true;
      }
      count = 0;
      const target = motion(t, mk, n, counted);
      if (target !== null) {
        const row = Math.max(0, Math.min(target.row, t.lines.length - 1));
        write({ lines: t.lines, row, col: Math.min(target.col, lastCol(t, row)) });
        return true;
      }
      const line = lineOf(t, t.row);
      switch (k) {
        case "x":
        case "delete":
          if (line.length > 0) apply(t, { row: t.row, col: Math.min(line.length - 1, t.col + n - 1), span: "inclusive" }, "d");
          return true;
        case "X":
          if (t.col > 0) apply(t, { row: t.row, col: Math.max(0, t.col - n), span: "exclusive" }, "d");
          return true;
        case "D":
          apply(t, { row: Math.min(t.lines.length - 1, t.row + n - 1), col: Math.max(0, lineOf(t, Math.min(t.lines.length - 1, t.row + n - 1)).length - 1), span: "inclusive" }, "d");
          return true;
        case "C":
          apply(t, { row: Math.min(t.lines.length - 1, t.row + n - 1), col: Math.max(0, lineOf(t, Math.min(t.lines.length - 1, t.row + n - 1)).length - 1), span: "inclusive" }, "c");
          return true;
        case "s":
          if (line.length > 0) apply(t, { row: t.row, col: Math.min(line.length - 1, t.col + n - 1), span: "inclusive" }, "c");
          else setMode("insert");
          return true;
        case "S":
          apply(t, { row: Math.min(t.lines.length - 1, t.row + n - 1), col: 0, span: "line" }, "c");
          return true;
        case "J": {
          const lines = t.lines.map((l) => l.slice());
          let col = t.col;
          for (let i = 0; i < Math.max(1, n - 1) && t.row + 1 < lines.length; i++) {
            const next = lines[t.row + 1].slice(firstNonBlank(lines[t.row + 1]) === lines[t.row + 1].length ? lines[t.row + 1].length : 0);
            let s = 0;
            while (s < next.length && kind(next[s]) === 0) s++;
            const trimmed = next.slice(s);
            col = lines[t.row].length;
            lines[t.row] = lines[t.row].concat(trimmed.length > 0 && lines[t.row].length > 0 ? [" "] : [], trimmed);
            lines.splice(t.row + 1, 1);
          }
          write({ lines, row: t.row, col: Math.min(col, Math.max(0, lines[t.row].length - 1)) });
          return true;
        }
        case "~": {
          for (let i = 0; i < n && t.col + i < line.length; i++) {
            const g = line[t.col + i];
            line[t.col + i] = g === g.toUpperCase() ? g.toLowerCase() : g.toUpperCase();
          }
          write({ lines: t.lines, row: t.row, col: Math.min(t.col + n, lastCol(t, t.row)) });
          return true;
        }
        case "p":
          put(t, true, n);
          return true;
        case "P":
          put(t, false, n);
          return true;
        case "u":
          api.keys.run("editor.undo", n);
          write(clampNormal(read()));
          return true;
        case "ctrl+r":
          api.keys.run("editor.redo", n);
          write(clampNormal(read()));
          return true;
        case "r":
          pending = "r";
          count = n;
          return true;
        case "i":
          setMode("insert");
          return true;
        case "a":
          write({ lines: t.lines, row: t.row, col: Math.min(line.length, t.col + 1) });
          setMode("insert");
          return true;
        case "I":
          write({ lines: t.lines, row: t.row, col: firstNonBlank(line) === line.length ? line.length : firstNonBlank(line) });
          setMode("insert");
          return true;
        case "A":
          write({ lines: t.lines, row: t.row, col: line.length });
          setMode("insert");
          return true;
        case "o":
        case "O": {
          const lines = t.lines.map((l) => l.slice());
          const at = k === "o" ? t.row + 1 : t.row;
          lines.splice(at, 0, []);
          write({ lines, row: at, col: 0 });
          setMode("insert");
          return true;
        }
      }
      return true;
    };

    api.keys.action({ id: "vi.normal", scope: "input", run: (key) => normalKey(key) });
    // No hint: it would show with every keymap (the action has no key of its own), and the composer's border says the mode.
    api.keys.action({
      id: "vi.escape",
      scope: "chat",
      run: () => {
        // The suggestion strip and the request panel keep their Esc; in normal mode the shell's Esc interrupts.
        const c = api.composer.get();
        if (c.strip || c.panel || mode === "normal") return false;
        setMode("normal");
        return true;
      },
    });
    api.keys.action({
      id: "vi.code.g",
      scope: "code",
      run: () => {
        if (codeG) api.code.toTop();
        codeG = !codeG;
        return true;
      },
    });
    const normal = api.keys.layer("vi-normal", { input: { "*": "vi.normal" } });
    // Esc in the chat: the strip's and the panel's first (the layer's entry stands in for the base's), then the mode's.
    const always = api.keys.layer("vi", {
      chat: { escape: ["chat.strip.hide", "chat.panel.escape", "vi.escape"] },
      code: { "char:j": "code.down", "char:k": "code.up", "char:G": "code.end", "char:g": "vi.code.g" },
    });
    normal.off();
    always.off();

    const follow = (): void => {
      if (api.state.keymap() === "vi") {
        always.on();
        setMode(mode);
      } else {
        always.off();
        normal.off();
        mode = "insert";
        api.composer.setLabel("You");
      }
    };
    api.keys.keymap({ id: "vi", name: "vi" });
    api.on("keymapChanged", follow);
    // A message sent: the composer is empty, in insert mode.
    api.on("messageSending", () => {
      if (api.state.keymap() === "vi" && mode === "normal") setMode("insert");
    });
    follow();
  },
});

export {};
