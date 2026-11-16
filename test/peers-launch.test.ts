// ffi: @lightstart/plugins/native/ffi.json
// The app as a test hosts it (openWidecode) names no daemon launcher, so the peers plugin, with no
// daemon answering, only reports that none runs: it never starts one, not on its timer, not when the
// tab is shown, not for /peers pair. The regression this guards: the plugin once ran the program it
// was in with --peers-daemon, which under the test runner was the test itself.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsPanel } from "../src/runtime/views.ts";
import { TRoot, mount, unmount } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const root = mkdtempSync(join(tmpdir(), "widecode-peers-launch-"));
const store = join(root, "store");
const repo = join(root, "repo");
mkdirSync(store);
mkdirSync(repo);
process.env["WIDECODE_HOME"] = store;
spawnSync("sh", ["-c", "git init -q -b main '" + repo + "'"], { encoding: "utf8" });
writeFileSync(join(repo, "a.txt"), "one\n");
spawnSync("sh", ["-c", "git -C '" + repo + "' add . && git -C '" + repo + "' -c user.email=t@t -c user.name=t commit -qm first"], { encoding: "utf8" });

const main = async (): Promise<void> => {
  const app = await openWidecode({ folder: repo });
  const tree = new TRoot();
  app.shell.resize(200);
  mount(app.shell, tree);
  await app.host.load();
  eq("a hosted app names no launcher", app.host.peersLauncher, "");
  const panel = app.host.screen.findPanel("peers");
  const tab = panel instanceof JsPanel ? panel : null;
  ok("the Peers tab is there", tab !== null);
  const rows = (): string[] => {
    const out: string[] = [];
    if (tab === null) return out;
    for (let i = 0; i < tab.rows.count(); i++) out.push(tab.rows.line(i, 90).runs.map((r) => r.text).join(""));
    return out;
  };
  app.host.screen.focus("side");
  app.host.screen.showPanel("peers");
  for (let i = 0; i < 150 && !rows().some((r) => r.includes("could not start")); i++) await wait(20);
  ok("shown with no daemon and no launcher: it says so", rows().some((r) => r.includes("could not start")));
  app.host.kernel.commands.run("/peers pair");
  for (let i = 0; i < 50 && !app.host.screen.message.peek().includes("could not start"); i++) await wait(20);
  ok("/peers pair: told it could not start", app.host.screen.message.peek().includes("could not start"));
  await wait(1500);
  ok("no daemon state appeared", !existsSync(join(store, "peers", "daemon.json")));
  unmount(app.shell);
  closeWidecode(app);
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
