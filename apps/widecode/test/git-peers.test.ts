// ffi: @light/plugins/native/ffi.json
// The Git tab with a peer: a paired machine (in the registry) whose remote is here and fetched. Its
// section lists it with the branch against ours (↓1: a commit of theirs we lack), the badge and the
// info row say so, Enter on the branch shows their log, and b cycles the compare base past the two
// that cannot apply (main is the main branch; no session start) to what the peer has.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWidecode } from "../src/compose.ts";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { JsPanel } from "../src/runtime/views.ts";
import { DaemonPaths, Peer, Registry } from "@widecode/peers";
import { KeyEvent, TRoot, mount, unmount } from "@lightstart/light/native/tui";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const root = mkdtempSync(join(tmpdir(), "widecode-git-peers-"));
const store = join(root, "store");
const repo = join(root, "repo");
const theirs = join(root, "theirs");
mkdirSync(store);
mkdirSync(repo);
process.env["WIDECODE_HOME"] = store;

const git = (args: string): string => {
  const r = spawnSync("sh", ["-c", "GIT_TERMINAL_PROMPT=0 git -c user.email=t@t -c user.name=t -c init.defaultBranch=main " + args], { encoding: "utf8" });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};

git("init -q " + repo);
writeFileSync(join(repo, "a.txt"), "one\n");
git("-C " + repo + " add . && git -C " + repo + " -c user.email=t@t -c user.name=t commit -qm first");
git("clone -q " + repo + " " + theirs);
writeFileSync(join(theirs, "b.txt"), "theirs\n");
git("-C " + theirs + " add . && git -C " + theirs + " -c user.email=t@t -c user.name=t commit -qm 'second, elsewhere'");
// The peer "mac" in this machine's registry, its remote in the repository (a path here stands for its URL), fetched.
const registry = new Registry(new DaemonPaths(store).registry);
registry.upsertPeer(new Peer("d".repeat(64), "mac", "pk", "they", "we", "127.0.0.1", 7337, Date.now()));
mkdirSync(new DaemonPaths(store).dir, { recursive: true });
registry.save();
git("-C " + repo + " remote add mac " + theirs);
git("-C " + repo + " fetch -q mac");

const main = async (): Promise<void> => {
  const ws = await openWorkspace(repo, 100);
  const app = createWidecode(ws, new Conversation(ws.folder), null);
  const tree = new TRoot();
  app.shell.resize(200);
  mount(app.shell, tree);
  await app.host.load();
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !check(); i++) await wait(20);
  };
  const key = (name: string, text: string): boolean => app.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const panel = app.host.screen.findPanel("git");
  const tab = panel instanceof JsPanel ? panel : null;
  const rows = (): string[] => {
    const out: string[] = [];
    if (tab === null) return out;
    for (let i = 0; i < tab.rows.count(); i++) out.push(tab.rows.line(i, 70).runs.map((r) => r.text).join(""));
    return out;
  };
  const has = (text: string): boolean => rows().some((r) => r.includes(text));
  app.host.screen.focus("side");
  app.host.screen.showPanel("git");
  await until(() => has("Peers (1)") && has("↓1"));
  ok("the peer is listed with its state", rows().some((r) => r.includes("mac") && r.includes("online")));
  ok("its main is one ahead of ours", rows().some((r) => /^\s+main\s+↓1 /.test(r)));
  ok("the badge says so", tab !== null && tab.badge().some((r) => r.text.includes("↓1")));
  ok("the info row names the peer", tab !== null && tab.info().map((r) => r.text).join("").includes("mac ↓1"));

  // Enter on their branch: its log.
  const at = rows().findIndex((r) => /^\s+main\s+↓1 /.test(r));
  if (tab !== null) tab.press(at, 6);
  await until(() => has("Commits · mac/main") && has("second, elsewhere"));
  ok("their log, newest first", rows().some((r) => r.includes("second, elsewhere")));

  // The compare row offers "peer" while a peer has a remote here; a press on it compares with their tip.
  ok("the compare row offers the peer base", rows()[0].includes(" peer "));
  const label = rows()[0].indexOf(" peer ");
  if (tab !== null) tab.press(0, label + 2);
  await until(() => app.host.folder.base.peek().kind === "peer");
  eq("the compare base is what the peer has", app.host.folder.base.peek().kind + " · " + app.host.folder.base.peek().name, "peer · mac/main");
  ok("the note says what is compared", rows()[1].includes("what mac has on main · " + git("-C " + theirs + " rev-parse --short=7 HEAD")));
  const marks = (): string => {
    const out: string[] = [];
    for (const k of app.host.folder.marks().keys()) out.push(app.host.folder.markOf(k) + " " + k);
    return out.sort().join(", ");
  };
  await until(() => marks() === "D b.txt");
  eq("against their tip, their file is what we lack", marks(), "D b.txt");
  key("char", "b");
  await until(() => app.host.folder.base.peek().kind === "head" && marks() === "");
  eq("b from the peer base: round to HEAD, nothing changed against it", app.host.folder.base.peek().kind + " ·" + marks(), "head ·");
  // The base's status read is done before the folder goes.
  await wait(200);

  unmount(app.shell);
  ws.close();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
