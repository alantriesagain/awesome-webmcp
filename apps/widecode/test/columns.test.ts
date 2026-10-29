// ffi: @light/plugins/native/ffi.json
// The columns' widths: config.json's "columns" (cells, or a percentage of the terminal; the files
// column named "files"; the code column takes the rest, so a width for it is refused, as is
// anything else), the others giving way when the code column would get under 20 cells; a drag on
// the border between two columns resizes the one with a width of its own, from either side of the
// border, and state.json keeps it for the next run, over config.json's; a press inside a column
// still makes it active; /columns says the widths, /columns reset forgets the drags.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { ColumnWidths, settingOf } from "../src/views/column-widths.ts";
import { createWidecode } from "../src/compose.ts";
import { DEFAULT_STYLE, MouseEvent, TElement, TRoot, frames, hitTest, layout, mount, unmount } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";

const ids = ["chat", "tools", "side", "code"];
const own = [80, 32, 24, 0];
const sizes = new ColumnWidths();
eq("nothing set: what each column asks for, the code column the rest", sizes.layout(ids, own, 200).join(","), "80,32,24,0");
eq("settings: cells, or a share of the terminal", String(settingOf(40)?.cells ?? -1) + "," + String(settingOf("25%")?.share ?? -1), "40,0.25");
ok("anything else is no setting", settingOf("x") === null && settingOf(0) === null && settingOf("120%") === null);
eq("config.json's columns, the files column by its name", sizes.configure(JSON.parse('{"chat": "50%", "files": 40}')) + sizes.layout(ids, own, 200).join(","), "100,32,40,0");
ok("a width for the code column, or a word, is refused and said", sizes.configure(JSON.parse('{"code": 50, "tools": "wide"}')).includes("ignored code, tools"));
sizes.configure(JSON.parse('{"chat": 150, "tools": 60}'));
const narrow = sizes.layout(ids, own, 200);
ok("more than fits: the others give way, the code column keeps 20 cells", narrow[0] + narrow[1] + narrow[2] <= 180 && narrow[2] >= 12);
sizes.configure(JSON.parse('{"chat": 90}'));
sizes.drag("chat", 70);
eq("a drag's width over config.json's", String(sizes.layout(ids, own, 200)[0]), "70");
const again = new ColumnWidths();
again.restore(sizes.kept());
eq("kept for the next run", JSON.stringify(sizes.kept()) + " " + String(again.layout(ids, own, 200)[0]), '[["chat",70]] 70');
sizes.drag("tools", 3);
eq("no column under 12 cells", String(sizes.layout(ids, own, 200)[1]), "12");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-columns-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const ws = await openWorkspace(folder, 100);
  const w = createWidecode(ws, new Conversation(ws.folder), null);
  const root = new TRoot();
  const W = 200;
  const H = 24;
  w.shell.resize(W);
  mount(w.shell, root);
  await w.host.load();
  const settle = (): void => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, W, H, DEFAULT_STYLE);
    }
  };
  settle();
  /** A left drag from (x0, y) to (x1, y), its moves and release going to what was pressed. */
  const drag = (x0: number, x1: number, y: number): void => {
    const target = hitTest(root, x0, y);
    if (!(target instanceof TElement)) return;
    target.dispatch(new MouseEvent("mousedown", x0, y, 0, false, false, false));
    target.dispatch(new MouseEvent("mousemove", x1, y, 0, false, false, false));
    target.dispatch(new MouseEvent("mouseup", x1, y, 0, false, false, false));
    settle();
  };
  const shell = w.shell;
  const chat = shell.widthOf("chat");
  w.host.screen.focus("code");
  drag(chat - 1, chat + 9, 5);
  eq("a drag on the chat's right border widens it", String(shell.widthOf("chat")), String(chat + 10));
  ok("the tools column moved with it, the drag did not make the chat active", shell.xOf("tools") === chat + 10 && w.host.screen.active.peek() === "code");
  const side = shell.widthOf("side");
  const codeAt = shell.xOf("code");
  drag(codeAt, codeAt - 6, 5);
  eq("from the code column's side of a border, the files column it shares it with", String(shell.widthOf("side")), String(side - 6));
  drag(shell.xOf("side") + shell.widthOf("side") - 1, shell.xOf("side") + shell.widthOf("side") + 3, 5);
  eq("and from the files column's side", String(shell.widthOf("side")), String(side - 2));
  eq("state.json keeps them", JSON.stringify(w.host.kernel.settings.state("columns")), '[["chat",' + String(chat + 10) + '],["side",' + String(side - 2) + "]]");
  drag(5, 5, 5);
  ok("a press inside a column still makes it active", w.host.screen.active.peek() === "chat");
  w.host.roles.chat.submit("/columns");
  ok("/columns says the widths", w.host.screen.message.peek().startsWith("chat " + String(chat + 10) + " · tools ") && w.host.screen.message.peek().includes("/columns reset"));
  w.host.roles.chat.submit("/columns reset");
  ok("/columns reset forgets the drags", shell.widthOf("chat") === chat && JSON.stringify(w.host.kernel.settings.state("columns")) === "[]");

  unmount(w.shell);
  w.host.kernel.stop();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
