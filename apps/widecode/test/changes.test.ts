// ffi: @light/plugins/native/ffi.json
// The changes: `diff --numstat -z` parsed (a binary file, a rename, a tab in a name); on a temp
// repository the changed files with their marks and line counts (modified, deleted, untracked,
// binary), newest first, Claude's edits marked. In the app, the JS plugin's strip of the band: split
// from the status table at the chat's edge, its rows (summary, cells with names told apart by their
// folder, the open file highlighted, "+N more" when they do not fit), presses on them, and [ ] /
// Alt+↑↓ walking the changed files.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWidecode } from "../src/compose.ts";
import { buildChanges, FileChange, readNumstat, UntrackedCounter } from "@light/workspace/changes.ts";
import { parseNumstat } from "@light/workspace/git-parse.ts";
import { JsBand } from "../src/runtime/views.ts";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { openRepo, readStatus } from "@light/workspace/git.ts";
import { KeyEvent } from "@bootstrapp/light/native/tui";
import { Line } from "@bootstrapp/light/native/tui/lines.ts";
import { marksOf } from "@light/workspace/tree.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { Headless } from "@light/test/headless.ts";

const textOf = (l: Line): string => l.runs.map((r) => r.text).join("").replace(/\s+$/, "");
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const parsed = parseNumstat(["3\t1\tsrc/a.js", "-\t-\tlogo.png", "2\t0\t", "old/x.js", "new/x.js", "1\t1\tname\twith tab.txt", ""].join("\u0000"));
const shown: string[] = [];
for (const k of parsed.keys()) {
  const c = parsed.get(k);
  if (c !== undefined) shown.push(k + "=" + (c.binary ? "bin" : "+" + String(c.added) + "-" + String(c.removed)));
}
eq("numstat: counts, a binary file, a rename's destination, a tab in a name", shown.join(" "), "src/a.js=+3-1 logo.png=bin new/x.js=+2-0 name\twith tab.txt=+1-1");

const repo = mkdtempSync(join(tmpdir(), "widecode-changes-"));
const git = (args: string[]): void => {
  const all = ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"];
  for (const a of args) all.push(a);
  spawnSync("git", all, { encoding: "utf8" });
};
mkdirSync(join(repo, "controllers"), { recursive: true });
mkdirSync(join(repo, "views"), { recursive: true });
for (const n of ["account", "agenda", "catalog"]) writeFileSync(join(repo, "controllers", n + ".js"), "a\nb\nc\n");
writeFileSync(join(repo, "views", "account.js"), "x\n");
writeFileSync(join(repo, "old.js"), "1\n2\n3\n4\n");
writeFileSync(join(repo, "logo.bin"), Buffer.from([1, 0, 2, 3]));
git(["init", "-q"]);
git(["add", "."]);
git(["commit", "-qm", "init"]);
writeFileSync(join(repo, "controllers", "account.js"), "a\nB\nc\nd\n");
writeFileSync(join(repo, "views", "account.js"), "y\nz\n");
writeFileSync(join(repo, "controllers", "catalog.js"), "a\n");
writeFileSync(join(repo, "new-feature.ts"), "1\n2\n3");
writeFileSync(join(repo, "logo.bin"), Buffer.from([1, 0, 9, 9, 9]));
unlinkSync(join(repo, "old.js"));
// Distinct mtimes, oldest first: catalog, views/account, new-feature, logo, controllers/account.
const order = ["controllers/catalog.js", "views/account.js", "new-feature.ts", "logo.bin", "controllers/account.js"];
for (let i = 0; i < order.length; i++) utimesSync(join(repo, order[i]), new Date(1700000000000 + i * 60000), new Date(1700000000000 + i * 60000));

const row = (f: FileChange): string => f.mark + " " + f.path + " " + (f.binary ? "bin" : "+" + String(f.added) + "-" + String(f.removed)) + (f.byAgent ? " ●" : "");

const main = async (): Promise<void> => {
  const r = await openRepo(repo);
  const status = await readStatus(r, repo);
  const marks = marksOf(status.entries);
  const counts = await readNumstat(r, repo, "HEAD");
  const counter = new UntrackedCounter();
  const times = new Map<string, number>();
  const claude = new Set<string>(["controllers/catalog.js"]);
  let list = buildChanges(repo, marks, counts, counter, times, claude);
  eq("the changed files, newest first; the deleted one last (no time)", list.map(row).join(" | "), "M controllers/account.js +2-1 | M logo.bin bin | U new-feature.ts +3-0 | M views/account.js +2-1 | M controllers/catalog.js +0-2 ● | D old.js +0-4");
  times.set("controllers/catalog.js", Date.now());
  list = buildChanges(repo, marks, counts, counter, times, claude);
  eq("a change seen now leads", list[0].path, "controllers/catalog.js");
  const first = counter.count(repo, "new-feature.ts");
  eq("an untracked file's count is kept while it is unchanged", String(counter.count(repo, "new-feature.ts") === first), "true");

  // The app: the band under the columns.
  const W = 200;
  const H = 20;
  const ws = await openWorkspace(repo, 100);
  const conversation = new Conversation(ws.folder);
  const app = createWidecode(ws, conversation, null);
  app.shell.resize(W);
  const headless = new Headless(app.shell, W, H);
  await app.host.load();
  const screen = (): string[] => headless.screen();
  const band = screen().slice(H - 3);
  const split = band[0].indexOf("│ 6 files");
  const widths = app.shell.widths();
  let left = 0;
  for (const w of widths.slice(0, -1)) left += w;
  ok("the band: the session under the chat, the changes under the code column", band[0].startsWith(" ◆ widecode-changes-") && split === left && band[1].indexOf("│ no file open") === left);
  let strip: JsBand | null = null;
  for (const b of app.host.screen.band) if (b.id === "changes" && b.view instanceof JsBand) strip = b.view;
  const bar = (width: number): Line[] => (strip !== null ? strip.lines(width) : []);
  // The file opens once read and diffed (longer on a busy machine, seconds in a full parallel run): until the strip names it.
  const open = async (path: string): Promise<void> => {
    app.code.open(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (let i = 0; i < 300; i++) {
      await wait(50);
      if (bar(160).map(textOf)[1].includes("▸ " + name)) break;
    }
  };

  // Claude edits catalog.js: it leads, marked.
  const m = conversation.model;
  m.lastEdit = join(repo, "controllers/catalog.js");
  m.edited.add(m.lastEdit);
  m.editSeq++;
  app.host.conversationChanged.fire();
  // The code column follows the edit first.
  await wait(150);
  await open("views/account.js");
  const wide = bar(160).map(textOf);
  ok("summary: files and lines, the open file and where, the branch and keys", wide[0].startsWith("│ 6 files  +7 −8 ") && wide[1].startsWith("│ ▸ account.js · " + app.host.roles.code.position()) && wide[2].startsWith("│ ⎇ main  [ ] files · n/p changes"));
  ok("cells in columns: Claude's edit marked, names told apart", wide[0].includes("●M catalog.js ") && wide[1].includes(" M controllers/account.js +2 −1") && wide[1].includes(" M views/account.js ") && wide[2].includes(" M logo.bin ") && wide[2].includes("bin"));
  let highlighted = "";
  for (const l of bar(160)) for (const run of l.runs) if (run.bg === "#2a3550") highlighted += run.text;
  ok("the open file's cell highlighted, only it", highlighted.replace(/\s+/g, " ").trim().startsWith("M views/account.js +2 −1 ") && !highlighted.includes("catalog"));
  // A long name, kept out of git's view so it is no change itself.
  const long = "a/very/long/path/to/some-file-with-a-long-name-indeed.json";
  mkdirSync(join(repo, "a/very/long/path/to"), { recursive: true });
  writeFileSync(join(repo, long), "{}\n");
  writeFileSync(join(repo, ".git/info/exclude"), "a/\n");
  await open(long);
  const clipped = bar(160).map(textOf);
  eq("a long open file is clipped: the columns stay put", String(clipped[1].indexOf("controllers/account.js")) + " " + String(clipped[1].includes("…")), String(wide[1].indexOf("controllers/account.js")) + " true");
  await open("views/account.js");
  const narrow = bar(80).map(textOf);
  ok("too many for the width: +N more", narrow[2].endsWith("+4 more"));
  let catalogRow = 0;
  for (let i = 0; i < narrow.length; i++) if (narrow[i].indexOf("catalog.js") >= 0) catalogRow = i;
  strip?.pressAt(catalogRow, narrow[catalogRow].indexOf("catalog.js"));
  await wait(150);
  const pressed = app.code.pane.path.peek();
  strip?.pressAt(0, 1);
  await wait(150);
  const summary = app.code.pane.path.peek();
  strip?.pressAt(2, narrow[2].indexOf("+4 more") + 1);
  eq("a press opens a file; the summary is not a file; +N more shows the rest", pressed + " " + summary + " " + app.host.screen.shownIn("side") + " " + app.host.screen.active.peek(), "controllers/catalog.js controllers/catalog.js files side");

  // new-feature.ts is written last: counted again, and it leads.
  writeFileSync(join(repo, "new-feature.ts"), "1\n2\n3\n4\n5\n");
  eq("and counted again when it changes", String(counter.count(repo, "new-feature.ts").added), "5");
  await app.host.folder.loadStatus();
  await open("old.js");
  const key = (name: string, text: string, alt: boolean): KeyEvent => new KeyEvent(name, text, false, alt, false);
  const walk: string[] = [];
  const step = async (e: KeyEvent): Promise<void> => {
    app.shell.handleKey(e);
    await wait(150);
    walk.push(app.code.pane.path.peek());
  };
  app.host.screen.focus("side");
  await step(key("char", "]", false));
  await step(key("char", "]", false));
  await step(key("char", "[", false));
  app.host.screen.focus("chat");
  ok("in the chat [ is typed, not a step", app.shell.handleKey(key("char", "[", false)) && app.chat.pane.input.value() === "[");
  await step(key("up", "", true));
  await step(key("down", "", true));
  await step(key("down", "", true));
  eq("] [ in the files column, Alt+↑ ↓ anywhere, wrapping", walk.join(" "), "new-feature.ts controllers/catalog.js new-feature.ts old.js new-feature.ts controllers/catalog.js");
  ok("the bar follows the open file", screen().slice(H - 3)[1].includes("▸ catalog.js"));
  headless.unmount();
  ws.close();

  // Outside a repository.
  const plain = mkdtempSync(join(tmpdir(), "widecode-plain-"));
  const pws = await openWorkspace(plain, 100);
  const other = createWidecode(pws, new Conversation(pws.folder), null);
  await other.host.load();
  let lines: Line[] = [];
  for (const b of other.host.screen.band) if (b.id === "changes" && b.view instanceof JsBand) lines = b.view.lines(80);
  eq("outside a repository", lines.length > 0 ? textOf(lines[0]) : "", "│ not a git repository");
  other.host.kernel.stop();
  pws.close();
  rmSync(plain, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
