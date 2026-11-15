// ffi: @light/plugins/native/ffi.json
// What JS plugins draw (natively in QuickJS, under node through wcjs-node.mjs): a side tab from
// their rows (fetched a window at a time), its info row, its tab on the column's top edge with its badge (a
// press on a link shows that tab), presses on both and keys in its scope; a
// strip of the status band from their lines (a live run drawn as the spinner's frame) and a press on it; a segment the status table shows
// where the config names it; a timer; the folder's state and the actions they take (a tab shown,
// the code column opening a file); everything they drew gone when they are switched off by reload.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { KeyEvent, MouseEvent, TElement, hitTest } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";
import { Headless } from "@light/test/headless.ts";

const W = 250;
const H = 16;
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const todo = `widecode.plugin({
  id: "todo",
  activate(api) {
    const items = ["write the plan", "port the models", "port the status"];
    let done = new Set();
    let ticks = 0;
    const panel = api.ui.panel({
      id: "todo", title: "Todo", order: 5,
      width: (cols) => 30,
      count: () => items.length,
      rows: (from, count, width) => items.slice(from, from + count).map((t, i) => ({
        bg: done.has(from + i) ? "#13301f" : "",
        runs: [{ text: done.has(from + i) ? " ✓ " : " · ", fg: "#98c379" }, { text: t, bold: from + i === 0 }],
      })),
      info: () => [{ text: " " + done.size + "/" + items.length + " done", fg: "gray" }],
      badge: () => [{ text: String(items.length - done.size), fg: "#e5c07b" }],
      infoPress: (x) => api.tell("info pressed at " + x),
      press: (row) => { done.has(row) ? done.delete(row) : done.add(row); panel.refresh(); strip.refresh(); },
    });
    api.keys.add("char:a", "todo", "a add", () => { items.push("item " + items.length); panel.refresh(); return true; });
    const strip = api.ui.band({
      id: "todo-band", under: "", order: 9,
      lines: (width) => [{ runs: [{ text: "·", live: "spinner" }, { text: " │ todo: " + done.size + " of " + items.length + " · width " + width, fg: "#61afef" }] }],
      press: (row, x) => api.tell("strip row " + row),
    });
    api.ui.segment({ name: "todo", draw: (ctx) => [{ text: "☐ " + (items.length - done.size) + " in " + ctx.folderName, fg: "#e5c07b" }], press: () => api.tell("segment pressed") });
    api.every(20, () => { ticks++; });
    api.commands.add({ name: "/ticks", run: () => api.tell("ticked " + (ticks > 2 ? "often" : "rarely")) });
    api.commands.add({ name: "/state", run: () => {
      const f = api.state.folder();
      const a = api.state.active();
      api.tell("branch " + f.branch + " · " + Object.keys(f.marks).length + " changed · " + JSON.stringify(f.counts["a.txt"]) + " · column " + a.column + " · in " + a.folderName.slice(0, 14));
    } });
    api.commands.add({ name: "/go", run: () => { api.actions.showPanel("todo"); api.code.open("a.txt"); } });
    api.on("fileShown", () => api.note("shown " + api.code.path()));
  },
});`;

const main = async (): Promise<void> => {
  const repo = mkdtempSync(join(tmpdir(), "widecode-jsui-"));
  const git = (args: string[]): void => {
    const all = ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"];
    for (const x of args) all.push(x);
    spawnSync("git", all, { encoding: "utf8" });
  };
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  const ws = await openWorkspace(repo, 100);
  const w = composeWidecode(ws, new Conversation(ws.folder));
  w.js.extra = [new PluginSource("todo.js", todo)];
  w.start(JSON.parse('{"status": {"lines": [["project", "todo", "note"]]}}'), new NoStateFile(), []);
  w.shell.resize(W);
  const headless = new Headless(w.shell, W, H);
  const root = headless.root;
  await w.host.load();
  const screen = (): string[] => headless.screen();
  const has = (lines: string[], text: string): boolean => lines.some((l) => l.includes(text));
  const press = (name: string, text: string): boolean => w.shell.handleKey(new KeyEvent(name, text, false, false, false));

  w.host.roles.chat.submit("/go");
  await wait(200);
  let lines = screen();
  const sideAt = w.shell.xOf("side");
  const top = (): string => screen()[2].slice(sideAt, sideAt + w.shell.widthOf("side"));
  ok("its tab on the side column's top edge, shown, at its width", top().includes(" Todo") && w.host.screen.shownIn("side") === "todo" && w.shell.widthOf("side") === 30);
  ok("its tab shows its badge", top().includes(" Todo 3 "));
  // The first tab drawn on the edge, Todo kept in view however many come before it.
  const row = top();
  const other = row.slice(1).trimStart().split(" ")[0];
  const otherAt = sideAt + row.indexOf(" " + other) + 1;
  const link = hitTest(root, otherAt, 2);
  if (link instanceof TElement) link.dispatch(new MouseEvent("mousedown", otherAt, 2, 0, false, false, false));
  const pressed = w.host.screen.panelsIn("side").find((p) => p.title === other);
  ok("a press on another tab shows it", other !== "Todo" && pressed !== undefined && w.host.screen.shownIn("side") === pressed.id);
  w.host.screen.showPanel("todo");
  lines = screen();
  ok("its rows and info row", has(lines, " · write the plan") && has(lines, " 0/3 done"));
  ok("the code column opened the file it asked for, and its hook heard", w.host.roles.code.path() === "a.txt");
  ok("its strip in the band", has(lines, "│ todo: 0 of 3 · width "));
  ok("a live run on the strip is drawn as the spinner's frame", lines.some((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] │ todo: /.test(l)));
  ok("its segment where the config names it", has(lines, "☐ 3 in widecode-jsui-"));
  const panel = w.host.screen.findPanel("todo");
  if (panel !== null) panel.press(1, 2);
  lines = screen();
  ok("a press on a row: its change drawn again", has(lines, " ✓ port the models") && has(lines, " 1/3 done") && has(lines, "todo: 1 of 3"));
  if (panel !== null) panel.infoPress(4);
  eq("a press on its info row", w.host.screen.message.peek(), "info pressed at 4");
  w.host.screen.focus("side");
  ok("its key in its scope", press("char", "a") && has(screen(), " · item 3"));
  ok("its hint while it shows", w.host.screen.hints().includes("a add"));
  w.host.roles.chat.submit("/state");
  eq("the folder's state as it reads it", w.host.screen.message.peek(), 'branch main · 1 changed · [1,0,false] · column side · in widecode-jsui-');
  await wait(150);
  w.host.roles.chat.submit("/ticks");
  eq("its timer ticks", w.host.screen.message.peek(), "ticked often");
  const seg = w.host.screen.segments.find("todo");
  const segPress = seg !== null ? seg.onSegmentPress : null;
  if (segPress !== null) segPress();
  eq("a press on its segment", w.host.screen.message.peek(), "segment pressed");

  // An edit that leaves only a command: the tab, strip and segment go with the old version.
  w.js.extra = [new PluginSource("todo.js", `widecode.plugin({ id: "todo", activate(api) { api.commands.add({ name: "/x", run: () => {} }); } });`)];
  w.js.reload();
  lines = screen();
  ok("reloaded without them: tab, strip and segment gone", !has(lines, "Todo") && !has(lines, "todo: ") && w.host.screen.segments.find("todo") === null && w.host.screen.shownIn("side") === "files");
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
