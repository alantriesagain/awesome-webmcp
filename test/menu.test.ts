// ffi: @lightstart/plugins/native/ffi.json
// The menu bar: a plugin's ui.menu rows under their menu with the key bound to their action, a
// press on a title opening the dropdown, a press on an item running the action, F10 opening the
// first menu, Escape closing it, and the columns starting under the bar.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { KeyEvent, MouseEvent, TElement, hitTestLayers } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { Headless } from "@lightstart/test/headless.ts";

const W = 200;
const H = 24;

const menus = `widecode.plugin({
  id: "test-menus",
  activate(api) {
    api.keys.action({ id: "test.greet", scope: "", help: "greet", key: ["ctrl+char:g"], run: () => { api.tell("menu ran"); return true; } });
    api.ui.menu({ menu: "Test", label: "Greet", action: "test.greet", order: 100 });
    api.ui.menu({ menu: "Test", label: "-", order: 101 });
    api.ui.menu({ menu: "Test", label: "Missing", action: "test.none", order: 102 });
  },
});`;

const main = async (): Promise<void> => {
  const repo = mkdtempSync(join(tmpdir(), "widecode-menu-"));
  writeFileSync(join(repo, "a.txt"), "a\n");
  const ws = await openWorkspace(repo, 100);
  const w = composeWidecode(ws, new Conversation(ws.folder));
  w.js.extra = [new PluginSource("test-menus.js", menus)];
  w.start(null, new NoStateFile(), []);
  w.shell.resize(W);
  const headless = new Headless(w.shell, W, H);
  const root = headless.root;
  await w.host.load();
  const screen = (): string[] => headless.screen();
  const key = (name: string, text: string): KeyEvent => new KeyEvent(name, text, false, false, false);
  const press = (x: number, y: number): void => {
    const target = hitTestLayers(root, x, y);
    if (target instanceof TElement) target.dispatch(new MouseEvent("mousedown", x, y, 0, false, false, false));
    headless.paint();
  };

  let lines = screen();
  ok("the bar is the first row, with the brand and the menu", lines[0].includes("◆ widecode") && lines[0].includes(" Test"));
  ok("the columns start under it, a blank row between", lines[1].trim() === "" && lines[2].includes(" Chat "));
  const bar = w.shell.menuBar.menus.value;
  eq("the built-in menus come first, then the plugin's", bar.map((m) => m.title).join(" "), "Session Pane View Help Test");
  const quit = bar[0].items.find((i) => i.label === "Quit");
  ok("the built-in Quit row shows the key bound to app.quit", quit !== undefined && quit.keys === w.host.kernel.keys.label("app.quit") && quit.enabled);
  const test = bar[4];
  eq("the plugin's menu has its three rows", String(test.items.length), "3");
  eq("the item's key is the one the keymap binds", test.items[0].keys, w.host.kernel.keys.label("test.greet"));
  ok("an action that does not exist leaves its item disabled", !test.items[2].enabled);
  ok("a separator separates", test.items[1].separator);

  const title = lines[0].indexOf("Test");
  press(title, 0);
  eq("a press on a title opens its menu", String(w.shell.menuBar.openIndex.value), "4");
  lines = screen();
  ok("the dropdown shows the label and its key", lines.some((l) => l.includes("Greet") && l.includes(w.host.kernel.keys.label("test.greet"))));
  const row = lines.findIndex((l) => l.includes("Greet"));
  press(lines[row].indexOf("Greet"), row);
  eq("a press on an item runs its action", w.host.screen.message.peek(), "menu ran");
  eq("and closes the menu", String(w.shell.menuBar.openIndex.value), "-1");

  ok("F10 is an action", w.shell.handleKey(key("f10", "")));
  eq("F10 opens the first menu", String(w.shell.menuBar.openIndex.value), "0");
  ok("Escape closes it and is taken", w.shell.handleKey(key("escape", "")) && w.shell.menuBar.openIndex.value === -1);
  ok("with the menu closed Escape is the shell's again", !w.shell.handleKey(key("escape", "")));

  const order = (): string => w.host.screen.columnOrder().join(" ");
  const first = w.host.screen.columnOrder()[0];
  w.host.screen.focus(first);
  const right = w.host.kernel.actions.find("menus.column.right");
  ok("Pane's Move column right is an action", right !== null);
  if (right !== null) right.onRun(key("none", ""), 1);
  eq("it moves the active column one place right", w.host.screen.columnOrder()[1], first);
  const left = w.host.kernel.actions.find("menus.column.left");
  if (left !== null) left.onRun(key("none", ""), 1);
  eq("and Move column left moves it back", w.host.screen.columnOrder()[0], first);
  ok("the order is the columns'", order().split(" ").length === w.host.screen.columns.length);

  w.js.extra = [];
  w.js.reload();
  lines = screen();
  ok("a plugin removed leaves no menu", !lines[0].includes(" Test") && !w.host.screen.menuEntries.some((e) => e.menu === "Test"));

  headless.unmount();
  w.host.kernel.stop();
  ws.close();
  rmSync(repo, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
