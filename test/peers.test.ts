// ffi: @lightstart/plugins/native/ffi.json
// The peers plugin over two daemons on the loopback: this machine's (the app finds it through the
// store's state file, so nothing is spawned) and another machine's, which shares a clone of this
// folder's repository with one more commit. The tab shows this machine, its port and the share
// offer; /peers share shares the folder; the other machine pairs in with a code; the daemon's sync
// matches its copy by root commit, writes a remote named after it with the token in the local git
// config and fetches, and the repository's row under the peer says ↓1; the page in the code column
// lists the commit to fetch; /peers fetch says so too; a repository the peer has and this machine
// lacks shows as "not here" and /peers clone brings it; /peers forget removes the peer and its token
// stops working.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { JsPanel } from "../src/runtime/views.ts";
import { DaemonOptions, startDaemon } from "../src/peers/index.ts";
import { KeyEvent, TRoot, mount, unmount } from "@lightstart/light/native/tui";
import { SpawnOptions, spawnCapped } from "@lightstart/lib/process.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

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
  // Both daemons on the loopback and quiet: announced over mDNS, the host machine's avahi would hand
  // each the other's Wi-Fi address, where nothing listens here.
  const oa = new DaemonOptions();
  oa.port = 0;
  oa.bind = "127.0.0.1";
  oa.name = "desk";
  oa.discovery = false;
  oa.syncMs = 0;
  const a = await startDaemon(storeA, oa);
  if (typeof a === "string") throw new Error(a);
  const ob = new DaemonOptions();
  ob.port = 0;
  ob.bind = "127.0.0.1";
  ob.name = "mac";
  ob.discovery = false;
  ob.syncMs = 0;
  const b = await startDaemon(storeB, ob);
  if (typeof b === "string") throw new Error(b);
  const sharedB = await b.share(repoB, "", "live", null, null);
  ok("the other machine shares its clone", typeof sharedB !== "string");

  const tree = new TRoot();
  const app = await openWidecode({
    folder: repo,
    load: true,
    before: (w: Widecode) => {
      w.shell.resize(200);
      mount(w.shell, tree);
    },
  });
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
  await until(() => rows().some((r) => r.includes("desk") && r.includes(":" + String(a.port))));
  ok("this machine: its name and port on one row", has("This machine") && rows().some((r) => r.includes("desk") && r.includes(":" + String(a.port))));
  ok("the folder is not shared yet: an offer", has("share this folder"));
  ok("no peer yet", has("none paired yet"));

  app.host.kernel.commands.run("/peers share");
  await until(() => rows().some((r) => r.includes("◆ repo") && r.includes("live")));
  ok("/peers share: the repository is listed as shared, live, marked as this folder's", rows().some((r) => r.includes("◆ repo") && r.includes("live")) && !has("share this folder"));
  eq("the daemon shares it at its root", a.registry.repos[0].path, repo);

  // The other machine pairs in with the code this one shows.
  app.host.kernel.commands.run("/peers pair");
  await until(() => a.offer !== null && has(a.offer.code) && message().includes("pairing code"));
  const code = a.offer !== null ? a.offer.code : "";
  eq("a six-digit code is shown and told (code, in the message, the join line told)", String(/^[0-9]{6}$/.test(code)) + " " + String(message().includes(code)) + " " + String(message().includes("/peers join")), "true true true");
  const joined = await b.pairJoin("127.0.0.1", a.port, code, Date.now());
  ok("the other machine joined", typeof joined !== "string");

  key("char", "r");
  await until(() => has("● mac") && rows().some((r) => r.includes("◆ repo") && r.includes("↓1")), 600);
  ok("the peer shows online, with the commits to fetch over its repositories", rows().some((r) => r.includes("● mac") && r.includes("↓1")));
  ok("under it, its copy of this folder's repository, matched by root commit, says ↓1", rows().some((r) => r.includes("◆ repo") && r.includes("↓1")));
  const repoRow = rows().findIndex((r) => r.includes("◆ repo") && r.includes("↓1"));
  tab!.press(repoRow, 4);
  const page = (): string[] => {
    const view = app.code.pane.view;
    view.source.prepare(100);
    const out: string[] = [];
    for (let i = 0; i < view.source.count(); i++) out.push(view.source.line(i, 100).runs.map((x) => x.text).join(""));
    return out;
  };
  await until(() => page().some((l) => l.includes("Commits to fetch (1)")));
  ok("the page in the code column lists the commit to fetch", page().some((l) => l.includes("Commits to fetch (1)")) && page().some((l) => l.includes("second, elsewhere")));
  ok("and how to take it", page().some((l) => l.includes("git merge mac/main")));
  ok("the hint row says what the keys do here", has("↵ commits · f fetch"));
  ok("a remote named after the peer points at its copy", git("-C " + repo + " remote get-url mac") === "http://127.0.0.1:" + String(b.port) + "/" + (typeof sharedB === "string" ? "" : sharedB.key));
  const token = a.registry.peerById(b.identity.id)!.tokenWePresent;
  ok("the token is in the local git config, for the peer's base URL", git("-C " + repo + " config --get-all http.http://127.0.0.1:" + String(b.port) + "/.extraHeader") === "Authorization: Bearer " + token);
  eq("the commit is a remote-tracking ref, the working tree untouched", git("-C " + repo + " log -1 --format=%s mac/main") + " · " + git("-C " + repo + " status --short"), "second, elsewhere · ");

  app.host.kernel.commands.run("/peers fetch mac");
  await until(() => message().startsWith("fetched repo from mac"));
  ok("/peers fetch says what the peer has", message().includes("main: they have 1 commit you do not"));
  ok("the Git badge and the segment see it", tab !== null && tab.badge().some((r) => r.text === "↓1"));

  // Another repository of this machine, shared by its path from this session.
  const repoC = join(root, "other");
  mkdirSync(repoC);
  git("init -q " + repoC);
  writeFileSync(join(repoC, "c.txt"), "other\n");
  git("-C " + repoC + " add . && git -C " + repoC + " -c user.email=t@t -c user.name=t commit -qm other");
  app.host.kernel.commands.run("/peers share " + repoC);
  await until(() => rows().some((r) => r.includes("• other") && r.includes("live")));
  ok("/peers share <path>: another repository of this machine is shared too", rows().some((r) => r.includes("• other") && r.includes("live")) && a.registry.repos.length === 2);
  app.host.kernel.commands.run("/peers share " + repoB);
  await until(() => message().includes("already shared"));
  ok("a second checkout of this folder's repository is refused with the reason", message().includes("already shared from " + repo));

  // A repository the other machine has and this one lacks: listed under it as not here, cloned beside this folder.
  const repoD = join(root, "theirs-only");
  mkdirSync(repoD);
  git("init -q " + repoD);
  writeFileSync(join(repoD, "d.txt"), "theirs\n");
  git("-C " + repoD + " add . && git -C " + repoD + " -c user.email=t@t -c user.name=t commit -qm theirs");
  const sharedD = await b.share(repoD, "", "live", null, null);
  ok("the other machine shares one more repository", typeof sharedD !== "string");
  app.host.kernel.commands.run("/peers fetch mac");
  await until(() => rows().some((r) => r.includes("• theirs-only") && r.includes("not here")));
  ok("it is listed under the peer as not here", rows().some((r) => r.includes("• theirs-only") && r.includes("not here")));
  app.host.kernel.commands.run("/peers clone mac theirs-only " + join(root, "cloned"));
  await until(() => message().startsWith("cloned theirs-only"), 600);
  ok("/peers clone brings it, shared here", message().includes("to " + join(root, "cloned") + ", shared here as well") && existsSync(join(root, "cloned", "d.txt")) && a.registry.repoByPath(join(root, "cloned")) !== null);
  await until(() => rows().some((r) => r.includes("• theirs-only") && r.includes("level")));
  ok("and its row now says level", rows().some((r) => r.includes("• theirs-only") && r.includes("level")));

  // Hosting a bare repository by name: it shows as hosted, taking pushes at its key.
  app.host.kernel.commands.run("/peers host mirror");
  await until(() => rows().some((r) => r.includes("mirror") && r.includes("hosted")));
  ok("/peers host: a hosted repository under the store", rows().some((r) => r.includes("mirror") && r.includes("hosted")) && existsSync(join(storeA, "peers", "hosted", "mirror.git", "HEAD")));

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
  ok("forgotten: gone from the tab", !has("● mac") && !has("○ mac"));
  const after = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer " + theirToken, "ls-remote", ours], o);
  ok("and its token no longer opens this machine's door", after.code !== 0);

  unmount(app.shell);
  closeWidecode(app);
  a.stop();
  b.stop();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
