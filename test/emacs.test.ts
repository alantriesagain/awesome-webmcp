// ffi: @lightstart/plugins/native/ffi.json
// The emacs keymap (plugins/emacs/index.ts), the default: Ctrl+F/B and Ctrl+P/N move, Alt+D deletes the
// word after the caret (and joins at a line's end), Alt+< and Alt+> go to the chat's start and end;
// readline's keys as before, Enter sends; the hints say the layer's keys; /keymap default turns it
// off, and back on. Runs under node and natively.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-emacs-"));
  const w = await openWidecode({ folder, load: true });
  const input = w.chat.pane.input;
  const press = (name: string, text = "", ctrl = false, alt = false): boolean => w.shell.handleKey(new KeyEvent(name, text, ctrl, alt, false));
  const state = (): string => JSON.stringify(input.lines) + " @" + String(input.row) + ":" + String(input.col);
  w.host.screen.focus("chat");

  eq("the keymap in use, unasked: emacs", w.host.keys.keymap.value + " " + w.host.keys.names().join(","), "emacs default,emacs,vi");
  w.chat.pane.composer.set(["one two", "three"], 0, 7);
  press("char", "b", true);
  press("char", "b", true);
  eq("Ctrl+B moves back", state(), '["one two","three"] @0:5');
  press("char", "f", true);
  eq("Ctrl+F forward", state(), '["one two","three"] @0:6');
  press("char", "n", true);
  eq("Ctrl+N down a line", state(), '["one two","three"] @1:5');
  press("char", "p", true);
  eq("Ctrl+P up", state(), '["one two","three"] @0:5');
  press("char", "a", true);
  press("char", "d", false, true);
  eq("Alt+D deletes the word after the caret", state(), '[" two","three"] @0:0');
  press("char", "d", false, true);
  eq("and the next, with the space before it", state(), '["","three"] @0:0');
  press("char", "d", false, true);
  eq("at a line's end, the next line joins", state(), '["three"] @0:0');
  press("enter", "", false, true);
  eq("Alt+Enter adds a line, as without the keymap", state(), '["","three"] @1:0');
  press("char", "y", true);
  eq("readline's keys stay: Ctrl+Y yanks nothing killed", state(), '["","three"] @1:0');
  w.chat.pane.composer.set(["/effort low"], 0, 11);
  ok("Enter sends", press("enter") && input.value() === "");
  ok("Alt+< and Alt+> go to the chat's start and end", press("char", "<", false, true) && press("char", ">", false, true));
  eq("the hints name the layer's keys beside the first default (the variants with modifiers left out)", w.host.kernel.keys.hints("input").filter((h) => h.includes("deletes the word after") || h.includes("adds a line") || h.includes("sends")).join(" | ") + " | " + w.host.kernel.keys.label("editor.down"), "Alt+Enter adds a line | Enter sends | Alt+D deletes the word after | ↓ Ctrl+N");

  w.host.roles.chat.submit("/keymap default");
  w.chat.pane.composer.set(["ab"], 0, 2);
  ok("/keymap default: the layer is off, Ctrl+B inserts nothing and moves nothing", !press("char", "b", true) && state() === '["ab"] @0:2');
  w.host.roles.chat.submit("/keymap emacs");
  ok("and back on", press("char", "b", true) && state() === '["ab"] @0:1');

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
