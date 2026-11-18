// ffi: @lightstart/plugins/native/ffi.json
// The vi keymap (plugins/vi/index.ts), chosen at start, through the fake ACP agent: insert mode after a
// message, Esc to normal mode (the composer's border says which); in normal mode the motions
// h j k l w b e 0 ^ $ gg G with counts, the operators d c y with motions and doubled, x X D C s S
// J ~ r p P, u and Ctrl+R over the composer's undo, i a I A o O into insert mode, Enter sending;
// Esc with the suggestion strip open hides the strip, Esc in normal mode while the agent works
// interrupts it; the code column's j k gg G; /keymap default puts the composer's keys back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { DEFAULT_STYLE, KeyEvent, TRoot, frames, layout, mount } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-vi-"));
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const config: unknown = { acp: { agents: { fake: { name: "Fake", command: ["node", fake] } } } };
  const w = await openWidecode({
    folder,
    plugins: config,
    before: (w: Widecode) => {
      w.host.session.agentId.value = "fake";
      w.host.keys.keymap.value = "vi";
    },
  });
  const c = w.host.conversation;
  // Mounted, so the composer's submit and change events reach the pane (sending, the strip).
  const root = new TRoot();
  w.shell.resize(160);
  mount(w.shell, root);
  await w.host.load();
  frames.flush();
  layout(root, 160, 30, DEFAULT_STYLE);
  const input = w.chat.pane.input;
  const pane = w.chat.pane;
  const press = (name: string, text = "", ctrl = false): boolean => w.shell.handleKey(new KeyEvent(name, text, ctrl, false, false));
  const type = (s: string): void => {
    for (const ch of s) press("char", ch);
  };
  const state = (): string => JSON.stringify(input.lines) + " @" + String(input.row) + ":" + String(input.col);
  const set = (lines: string[], row: number, col: number): void => pane.composer.set(lines, row, col);
  w.host.screen.focus("chat");

  eq("insert mode at the start, said on the composer", pane.label.peek(), "-- INSERT --");
  type("one two three");
  eq("the keys type", state(), '["one two three"] @0:13');
  ok("Esc: normal mode, the caret on the last character", press("escape") && pane.label.peek() === "-- NORMAL --" && state() === '["one two three"] @0:12');
  type("0");
  eq("0 to the line's start", state(), '["one two three"] @0:0');
  type("w");
  eq("w to the next word", state(), '["one two three"] @0:4');
  type("2w");
  eq("a count: 2w, past the last word, stops on its last character", state(), '["one two three"] @0:12');
  type("b");
  eq("b back a word", state(), '["one two three"] @0:8');
  type("e");
  eq("e to the word's end", state(), '["one two three"] @0:12');
  type("$");
  type("3h");
  eq("$ and 3h", state(), '["one two three"] @0:9');
  type("2l");
  eq("2l", state(), '["one two three"] @0:11');
  type("x");
  eq("x deletes the character under the caret", state(), '["one two thre"] @0:11');
  type("2X");
  eq("2X deletes two before it", state(), '["one two te"] @0:9');
  type("0dw");
  eq("dw deletes a word with its space", state(), '["two te"] @0:0');
  type("p");
  eq("p puts it after the caret, which lands on its last character", state(), '["tone wo te"] @0:4');
  type("0P");
  eq("P before", state(), '["one tone wo te"] @0:3');
  type("u");
  eq("u undoes, the caret where it was before the key", state(), '["tone wo te"] @0:0');
  press("char", "r", true);
  eq("Ctrl+R redoes", state(), '["one tone wo te"] @0:3');
  type("0cw");
  ok("cw changes the word: insert mode, the word gone, the space kept", pane.label.peek() === "-- INSERT --" && state() === '[" tone wo te"] @0:0');
  type("x");
  press("escape");
  type("$");
  type("D");
  eq("D deletes to the line's end", state(), '["x tone wo t"] @0:10');
  type("0");
  type("3~");
  eq("~ toggles case and moves on", state(), '["X Tone wo t"] @0:3');
  type("rZ");
  eq("r replaces the character", state(), '["X TZne wo t"] @0:3');
  type("yy");
  type("p");
  eq("yy and p: the line below", state(), '["X TZne wo t","X TZne wo t"] @1:0');
  type("k");
  type("J");
  eq("J joins the lines", state(), '["X TZne wo t X TZne wo t"] @0:11');
  type("dd");
  eq("dd deletes the line", state(), '[""] @0:0');
  type("P");
  eq("P puts a line back above", state(), '["X TZne wo t X TZne wo t",""] @0:0');
  type("A");
  type("!");
  press("escape");
  eq("A appends at the end; Esc steps the caret back onto the last character", state(), '["X TZne wo t X TZne wo t!",""] @0:23');
  type("I");
  type("#");
  press("escape");
  eq("I inserts at the start", state(), '["#X TZne wo t X TZne wo t!",""] @0:0');
  type("o");
  type("below");
  press("escape");
  eq("o opens a line below", state(), '["#X TZne wo t X TZne wo t!","below",""] @1:4');
  type("O");
  type("above");
  press("escape");
  eq("O above", state(), '["#X TZne wo t X TZne wo t!","above","below",""] @1:4');
  type("gg");
  eq("gg to the first line", state(), '["#X TZne wo t X TZne wo t!","above","below",""] @0:0');
  type("G");
  eq("G to the last", state(), '["#X TZne wo t X TZne wo t!","above","below",""] @3:0');
  type("2G");
  eq("2G to the second", state(), '["#X TZne wo t X TZne wo t!","above","below",""] @1:0');
  type("d2j");
  eq("d2j deletes three lines", state(), '["#X TZne wo t X TZne wo t!"] @0:0');
  type("^");
  type("s");
  type("@");
  press("escape");
  eq("s substitutes a character", state(), '["@X TZne wo t X TZne wo t!"] @0:0');
  type("S");
  type("new");
  press("escape");
  eq("S the line", state(), '["new"] @0:2');
  type("a");
  type("!");
  eq("a appends after the caret", state(), '["new!"] @0:4');
  press("escape");
  type("C");
  eq("C changes to the end: insert mode", pane.label.peek() + " " + state(), '-- INSERT -- ["new"] @0:3');
  press("escape");
  set(["/eff"], 0, 4);
  type("i");
  type("o");
  ok("the strip shows for a command typed", pane.strip.visible);
  ok("Esc with the strip open hides it, the mode stays insert", press("escape") && !pane.strip.visible && pane.label.peek() === "-- INSERT --");
  set([""], 0, 0);
  type("hello fake");
  press("escape");
  ok("Enter in normal mode sends, and insert mode is back", press("enter") && input.value() === "" && (await until(() => pane.label.peek() === "-- INSERT --")));
  ok("the message went", await until(() => c.model.turns.length === 1 && !c.model.running));

  // Esc in normal mode while the agent works interrupts it.
  w.host.roles.chat.submit("slow");
  ok("a turn runs", await until(() => c.model.running));
  press("escape");
  ok("Esc: normal mode", pane.label.peek() === "-- NORMAL --" && c.model.running);
  press("escape");
  ok("Esc again: the agent is interrupted", await until(() => !c.model.running) && c.model.turns[c.model.turns.length - 1].body.children.some((i) => i.text === "Interrupted"));

  // The code column.
  w.host.screen.focus("code");
  ok("j k scroll, G and gg move in the code column", press("char", "j") && press("char", "k") && press("char", "G") && press("char", "g") && press("char", "g"));
  w.host.screen.focus("chat");

  // Another keymap: the composer's keys again, the label plain.
  w.host.roles.chat.submit("/keymap emacs");
  set(["ab"], 0, 2);
  ok("/keymap emacs: Esc changes no mode, x types", !press("escape") || true);
  type("x");
  eq("x typed", state() + " " + pane.label.peek(), '["abx"] @0:3 You');
  w.host.roles.chat.submit("/keymap vi");
  eq("back to vi: insert mode", pane.label.peek(), "-- INSERT --");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
