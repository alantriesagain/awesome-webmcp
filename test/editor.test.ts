// ffi: @lightstart/plugins/native/ffi.json
// The composer's editing as actions in the "input" scope (src/chat's composer.ts), every
// key through the shell: characters and a paste insert, a modifier on a character inserts nothing;
// each editing key and the modifier variants light's editor took (Shift with an arrow, Ctrl+H,
// Ctrl+Backspace, Ctrl+Enter); a count repeats a move or a delete; the kills keep what they removed
// for yank, Ctrl+K's going to the clipboard too; undo and redo over the keys (a run of typing as
// one step, broken by a move), capped; Tab is a no-op without the strip; a key in the code column
// never reaches the composer; Ctrl+←/→ switch columns (the shell's, before the editor's).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osc52 } from "@lightstart/tui/clipboard.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-editor-"));
  const w = await openWidecode({ folder, load: true });
  const copied: string[] = [];
  w.host.screen.clipboard.mode = "osc52";
  w.host.screen.clipboard.onWrite = (text: string) => copied.push(text);
  const input = w.chat.pane.input;
  const composer = w.chat.pane.composer;
  const press = (name: string, text = "", ctrl = false, alt = false, shift = false): boolean => w.shell.handleKey(new KeyEvent(name, text, ctrl, alt, shift));
  const type = (s: string): void => {
    for (const ch of s) press("char", ch);
  };
  const state = (): string => JSON.stringify(input.lines) + " @" + String(input.row) + ":" + String(input.col);
  const clear = (): void => {
    composer.set([""], 0, 0);
    composer.undo = [];
    composer.redo = [];
    composer.lastId = "";
  };
  w.host.screen.focus("chat");

  type("héllo");
  eq("characters insert", state(), '["héllo"] @0:5');
  ok("a character with a modifier inserts nothing (no action takes it)", !press("char", "x", true) && !press("char", "x", false, true) && state() === '["héllo"] @0:5');
  press("paste", " a\nb");
  eq("a paste inserts, its newline a line", state(), '["héllo a","b"] @1:1');
  press("left");
  press("left", "", false, false, true);
  eq("← and Shift+← move", state(), '["héllo a","b"] @0:7');
  press("home");
  press("right");
  press("end", "", false, false, true);
  eq("Home, →, Shift+End", state(), '["héllo a","b"] @0:7');
  press("char", "a", true);
  press("char", "e", true);
  eq("Ctrl+A, Ctrl+E", state(), '["héllo a","b"] @0:7');
  press("up");
  press("down", "", false, false, true);
  eq("↑ at the first line stays (the history has none), Shift+↓ moves", state(), '["héllo a","b"] @1:1');
  press("up", "", true);
  eq("Ctrl+↑", state(), '["héllo a","b"] @0:1');
  press("backspace", "", true);
  eq("Ctrl+Backspace deletes the word before (one letter here; Ctrl+H, how most terminals send it, is a backspace)", state(), '["éllo a","b"] @0:0');
  press("delete", "", true);
  eq("Ctrl+Delete deletes forward", state(), '["llo a","b"] @0:0');
  press("char", "d", true);
  press("char", "h", true);
  eq("Ctrl+D, Ctrl+H", state(), '["lo a","b"] @0:0');
  press("end");
  press("backspace", "", false, true);
  eq("Alt+Backspace deletes the word before", state(), '["lo ","b"] @0:3');
  press("enter", "", false, false, true);
  press("enter", "", false, true);
  press("char", "j", true);
  eq("Shift+Enter, Alt+Enter, Ctrl+J add lines", state(), '["lo ","","","","b"] @3:0');

  // Counts.
  clear();
  type("one two three");
  const run = (id: string, count: number): boolean => {
    const a = w.host.kernel.actions.find(id);
    return a !== null && a.onRun(new KeyEvent("none", "", false, false, false), count);
  };
  run("editor.wordLeft", 2);
  eq("a count repeats a move", state(), '["one two three"] @0:4');
  run("editor.delete", 3);
  eq("and a delete", state(), '["one  three"] @0:4');
  run("editor.left", 10);
  eq("past the start it stops", state(), '["one  three"] @0:0');

  // Kills, yank, the clipboard.
  clear();
  copied.length = 0;
  type("first line");
  press("home");
  press("right");
  press("right");
  press("char", "k", true);
  eq("Ctrl+K kills to the line's end and puts it on the clipboard", state() + " " + copied.join("|"), '["fi"] @0:2 ' + osc52("rst line"));
  press("char", "y", true);
  eq("Ctrl+Y yanks it back", state(), '["first line"] @0:10');
  press("char", "w", true);
  press("char", "w", true);
  eq("Ctrl+W deletes the word before, twice", state(), '[""] @0:0');
  press("char", "y", true);
  eq("the last kill is what yank gives", state(), '["first "] @0:6');
  press("char", "u", true);
  press("char", "y", true);
  eq("Ctrl+U kills to the start, yank gives that", state(), '["first "] @0:6');
  press("end");
  press("char", "k", true);
  eq("Ctrl+K at the end of the last line kills nothing", String(copied.length) + " " + state(), '1 ["first "] @0:6');

  // Undo and redo.
  clear();
  type("abc");
  press("left");
  type("xy");
  eq("typed", state(), '["abxyc"] @0:4');
  press("char", "_", true);
  eq("Ctrl+_ undoes the run of typing since the move", state(), '["abc"] @0:2');
  press("char", "_", true);
  eq("and the run before it", state(), '[""] @0:0');
  ok("then nothing", press("char", "_", true) && state() === '[""] @0:0');
  run("editor.redo", 1);
  eq("redo brings a step back, the caret where it was", state(), '["abc"] @0:2');
  run("editor.redo", 1);
  eq("and the next", state(), '["abxyc"] @0:4');
  press("char", "_", true);
  type("Z");
  ok("a change after an undo drops the redo", String(composer.redo.length) === "0" && state() === '["abZc"] @0:3');
  press("char", "k", true);
  press("char", "_", true);
  eq("an undo of a kill", state(), '["abZc"] @0:3');
  clear();
  for (let i = 0; i < 120; i++) {
    type("a");
    press("left");
    press("right");
  }
  eq("the undo stack is capped", String(composer.undo.length), "100");

  // Tab, the code column, the shell's Ctrl+←/→.
  clear();
  type("tab");
  ok("Tab with no strip is a no-op (no focus move: nothing takes it)", !press("tab") && state() === '["tab"] @0:3');
  w.host.screen.focus("code");
  ok("a key in the code column never reaches the composer", !press("char", "q") && !press("backspace") && state() === '["tab"] @0:3');
  ok("Ctrl+→ switches columns (the shell's, before the editor's word move)", press("right", "", true) && w.host.screen.active.peek() !== "code");
  w.host.screen.focus("chat");
  press("home");
  ok("Ctrl+← in the chat with text moves by a word, the column stays; Alt+← moves by a word", press("end") && press("left", "", true) && w.host.screen.active.peek() === "chat" && state() === '["tab"] @0:0');
  clear();
  ok("Ctrl+← with the composer empty switches columns", press("left", "", true) && w.host.screen.active.peek() !== "chat");
  w.host.screen.focus("chat");
  type("tab");
  press("end");
  press("left", "", false, true);
  eq("Alt+← moved by a word", state(), '["tab"] @0:0');

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
