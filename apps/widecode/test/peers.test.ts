// ffi: @light/plugins/native/ffi.json
// The peers plugin over two daemons on the loopback: this machine's (the app finds it through the
// store's state file, so nothing is spawned) and another machine's, which shares a clone of this
// folder's repository with one more commit. The tab shows this machine, its port and the share
// offer; /peers share shares the folder; the other machine pairs in with a code; its copy is
// matched by root commit, a remote named after it is written with the token in the local git
// config, the auto-fetch brings its commit, and the row says ↓1; /peers fetch says so too; /peers
// forget removes it and its token stops working.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWidecode } from "../src/compose.ts";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { JsPanel } from "../src/runtime/views.ts";
import { DaemonOptions, startDaemon } from "@widecode/peers";
import { KeyEvent, TRoot, mount, unmount } from "@bootstrapp/light/native/tui";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const root = mkdtempSync(join(tmpdir(), "widecode-peers-app-"));
const storeA = join(root, "store-a");
const storeB = join(root, "store-b");
const repo = join(root, "repo");
const repoB = join(root, "repo-b");
mkdirSync(storeA);
mkdirSync(storeB);
mkdirSync(repo);
process.env["WIDECODE_HOME"] = storeA;

/** A git command, synchronous: the daemons it talks to are not asked here (clones and commits only). */
const git = (args: string): string => {
  const r = spawnSync("sh", ["-c", "GIT_TERMINAL_PROMPT=0 git -c user.email=t@t -c user.name=t -c init.defaultBranch=main " + args], { encoding: "utf8" });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};

git("init -q " + repo);
writeFileSync(join(repo, "a.txt"), "one\n");
git("-C " + repo + " add . && git -C " + repo + " -c user.email=t@t -c user.name=t commit -qm first");
git("clone -q " + repo + " " + repoB);
writeFileSync(join(repoB, "b.txt"), "from the other machine\n");
git("-C " + repoB + " add . && git -C " + repoB + " -c user.email=t@t -c user.name=t commit -qm 'second, elsewhere'");

const main = async (): Promise<void> => {
  const oa = new DaemonOptions();
  oa.port = 0;
  oa.bind = "127.0.0.1";
  oa.name = "desk";
  const a = await startDaemon(storeA, oa);
  if (typeof a === "string") throw new Error(a);
  const ob = new DaemonOptions();
  ob.port = 0;
  ob.bind = "127.0.0.1";
  ob.name = "mac";
  const b = await startDaemon(storeB, ob);
  if (typeof b === "string") throw new Error(b);
  const sharedB = await b.share(repoB, "", "live", null, null);
  ok("the other machine shares its clone", typeof sharedB !== "string");

  const ws = await openWorkspace(repo, 100);
  const conversation = new Conversation(ws.folder);
  const app = createWidecode(ws, conversation, null);
  const tree = new TRoot();
  app.shell.resize(200);
  mount(app.shell, tree);
  await app.host.load();
  const until = async (check: () => boolean, steps = 300): Promise<void> => {
    for (let i = 0; i < steps && !check(); i++) await wait(20);
  };
  const key = (name: string, text: string): boolean => app.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const panel = app.host.screen.findPanel("peers");
  const tab = panel instanceof JsPanel ? panel : null;
  ok("the Peers tab is there", tab !== null);
  const rows = (): string[] => {
    const out: string[] = [];
    if (tab === null) return out;
    for (let i = 0; i < tab.rows.count(); i++) out.push(tab.rows.line(i, 70).runs.map((r) => r.text).join(""));
    return out;
  };
  const has = (text: string): boolean => rows().some((r) => r.includes(text));
  const message = (): string => app.host.screen.message.peek();

  app.host.screen.focus("side");
  app.host.screen.showPanel("peers");
  await until(() => has("serving on :" + String(a.port)));
  ok("this machine, its port and its name", has("This machine · desk") && has("serving on :" + String(a.port)));
  ok("the folder is not shared yet: an offer", has("share this folder"));
  ok("no peer yet", has("no peer paired yet"));

  app.host.kernel.commands.run("/peers share");
  await until(() => rows().some((r) => r.includes("● repo") && r.includes("this folder")));
  ok("/peers share: the repository is listed as shared, live, this folder", rows().some((r) => r.includes("● repo") && r.includes("live") && r.includes("this folder")));
  eq("the daemon shares it at its root", a.registry.repos[0].path, repo);

  // The other machine pairs in with the code this one shows.
  app.host.kernel.commands.run("/peers pair");
  await until(() => has("code ") && message().includes("pairing code"));
  const code = a.offer !== null ? a.offer.code : "";
  eq("a six-digit code is shown and told (code, in the message, in the hint)", String(/^[0-9]{6}$/.test(code)) + " " + String(message().includes(code)) + " " + String(has("/peers join")), "true true true");
  const joined = await b.pairJoin("127.0.0.1", a.port, code, Date.now());
  ok("the other machine joined", typeof joined !== "string");

  key("char", "r");
  await until(() => has("● mac") && rows().some((r) => r.includes("↓1")), 600);
  ok("the peer shows online", rows().some((r) => r.includes("● mac") && r.includes("online")));
  ok("its copy of this repository is matched by root commit", rows().some((r) => r.includes("repo-b") && r.includes("same as this folder")));
  ok("the auto-fetch brought its commit: ↓1", rows().some((r) => r.includes("● mac") && r.includes("↓1")));
  ok("a remote named after the peer points at its copy", git("-C " + repo + " remote get-url mac") === "http://127.0.0.1:" + String(b.port) + "/" + (typeof sharedB === "string" ? "" : sharedB.key));
  const token = a.registry.peerById(b.identity.id)!.tokenWePresent;
  ok("the token is in the local git config, for the peer's base URL", git("-C " + repo + " config --get-all http.http://127.0.0.1:" + String(b.port) + "/.extraHeader") === "Authorization: Bearer " + token);
  eq("the commit is a remote-tracking ref, the working tree untouched", git("-C " + repo + " log -1 --format=%s mac/main") + " · " + git("-C " + repo + " status --short"), "second, elsewhere · ");

  app.host.kernel.commands.run("/peers fetch mac");
  await until(() => message().startsWith("fetched mac"));
  ok("/peers fetch says what the peer has", message().includes("1 commit you do not have on main"));
  ok("the Git badge and the segment see it", tab !== null && tab.badge().some((r) => r.text === "↓1"));

  // Before the forget, the other machine fetches from this one with the token this one gave it.
  const theirToken = b.registry.peerById(a.identity.id)!.tokenWePresent;
  const ours = "http://127.0.0.1:" + String(a.port) + "/" + a.registry.repos[0].key;
  const o = new SpawnOptions();
  o.timeoutMs = 30000;
  // Asked asynchronously: the server it talks to lives in this process.
  const before = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer " + theirToken, "ls-remote", ours], o);
  ok("the other machine can fetch from this one", before.code === 0 && before.text.includes("refs/heads/main"));
  app.host.kernel.commands.run("/peers forget mac");
  await until(() => !has("● mac") && message().includes("forgot mac"));
  ok("forgotten: gone from the tab", !has("mac ·"));
  const after = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer " + theirToken, "ls-remote", ours], o);
  ok("and its token no longer opens this machine's door", after.code !== 0);

  unmount(app.shell);
  ws.close();
  a.stop();
  b.stop();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
