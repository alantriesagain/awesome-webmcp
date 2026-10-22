// The composer: the chat's input with its editing as actions in the "input" scope (light's editor
// operations, each under its name with the keys light's own table gives it, so a keymap can rebind
// them), undo and redo over snapshots the shell takes around each key, and the last kill, for
// yank. A kill to the line's end goes to the clipboard too.
import { ChatHost } from "./host.ts";
import { Binder } from "@light/kernel/actions.ts";
import { chipImages, refKind } from "@widecode/conversation/attach.ts";
import { ChangeEvent, type KeyEvent, TInput, backspace, clearInput, del, deleteWord, graphemes, insertText, killToEnd, killToStart, lineEnd, lineStart, moveLeft, moveRight, moveRow, newline, submit, wordLeft, wordRight } from "@bootstrapp/light/native/tui";

/** The composer's text and caret at a moment. */
export class Snapshot {
  readonly lines: string[];
  readonly row: number;
  readonly col: number;

  constructor(lines: string[], row: number, col: number) {
    this.lines = lines;
    this.row = row;
    this.col = col;
  }
}

/** How many snapshots undo keeps. */
const UNDO_MAX = 100;
export const INSERT = "editor.insert";
const UNDO = "editor.undo";
const REDO = "editor.redo";

export class Composer {
  readonly input: TInput;
  undo: Snapshot[] = [];
  redo: Snapshot[] = [];
  /** The last text a kill removed, for yank. */
  yanked = "";
  /** The action that took the last key ("" for none): consecutive inserts undo as one. */
  lastId = "";
  /** An undo or redo ran during the key (an action of a plugin ran it): the key records nothing. */
  private restored = false;
  /** The file references pasted as chips, by "Image"/"File" and N, expanded back on send. */
  private refs = new Map<string, string>();
  private imgSeq = 0;
  private fileSeq = 0;

  constructor(input: TInput) {
    this.input = input;
  }

  /** Pasted `text` with each reference as a chip, the reference kept for send. */
  private chip(text: string): string {
    return chipImages(text, (raw: string) => {
      const kind = refKind(raw);
      const n = kind === "image" ? ++this.imgSeq : ++this.fileSeq;
      this.refs.set(kind + ":" + String(n), raw);
      return n;
    });
  }

  /** A message's text with each chip back to the reference it was pasted from, for send (a path with spaces quoted, so it is read as one reference). */
  expand(text: string): string {
    return text.replace(/\[(Image|File) #(\d+)\]/g, (whole: string, kind: string, n: string) => {
      const raw = this.refs.get(kind.toLowerCase() + ":" + n);
      if (raw === undefined) return whole;
      return /\s/.test(raw) ? "'" + raw + "'" : raw;
    });
  }

  snapshot(): Snapshot {
    const i = this.input;
    return new Snapshot(i.lines.slice(), i.row, i.col);
  }

  private restore(s: Snapshot): void {
    this.set(s.lines, s.row, s.col);
  }

  /** The text and caret (clamped to it), as a plugin sets them; a change event, so completion follows. */
  set(lines: string[], row: number, col: number): void {
    const i = this.input;
    i.lines = lines.length > 0 ? lines.slice() : [""];
    i.row = Math.max(0, Math.min(row, i.lines.length - 1));
    i.col = Math.max(0, Math.min(col, graphemes(i.lines[i.row]).length));
    i.invalidate();
    i.dispatch(new ChangeEvent(i.value()));
  }

  private same(s: Snapshot): boolean {
    const i = this.input;
    if (s.lines.length !== i.lines.length) return false;
    for (let k = 0; k < s.lines.length; k++) if (s.lines[k] !== i.lines[k]) return false;
    return true;
  }

  /** After a key: `before` goes on the undo stack when the text changed by action `id` (inserts in a row as one step); undo and redo keep their stacks. */
  record(before: Snapshot, id: string): void {
    const restored = this.restored;
    this.restored = false;
    if (id === UNDO || id === REDO || restored) {
      this.lastId = id;
      return;
    }
    const changed = !this.same(before);
    const coalesce = changed && id === INSERT && this.lastId === INSERT && this.undo.length > 0;
    this.lastId = id;
    if (!changed) return;
    this.redo = [];
    if (coalesce) return;
    this.undo.push(before);
    if (this.undo.length > UNDO_MAX) this.undo.shift();
  }

  doUndo(): boolean {
    this.restored = true;
    const s = this.undo.pop();
    if (s === undefined) return false;
    this.redo.push(this.snapshot());
    this.restore(s);
    return true;
  }

  doRedo(): boolean {
    this.restored = true;
    const s = this.redo.pop();
    if (s === undefined) return false;
    this.undo.push(this.snapshot());
    this.restore(s);
    return true;
  }

  /** The editing actions in the "input" scope, each with its keys, as `owner`'s; what Ctrl+K kills goes to the clipboard too. */
  addActions(host: ChatHost, owner: string): void {
    const i = this.input;
    const bind = new Binder(host.kernel().actions, owner, "input");
    const times = (count: number, op: () => void): boolean => {
      for (let k = 0; k < Math.max(1, count); k++) op();
      return true;
    };
    // Any character or paste, with no modifier (a key with one is some action's or nobody's). A
    // pasted image path becomes a chip; its reference goes back in when the message is sent.
    bind.add(INSERT, ["*"], "", (key: KeyEvent) => {
      let text = key.typedText();
      if (text.length === 0) return false;
      if (key.key === "paste") text = this.chip(text);
      insertText(i, text);
      return true;
    });
    bind.add("editor.left", ["left", "shift+left"], "", (_key: KeyEvent, count: number) => times(count, () => moveLeft(i)));
    bind.add("editor.right", ["right", "shift+right"], "", (_key: KeyEvent, count: number) => times(count, () => moveRight(i)));
    // Ctrl+←/→ reach here only while there is text: empty, the shell's column keys take them.
    bind.add("editor.wordLeft", ["alt+left", "ctrl+left", "alt+char:b"], "by a word", (_key: KeyEvent, count: number) => times(count, () => wordLeft(i)));
    bind.add("editor.wordRight", ["alt+right", "ctrl+right", "alt+char:f"], "by a word", (_key: KeyEvent, count: number) => times(count, () => wordRight(i)));
    // False at the first or last line, so a key bound before (the history's ↑↓) is not in the way, and one after can take it.
    bind.add("editor.up", ["up", "shift+up", "ctrl+up"], "", (_key: KeyEvent, count: number) => {
      let moved = false;
      for (let k = 0; k < Math.max(1, count); k++) if (moveRow(i, -1)) moved = true;
      return moved;
    });
    bind.add("editor.down", ["down", "shift+down", "ctrl+down"], "", (_key: KeyEvent, count: number) => {
      let moved = false;
      for (let k = 0; k < Math.max(1, count); k++) if (moveRow(i, 1)) moved = true;
      return moved;
    });
    bind.add("editor.lineStart", ["home", "shift+home", "alt+home", "ctrl+char:a"], "the line's start", () => {
      lineStart(i);
      return true;
    });
    bind.add("editor.lineEnd", ["end", "shift+end", "alt+end", "ctrl+char:e"], "the line's end", () => {
      lineEnd(i);
      return true;
    });
    bind.add("editor.backspace", ["backspace", "shift+backspace", "ctrl+char:h"], "", (_key: KeyEvent, count: number) => times(count, () => backspace(i)));
    bind.add("editor.delete", ["delete", "ctrl+delete", "alt+delete", "ctrl+char:d"], "deletes forward", (_key: KeyEvent, count: number) => times(count, () => del(i)));
    bind.add("editor.killToStart", ["ctrl+char:u"], "kills to the line's start", () => {
      const killed = killToStart(i);
      if (killed.length > 0) this.yanked = killed;
      return true;
    });
    bind.add("editor.killToEnd", ["ctrl+char:k"], "kills to the line's end", () => {
      const killed = killToEnd(i);
      if (killed.length > 0) {
        this.yanked = killed;
        host.screen().copy(killed);
      }
      return true;
    });
    bind.add("editor.deleteWord", ["ctrl+char:w", "alt+backspace", "ctrl+backspace"], "deletes the word before", (_key: KeyEvent, count: number) =>
      times(count, () => {
        const deleted = deleteWord(i);
        if (deleted.length > 0) this.yanked = deleted;
      }),
    );
    bind.add("editor.yank", ["ctrl+char:y"], "yanks the last kill", (_key: KeyEvent, count: number) => {
      if (this.yanked.length === 0) return true;
      return times(count, () => insertText(i, this.yanked));
    });
    bind.add("editor.newline", ["alt+enter", "shift+enter", "ctrl+char:j"], "adds a line", () => {
      newline(i);
      return true;
    });
    bind.add("editor.submit", ["enter", "ctrl+enter"], "sends", () => {
      submit(i);
      return true;
    });
    // Reached only while there is text (the shell's quit yields then): empty, Ctrl+C quits.
    bind.add("editor.clear", ["ctrl+char:c"], "clears the message", () => {
      if (i.isEmpty()) return false;
      clearInput(i);
      return true;
    });
    bind.add(UNDO, ["ctrl+char:_"], "undoes", (_key: KeyEvent, count: number) => {
      for (let k = 0; k < Math.max(1, count); k++) if (!this.doUndo()) break;
      return true;
    });
    bind.add(REDO, ["alt+char:_"], "redoes", (_key: KeyEvent, count: number) => {
      for (let k = 0; k < Math.max(1, count); k++) if (!this.doRedo()) break;
      return true;
    });
  }
}
