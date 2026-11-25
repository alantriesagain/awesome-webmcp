// ffi: @lightstart/plugins/native/ffi.json
// The Git tab's reads on a temp repository with a root commit, a branch that tracks another, a
// rename, a merge and a topic branch: branches (current first, ahead and behind), the log (limited
// to a folder below the root too), a commit's files (a root commit, a merge against its first
// parent, a rename as a delete and an add), a commit's file in the code view. In the app, the JS
// plugin's tab: the bases by b and by a press on the compare row (HEAD, where the branch left main,
// where the session started, found by time when not recorded) for the marks, counts and code; this
// session's commits marked; a commit made while the tab is open shows after the watcher fires; a
// commit opened to its file; Esc leaves it for the work tree; many branches past a "+N more" row.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDED, CodeFile, loadCommitFile, REMOVED } from "../src/code/diff.ts";
import { openRepo } from "@lightstart/workspace/git.ts";
import { JsPanel } from "../src/runtime/views.ts";
import { Commit, parseBranches, parseLog, readBranches, readCommitAt, readCommitFiles, readDefaultBranch, readLog, readMergeBase } from "@lightstart/workspace/git-log.ts";
import { parseNameStatus } from "@lightstart/workspace/git-parse.ts";
import { KeyEvent, TRoot, mount, unmount } from "@lightstart/light/native/tui";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
const NUL = "\u0000";

const parsedBranches = parseBranches(["feature" + NUL + "main" + NUL + "ahead 2, behind 1" + NUL + "1700000100" + NUL + "work" + NUL + " ", "main" + NUL + "" + NUL + "" + NUL + "1700000000" + NUL + "init" + NUL + "*", "old" + NUL + "origin/old" + NUL + "gone" + NUL + "1700000200" + NUL + "x" + NUL + " "].join("\n"));
eq("branches: the current first, then the newest; track parsed", parsedBranches.map((b) => b.name + (b.current ? "*" : "") + " +" + String(b.ahead) + "-" + String(b.behind) + (b.gone ? " gone" : "")).join(", "), "main* +0-0, old +0-0 gone, feature +2-1");
const parsedLog = parseLog(["a1" + NUL + "a" + NUL + "p1 p2" + NUL + "1700000000" + NUL + "Ann" + NUL + "Merge x", "\nb2" + NUL + "b" + NUL + "" + NUL + "1600000000" + NUL + "Bo" + NUL + "init: a\tb", ""].join("\u001e"));
eq("log: parents, a root commit, a tab in a subject", parsedLog.map((c) => c.short + ":" + String(c.parents.length) + ":" + c.subject).join(" | "), "a:2:Merge x | b:0:init: a\tb");
eq("name-status", Array.from(parseNameStatus("M" + NUL + "a.txt" + NUL + "D" + NUL + "old name.txt" + NUL).entries()).map((e) => e[1] + " " + e[0]).join(", "), "M a.txt, D old name.txt");

const repo = mkdtempSync(join(tmpdir(), "lightcode-gitlog-"));
let clock = 1700000000;
/** A git command at the next minute (author and committer dates), in the repository. */
const git = (args: string): string => {
  clock += 60;
  const r = spawnSync("sh", ["-c", "cd '" + repo + "' && GIT_AUTHOR_DATE='@" + String(clock) + " +0000' GIT_COMMITTER_DATE='@" + String(clock) + " +0000' git -c user.email=t@t -c user.name=t -c init.defaultBranch=main " + args], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
};
const write = (path: string, text: string): void => writeFileSync(join(repo, path), text);
const shaOf = (ref: string): string => git("rev-parse " + ref);

mkdirSync(join(repo, "sub"), { recursive: true });
write("a.txt", "1\n2\n3\n");
write("keep.txt", "k\n");
write("sub/x.txt", "x\n");
git("init -q");
git("add .");
git("commit -qm init");
write("a.txt", "1\nTWO\n3\n");
write("b.txt", "b1\nb2\n");
git("add .");
git("commit -qm 'edit a'");
git("checkout -qb feature");
write("b.txt", "b1\nB2\nb3\n");
git("mv keep.txt kept.txt");
git("commit -qam 'feature work'");
git("checkout -q main");
write("sub/x.txt", "x\ny\n");
git("commit -qam 'main moves'");
git("merge -q --no-ff feature -m 'merge feature'");
git("checkout -q feature");
git("branch -q -u main");
git("checkout -qb topic");
write("t1.txt", "t1\n");
git("add t1.txt");
git("commit -qm 't1'");
const t1 = shaOf("HEAD");
const t1Time = clock;
write("a.txt", "1\nTWO\n3\nfour\n");
git("commit -qam 't2'");
write("t1.txt", "t1 changed\n");

const main = async (): Promise<void> => {
  const r = await openRepo(repo);
  const branches = await readBranches(r, repo);
  eq("the repository's branches", branches.map((b) => b.name + (b.current ? "*" : "") + (b.upstream.length > 0 ? " ↑" + String(b.ahead) + "↓" + String(b.behind) : "")).join(", "), "topic*, main, feature ↑0↓2");
  const log = await readLog(r, repo, "main", 200);
  eq("main's log, newest first", log.map((c) => c.subject + ":" + String(c.parents.length)).join(" | "), "merge feature:2 | main moves:1 | feature work:1 | edit a:1 | init:0");
  const files = async (c: Commit): Promise<string> => (await readCommitFiles(r, repo, c)).map((f) => f.mark + " " + f.path + (f.binary ? " bin" : " +" + String(f.added) + "-" + String(f.removed))).join(", ");
  eq("a root commit: all added", await files(log[4]), "A a.txt +3-0, A keep.txt +1-0, A sub/x.txt +1-0");
  eq("a commit's files with their lines", await files(log[3]), "M a.txt +1-1, A b.txt +2-0");
  eq("a rename: a delete and an add", await files(log[2]), "M b.txt +2-1, D keep.txt +0-1, A kept.txt +1-0");
  eq("a merge: against its first parent", await files(log[0]), "M b.txt +2-1, D keep.txt +0-1, A kept.txt +1-0");
  const sub = join(repo, "sub");
  const subLog = await readLog(await openRepo(sub), sub, "main", 200);
  eq("below the root: the commits touching the folder, paths relative to it", subLog.map((c) => c.subject).join(" | ") + " / " + (await readCommitFiles(await openRepo(sub), sub, subLog[0])).map((f) => f.path).join(","), "main moves | init / x.txt");
  eq("the main branch and where topic (from feature) left it", (await readDefaultBranch(r, repo)) + " " + String((await readMergeBase(r, repo, "main")) === shaOf("feature")), "main true");
  eq("the commit HEAD was on at a time", await readCommitAt(r, repo, (t1Time + 30) * 1000), t1);

  const show = (f: CodeFile): string => f.lines.map((l) => (l.kind === ADDED ? "+" : l.kind === REMOVED ? "-" : " ") + l.text).join("|");
  eq("a commit's file: its change in place", show(await loadCommitFile(r, repo, log[3], "a.txt")), " 1|-2|+TWO| 3");
  const rootFile = await loadCommitFile(r, repo, log[4], "keep.txt");
  eq("in a root commit: new, plain", String(rootFile.added) + " " + show(rootFile), "true  k");
  const gone = await loadCommitFile(r, repo, log[2], "keep.txt");
  eq("deleted by the commit: all removed", show(gone) + " " + String(gone.exists), "-k false");

  // The app: the bases, this session's commits, a commit made while the tab is open, Esc.
  const app = await openLightcode({ folder: repo });
  const conversation = app.host.conversation;
  const root = new TRoot();
  app.shell.resize(200);
  mount(app.shell, root);
  await app.host.session.load(app.host.folder, app.host.hooks);
  const marks = (): string => {
    const out: string[] = [];
    for (const k of app.host.folder.marks().keys()) out.push(app.host.folder.markOf(k) + " " + k);
    return out.sort().join(", ");
  };
  eq("against HEAD: the work tree's change", marks(), "M t1.txt");
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 150 && !check(); i++) await wait(20);
  };
  const key = (name: string, text: string): boolean => app.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const panel = app.host.screen.findPanel("git");
  const tab = panel instanceof JsPanel ? panel : null;
  /** The Git tab's rows as text. */
  const rows = (): string[] => {
    const out: string[] = [];
    if (tab === null) return out;
    for (let i = 0; i < tab.rows.count(); i++) out.push(tab.rows.line(i, 60).runs.map((r) => r.text).join(""));
    return out;
  };
  const press = (row: number, x: number): void => {
    if (tab !== null) tab.press(row, x);
  };
  const hunks = (): number => app.code.pane.source.file.hunks.length;
  app.host.screen.focus("side");
  app.host.screen.showPanel("git");
  await until(() => rows().some((r) => r.includes("Commits · topic")));
  key("char", "b");
  await until(() => app.host.folder.base.peek().kind === "branch" && marks() === "A t1.txt, M a.txt");
  eq("b: against where topic left main, its commits and the work tree", marks() + " · " + app.host.folder.base.peek().name, "A t1.txt, M a.txt · main");
  ok("the counts follow the base", app.host.changes().some((f) => f.path === "a.txt" && f.added === 1 && f.removed === 0));
  ok("the compare row says what it resolved to", rows()[1].includes("where this branch left main · " + shaOf("feature").slice(0, 7)));
  key("char", "b");
  await until(() => app.host.screen.message.peek().includes("not known yet"));
  ok("no session start known yet: still the branch", app.host.folder.base.peek().kind === "branch");
  conversation.info.startMs = (t1Time + 30) * 1000;
  key("char", "b");
  await until(() => app.host.folder.base.peek().kind === "session" && marks() === "M a.txt, M t1.txt");
  eq("since the session started (found by time): t2 and the work tree", marks() + " · " + app.host.folder.base.peek().name, "M a.txt, M t1.txt · session start");
  await app.code.load("a.txt");
  eq("the code column against the base", app.code.pane.source.file.lines.map((l) => (l.kind === ADDED ? "+" : l.kind === REMOVED ? "-" : " ") + l.text).join("|"), " 1| TWO| 3|+four");
  press(0, " vs ".length + 1);
  await until(() => app.host.folder.base.peek().kind === "head" && marks() === "M t1.txt" && hunks() === 0);
  eq("a press on HEAD in the compare row: back to HEAD", marks() + " · " + String(hunks()), "M t1.txt · 0");

  // Shown again, the tab reads with the session's start now known.
  app.host.screen.showPanel("git");
  await until(() => rows().some((r) => r.includes("●") && r.includes(" t2")));
  /** The log's rows: ● for this session's, then the subject. */
  const commits = (): string[] => rows().filter((r) => /^ [▸▾][● ][0-9a-f]{7} /.test(r)).map((r) => (r.charAt(2) === "●" ? "●" : "") + r.slice(11).replace(/\s+\S+$/, "").trim());
  eq("the Git tab: topic's log, this session's commit marked", String(rows().some((r) => r.includes("Commits · topic"))) + " " + commits().slice(0, 2).join(","), "true ●t2,t1");
  write("t3.txt", "3\n");
  git("add t3.txt");
  git("commit -qm 't3'");
  await until(() => commits()[0] === "●t3");
  eq("a commit made while it is open shows after the watcher fires", commits()[0] ?? "(none)", "●t3");
  // Open t3 by a press on its row, then down to its file and Enter.
  press(rows().findIndex((r) => r.includes(" t3 ") || r.endsWith(" t3")), 3);
  await until(() => rows().some((r) => r.includes("A t3.txt")));
  key("down", "");
  key("enter", "");
  await until(() => app.code.pane.commit.peek().length > 0);
  eq("a commit's file in the code column, named with the commit", app.code.pane.path.peek() + " @ " + app.code.pane.commit.peek() + " · " + app.code.pane.source.file.lines.map((l) => (l.kind === ADDED ? "+" : " ") + l.text).join("|") + " · " + app.code.pane.header.peek(), "t3.txt @ " + shaOf("HEAD").slice(0, 7) + " t3 ·  3 · new file");
  ok("and highlighted in the tab", tab !== null && tab.rows.line(rows().findIndex((r) => r.includes("A t3.txt")), 60).bg === "#3a3f58");
  app.host.screen.focus("code");
  key("escape", "");
  await until(() => app.code.pane.commit.peek().length === 0);
  eq("Esc: the work tree's file again", app.code.pane.commit.peek() + "|" + app.code.pane.path.peek(), "|t3.txt");

  // New branches touch only .git/refs, which the watcher does not see: the tab reads them when shown.
  for (let i = 0; i < 8; i++) git("branch -q b" + String(i));
  app.host.screen.showPanel("git");
  const branchRows = (): string => {
    const all = rows();
    const from = all.findIndex((r) => r.includes("Branches ("));
    const to = all.findIndex((r) => r.includes("Commits · "));
    const list = all.slice(from + 1, to);
    const more = list.filter((r) => r.includes("branches"));
    return String(list.length - more.length) + "b " + more.map((r) => r.trim()).join("");
  };
  await until(() => branchRows().startsWith("8b +"));
  eq("many branches: the first few, then a row for the rest", branchRows(), "8b +3 more branches");
  press(rows().findIndex((r) => r.includes("more branches")), 4);
  await until(() => branchRows().startsWith("11b"));
  eq("and all of them on demand", branchRows(), "11b fewer branches");
  unmount(app.shell);
  // The plugins stopped and their processes ended before the repository goes: a git call started after would find no folder.
  closeLightcode(app);
  rmSync(repo, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message + " " + (err.stack ?? "") : "error"));
  process.exit(1);
});
