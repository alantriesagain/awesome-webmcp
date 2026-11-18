// ffi: @lightstart/plugins/native/ffi.json
// The frontend's screen without a terminal: the app on a temp repository, painted headlessly at
// 200x24. The columns with their titles, the tree with git marks, a file opened by key and
// by a press on its row, its changes in place, n/p between changes, the changed-only switch,
// and a write to the open file shown after the watcher's batch.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { KeyEvent, MouseEvent, hitTest, insertText } from "@lightstart/light/native/tui";
import { projectDir } from "./support/claude-records.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { Headless } from "@lightstart/test/headless.ts";
import { currentWidecode, openWidecode } from "./support/app.ts";

const W = 200;
const H = 25;
let headless: Headless | null = null;
/** Flush and lay out until the line views have measured themselves, then paint. */
/** The headless screen the app is drawn on. */
const mounted = (): Headless => {
  if (headless === null) throw new Error("the app is not mounted");
  return headless;
};
const screen = (): string[] => mounted().screen();
const has = (lines: string[], text: string): boolean => lines.some((l) => l.includes(text));
/** The status bar: the screen's last three rows. */
const statusOf = (lines: string[]): string => lines.slice(H - 3).join("\n");
const rowOf = (lines: string[], text: string): number => lines.findIndex((l) => l.includes(text));
const key = (name: string, text: string): KeyEvent => new KeyEvent(name, text, false, false, false);
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const repo = mkdtempSync(join(tmpdir(), "code-screen-"));
const git = (args: string[]): void => {
  const all = ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"];
  for (const a of args) all.push(a);
  spawnSync("git", all, { encoding: "utf8" });
};
mkdirSync(join(repo, "src"), { recursive: true });
const body: string[] = [];
for (let i = 1; i <= 60; i++) body.push("const line" + String(i) + " = " + String(i) + ";");
// One long line, unchanged, for wrapping.
body[10] = "const line11 = [" + Array.from({ length: 20 }, (_v, i) => "item" + String(i)).join(", ") + "];";
writeFileSync(join(repo, "src", "app.js"), body.join("\n") + "\n");
writeFileSync(join(repo, "README.md"), "# Demo\n");
git(["init", "-q"]);
git(["add", "."]);
git(["commit", "-qm", "init"]);
body[2] = "const line3 = 33;";
body[49] = "const line50 = 500;";
writeFileSync(join(repo, "src", "app.js"), body.join("\n") + "\n");
writeFileSync(join(repo, "notes.md"), "notes\n");

const projects = mkdtempSync(join(tmpdir(), "code-screen-projects-"));
const sessionDir = projectDir(projects, repo);
mkdirSync(sessionDir, { recursive: true });
const rec = (o: unknown): string => JSON.stringify(o) + "\n";
writeFileSync(
  join(sessionDir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl"),
  rec({ type: "user", uuid: "u1", parentUuid: null, cwd: repo, message: { role: "user", content: "Rename the helper" } }) +
    rec({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", content: [{ type: "text", text: "Renamed **helper** to `assist`." }] }, apiBlockIndex: 0 }) +
    rec({ type: "assistant", uuid: "a2", parentUuid: "a1", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: { subagent_type: "Explore", description: "Find callers" } }] }, apiBlockIndex: 1 }) +
    rec({ type: "user", uuid: "r2", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "Two callers." }] } }) +
    rec({ type: "ai-title", aiTitle: "Helper rename" }),
);
mkdirSync(join(sessionDir, "aaaaaaaa-1111-2222-3333-444444444444", "subagents"), { recursive: true });
writeFileSync(
  join(sessionDir, "aaaaaaaa-1111-2222-3333-444444444444", "subagents", "agent-x1.jsonl"),
  rec({ type: "user", uuid: "s1", parentUuid: null, isSidechain: true, message: { role: "user", content: "Find the callers of helper" } }) +
    rec({ type: "assistant", uuid: "s2", parentUuid: "s1", isSidechain: true, message: { id: "sm1", content: [{ type: "text", text: "Found two callers in src." }] }, apiBlockIndex: 0 }),
);
writeFileSync(
  join(sessionDir, "bbbbbbbb-1111-2222-3333-444444444444.jsonl"),
  // Written as text: natively literals with the same keys share their key order (probe p39), and
  // a record starting with "type" is read as bookkeeping.
  '{"parentUuid":null,"type":"user","uuid":"v1","cwd":' + JSON.stringify(repo) + ',"message":{"role":"user","content":"Please look at the failing build on CI, it started after the dependency upgrade yesterday and only fails on Linux"}}\n',
);
// The titled session is the newer one, so the list's order is fixed.
utimesSync(join(sessionDir, "bbbbbbbb-1111-2222-3333-444444444444.jsonl"), 1000, 1000);
writeFileSync(join(sessionDir, "aaaaaaaa-1111-2222-3333-444444444444", "subagents", "agent-x1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find callers", toolUseId: "toolu_A" }));

const main = async (): Promise<void> => {
  // Claude Code's config folder, empty: the Skills tab lists none of this machine's.
  const configDir = mkdtempSync(join(tmpdir(), "widecode-screen-config-"));
  const config: unknown = { claude: { projects, configDir }, sessions: { terminal: false } };
  const widecodeHome = mkdtempSync(join(tmpdir(), "code-screen-widecode-"));
  const store = new Store(widecodeHome);
  store.trust(repo);
  let app = await openWidecode({
    folder: repo,
    plugins: config,
    load: true,
    before: async (w: Widecode) => {
      await w.host.useStore(store);
      w.host.session.titler.executable = join(process.cwd(), "test", "fake-title.sh");
      w.shell.resize(W);
      // An /open starts the app again: the new shell is the one drawn.
      if (headless !== null) headless.unmount();
      headless = new Headless(w.shell, W, H);
    },
  });
  const root = mounted().root;
  let lines = screen();
  ok("the columns with their titles on their top edges, under the menu bar and a blank row", lines[1].trim() === "" && lines[2].includes(" Chat ") && has(lines, "Agents") && has(lines, "Files") && has(lines, "Code"));
  ok("the chat greets a new session", has(lines, "A new session in this folder"));
  /** A tab column's tabs: its top edge, as the row reads. */
  const tabs = (shown: string[], column = "side"): string => {
    const x = app.shell.xOf(column);
    return shown[2].slice(x, x + app.shell.widthOf(column)).replace(/[▏▕]/g, " ").trim().replace(/\s+/g, " ");
  };
  eq("the tabs on the top edge of the side column, with their badges", tabs(lines), "Files 2 Sessions 2");
  ok("and the switch: all files, changed ones", has(lines, " All 3│ Changed 2 "));
  ok("the tools column beside the chat: its Tools, Available and Agents tabs on its top edge", app.shell.xOf("tools") === app.shell.widthOf("chat") && tabs(lines, "tools") === "Tools Available Agents");
  ok("the calls' status beside them on the band", has(lines, "R 0 W 0 X 0 A 0"));
  const secondTab = lines[2].indexOf("Available");
  const tabHit = hitTest(root, secondTab, 2);
  if (tabHit !== null) {
    tabHit.dispatch(new MouseEvent("mousedown", secondTab, 2, 0, false, false, false));
    tabHit.dispatch(new MouseEvent("mouseup", secondTab, 2, 0, false, false, false));
  }
  ok("a press on the second tab on the top edge shows that panel", app.host.screen.shownIn("tools") === "available");
  const codeX = app.shell.xOf("code");
  ok("the code column's top edge draws its permanent Code tab", lines[2].indexOf("Code", codeX) === codeX + 1);
  const codeHit = hitTest(root, codeX + 1, 2);
  if (codeHit !== null) {
    codeHit.dispatch(new MouseEvent("mousedown", codeX + 1, 2, 0, false, false, false));
    codeHit.dispatch(new MouseEvent("mouseup", codeX + 1, 2, 0, false, false, false));
  }
  ok("a press on it keeps it shown and makes the column active", app.code.tabs.activeIndex() === 0 && app.code.tabs.labels()[0] === "Code" && app.host.screen.active.peek() === "code");
  app.host.screen.showPanel("calls");
  app.host.screen.focus("chat");
  const filesTab = app.host.screen.findPanel("files");
  const changedOnly = (): boolean => {
    const kept = app.host.kernel.settings.state("files") as { changedOnly?: unknown } | null;
    return kept !== null && kept.changedOnly === true;
  };
  filesTab?.infoPress(" All 3│ Chan".length);
  ok("a press on Changed shows only the changed files", changedOnly() && !has(screen(), "README.md"));
  filesTab?.infoPress(2);
  ok("a press on All shows them all", !changedOnly() && has(screen(), "README.md"));
  app.host.screen.focus("side");
  app.shell.handleKey(key("char", "c"));
  ok("c switches too", changedOnly());
  app.shell.handleKey(key("char", "c"));
  app.host.screen.focus("chat");
  ok("folders first, closed, with a change dot", has(lines, "▸ src •"));
  ok("an untracked file marked U", has(lines, "notes.md U"));
  ok("the status bar names the folder and branch", statusOf(lines).includes("code-screen-") && statusOf(lines).includes("main"));

  app.host.screen.focus("side");
  app.shell.handleKey(key("enter", ""));
  lines = screen();
  ok("Enter opens the folder", has(lines, "▾ src •") && has(lines, "app.js M"));
  app.shell.handleKey(key("down", ""));
  app.shell.handleKey(key("enter", ""));
  await wait(200);
  lines = screen();
  ok("Enter on a file opens it, with its change count", has(lines, "src/app.js M  2 changes"));
  ok("HEAD's line removed in place", has(lines, "- const line3 = 3;"));
  ok("the new line added after it", has(lines, "+ const line3 = 33;"));

  app.host.screen.focus("code");
  app.shell.handleKey(key("char", "n"));
  lines = screen();
  ok("n moves to the next change", has(lines, "+ const line50 = 500;"));
  app.shell.handleKey(key("char", "p"));
  lines = screen();
  ok("p moves back", has(lines, "+ const line3 = 33;"));
  ok("unwrapped: a long line runs past the edge, the footer's box empty", has(lines, "[ ] wrap lines") && !has(lines, " item19];"));
  app.shell.handleKey(key("char", "w"));
  lines = screen();
  const longRow = rowOf(lines, "  const line11 = [");
  ok("w wraps: the long line continues on the rows below, at a space", app.code.pane.wrap.peek() && has(lines, "[x] wrap lines") && longRow > 0 && lines[longRow + 1].includes("item") && has(lines, "item19];"));
  ok("the column keeps a right margin", lines.every((l) => !l.includes("item19];│")));
  const wrapPos = app.code.pane.position();
  app.shell.handleKey(key("char", "n"));
  lines = screen();
  ok("n moves through the changes by code line while wrapped", has(lines, "+ const line50 = 500;") && app.code.pane.position() !== wrapPos);
  app.shell.handleKey(key("char", "p"));
  const footer = rowOf(screen(), "wrap lines");
  const boxCol = screen()[footer].indexOf("[x]");
  const box = hitTest(root, boxCol, footer);
  if (box !== null) box.dispatch(new MouseEvent("mousedown", boxCol, footer, 0, false, false, false));
  lines = screen();
  ok("a press on the box unwraps, the top line kept", !app.code.pane.wrap.peek() && has(lines, "[ ] wrap lines") && has(lines, "+ const line3 = 33;"));

  const readme = rowOf(lines, "README.md");
  ok("README.md is in the tree", readme > 0);
  const col = lines[readme].indexOf("README.md");
  const target = hitTest(root, col, readme);
  // A press is a press and a release in place (a drag would select).
  if (target !== null) {
    target.dispatch(new MouseEvent("mousedown", col, readme, 0, false, false, false));
    target.dispatch(new MouseEvent("mouseup", col, readme, 0, false, false, false));
  }
  await wait(200);
  lines = screen();
  ok("a press on a file row opens it", has(lines, " README.md") && has(lines, "# Demo"));
  app.host.screen.focus("code");
  const t2 = hitTest(root, col, readme);
  if (t2 !== null) t2.dispatch(new MouseEvent("mousedown", col, readme, 0, false, false, false));
  ok("and makes the files column active", app.host.screen.active.peek() === "side");

  app.shell.handleKey(key("char", "c"));
  lines = screen();
  const sideRows = lines.map((l) => l.slice(app.shell.xOf("side"), app.shell.xOf("side") + app.shell.widthOf("side")));
  ok("changed only: README.md hidden, the changed files shown", !has(sideRows, "README.md") && has(sideRows, "notes.md U") && has(sideRows, "app.js M"));
  app.shell.handleKey(key("char", "c"));

  await app.code.load("src/app.js");
  writeFileSync(join(repo, "src", "app.js"), body.join("\n") + "\nconst added = true;\n");
  await wait(600);
  lines = screen();
  ok("a write to the open file shows after the watcher's batch", has(lines, "3 changes"));
  eq("the chat column is active again with F1", String((app.shell.handleKey(key("f1", "")), app.host.screen.active.peek())), "chat");

  app.chat.submit("/resume");
  lines = screen();
  ok("/resume opens the Sessions tab of the files column, sessions by title", tabs(lines).includes("Sessions") && has(lines, "2 sessions · n new") && has(lines, "Helper rename") && app.host.screen.active.peek() === "side");
  ok("the column widens for them", app.shell.widthOf("side") >= 24);
  ok("an untitled session shows its first prompt, cut short", has(lines, "Please look at the") && !has(lines, "only fails on Linux"));
  await wait(1500);
  lines = screen();
  ok("then the title Claude wrote for it", has(lines, "Rename the helper") && !has(lines, "Please look at the"));
  const records = app.host.session.records;
  if (records !== null) await records.settled();
  const stored = records !== null ? records.session("bbbbbbbb-1111-2222-3333-444444444444", repo) : null;
  ok("kept in the project's .widecode", stored !== null && stored.title === "Rename the helper" && stored.titleBy === "claude" && existsSync(join(repo, ".widecode", "sessions.jsonl")));
  ok("the highlighted session's details show in the code column, with the ways to open it", has(lines, "Session · Helper rename · Esc back") && has(lines, "when    just now") && has(lines, "Enter  open it here") && has(lines, "no terminal to open it in") && app.host.roles.code.inAgent());
  app.shell.handleKey(key("down", ""));
  lines = screen();
  ok("↓ shows the next one's: its folder and its first prompt", has(lines, "Session · Rename the helper") && has(lines, "folder  " + repo) && has(lines, "First prompt") && has(lines, "Please look at the failing build on CI"));
  app.shell.handleKey(key("up", ""));
  app.shell.handleKey(key("enter", ""));
  lines = screen();
  ok("Enter resumes the highlighted one: its history in the chat", has(lines, "<Me>: Rename the helper") && has(lines, "Renamed helper to assist.") && app.host.screen.active.peek() === "chat");
  ok("and the list marks it as the chat's", has(lines, " ● Helper rename"));
  ok("the status bar names the session", statusOf(lines).includes("Helper rename"));
  const agentRow = rowOf(lines, "· Agent Explore: Find callers");
  ok("the subagent's call is one line in the chat", agentRow > 0 && !has(lines, "Found two callers"));
  const agentCol = lines[agentRow].indexOf("Agent");
  const agentHit = hitTest(root, agentCol, agentRow);
  if (agentHit !== null) {
    agentHit.dispatch(new MouseEvent("mousedown", agentCol, agentRow, 0, false, false, false));
    agentHit.dispatch(new MouseEvent("mouseup", agentCol, agentRow, 0, false, false, false));
  }
  lines = screen();
  const calls = app.tools.panel;
  const picked = calls !== null && calls.source.selected >= 0 ? calls.source.rows[calls.source.selected].item : null;
  ok("a press on it shows it in the Tools tab, selected", app.host.screen.shownIn("tools") === "calls" && picked !== null && picked.name === "Agent" && has(lines, "● Agent Explore"));
  app.host.screen.focus("tools");
  app.shell.handleKey(key("enter", ""));
  lines = screen();
  ok("Enter there shows the subagent's own transcript in the code column", has(lines, "› Find the callers of helper") && has(lines, "Found two callers in src.") && app.host.roles.code.inAgent());
  app.host.screen.focus("code");
  app.shell.handleKey(key("escape", ""));
  await wait(100);
  app.chat.submit("/help");
  // The chat's lines, all of them (the list is longer than the screen), joined.
  const chatLines: string[] = [];
  const chatSource = app.chat.pane.source;
  chatSource.prepare(app.chat.pane.view.cols);
  for (let i = 0; i < chatSource.count(); i++) chatLines.push(chatSource.line(i, app.chat.pane.view.cols).runs.map((r) => r.text).join(""));
  const help = chatLines.join(" ").replace(/\s+/g, " ");
  ok("/help lists what the plugins registered: commands with their help, key hints", help.includes("/effort") && help.includes("/resume (the folder's sessions") && help.includes("/model <name>") && help.includes("Shift+Tab plan") && help.includes("n/p changes"));
  app.chat.submit("/new");
  lines = screen();
  ok("/new starts over", has(lines, "A new session in this folder") && !has(lines, "<Me>: Rename the helper"));
  app.host.screen.focus("side");
  app.shell.handleKey(key("tab", ""));
  await wait(400);
  lines = screen();
  ok("Tab in the files column: Sessions, then Git (wider)", app.host.screen.shownIn("side") === "git" && app.shell.widthOf("side") === 40 && has(lines, " vs  HEAD │ branch │ session ") && has(lines, "▸ ") && has(lines, " init "));
  app.shell.handleKey(key("tab", ""));
  lines = screen();
  ok("then Peers", app.host.screen.shownIn("side") === "peers" && has(lines, "This machine"));
  app.shell.handleKey(key("tab", ""));
  lines = screen();
  ok("then Skills: none on disk, more once Claude starts", app.host.screen.shownIn("side") === "skills" && has(lines, "More once Claude starts."));
  app.shell.handleKey(key("tab", ""));
  lines = screen();
  ok("then back to the files", app.host.screen.shownIn("side") === "files" && has(lines, "app.js") && app.shell.widthOf("side") === 24);
  app.shell.handleKey(key("f4", ""));
  ok("F4 shows the sessions again", app.host.screen.shownIn("side") === "sessions");
  app.shell.handleKey(key("f4", ""));
  ok("and F4 there goes back", app.host.screen.shownIn("side") === "files");
  // The tab hidden hands the code column back to its file, which loads again (as Esc has it).
  await wait(200);
  ok("and the code column shows its file again", !app.host.roles.code.inAgent() && app.host.roles.code.path() === "src/app.js");

  // Claude edits README.md: the code column follows it; a commit then clears its changes.
  writeFileSync(join(repo, "README.md"), "# Demo\nmore\n");
  app.host.conversation.receive(JSON.stringify({ type: "assistant", message: { id: "e1", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: join(repo, "README.md"), old_string: "# Demo", new_string: "# Demo\nmore" } }] } }));
  app.host.conversation.receive(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "updated" }] } }));
  app.host.conversation.changed();
  // The watcher's batch and git status take a moment (longer on a busy machine).
  for (let i = 0; i < 100; i++) {
    await wait(50);
    lines = screen();
    if (app.code.pane.path.peek() === "README.md" && has(lines, "README.md M  1 change") && has(lines, "+ more")) break;
  }
  ok("the code column follows Claude's edit", app.code.pane.path.peek() === "README.md" && has(lines, "README.md M  1 change") && has(lines, "+ more"));
  git(["commit", "-qam", "more"]);
  await wait(700);
  lines = screen();
  ok("after a commit the file shows no changes against the new HEAD", has(lines, " README.md   ") && !has(lines, "README.md M") && has(lines, "2   more") && !has(lines, "+ more"));
  app.host.screen.focus("code");
  app.shell.handleKey(key("char", "f"));
  ok("f stops following", app.host.screen.message.peek() === "not following Claude's edits");
  app.shell.handleKey(key("char", "f"));
  app.host.screen.focus("chat");

  const other = mkdtempSync(join(tmpdir(), "code-screen-other-"));
  writeFileSync(join(other, "plain.txt"), "plain\n");
  await app.host.openFolder(other);
  lines = screen();
  ok("/open while Claude works only warns", statusOf(lines).includes("Claude is still working here") && app.host.workspace.folder === repo);
  await app.host.openFolder(other);
  app = currentWidecode();
  lines = screen();
  ok("/open again switches the folder: its files, outside git", has(lines, " All 1│ Changed 0 ") && has(lines, "plain.txt") && !has(lines, "app.js") && app.host.workspace.folder === other);
  ok("and the chat starts over there", has(lines, "A new session in this folder"));
  eq("and the chosen agent talks to the new conversation", app.host.conversation.agent.owner, "claude");
  await app.host.openFolder(repo);
  app = currentWidecode();
  rmSync(other, { recursive: true, force: true });

  app.host.conversation.resume("aaaaaaaa-1111-2222-3333-444444444444", "Helper rename");
  lines = screen();
  ok("resuming a session draws its transcript at once", has(lines, "Rename the helper") && has(lines, "Renamed") && !has(lines, "A new session in this folder"));
  app.host.conversation.reset();
  lines = screen();
  ok("and a reset draws the empty chat again", has(lines, "A new session in this folder") && !has(lines, "Rename the helper"));

  insertText(app.chat.pane.input, "look at @ap");
  lines = screen();
  ok("typing @ap suggests the folder's matching path", has(lines, "› @src/app.js"));
  app.shell.handleKey(key("tab", ""));
  lines = screen();
  eq("Tab puts it in place", app.chat.pane.input.value(), "look at @src/app.js ");
  ok("and the suggestions go away", !has(lines, "› @src/app.js"));

  mounted().unmount();
  app.host.workspace.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  rmSync(widecodeHome, { recursive: true, force: true });
  done();
};

main();
