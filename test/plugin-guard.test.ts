// ffi: @lightstart/plugins/native/ffi.json
// A hook listener's own run firing its hook again waits for it, coalesces payload-less fires, and
// stops after a bound; a plugin whose calls keep failing is switched off; the same message told
// again is noted without firing messageChanged.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLog } from "@lightstart/lib/log.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Widecode } from "../src/compose.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { openWidecode } from "./support/app.ts";

const folder = mkdtempSync(join(tmpdir(), "widecode-guard-"));

const reenter = `widecode.plugin({
  id: "reenter",
  activate(api) {
    let n = 0;
    let inside = false;
    let nested = 0;
    api.on("messageChanged", () => {
      if (inside) nested++;
      inside = true;
      n++;
      if (n < 50) api.tell("loop " + n);
      inside = false;
      api.settings.setState({ nested, n });
    });
  },
});`;

const failing = `widecode.plugin({
  id: "failing",
  activate(api) {
    api.commands.add({ name: "/fail", help: "fail", run: () => { throw new Error("nope"); } });
  },
});`;

const main = async (): Promise<void> => {
  const logFile = join(folder, "guard.log");
  mkdirSync(folder, { recursive: true });
  openLog(logFile);
  let w: Widecode = await openWidecode({
    folder,
    before: (app: Widecode) => {
      app.js.extra = [new PluginSource("reenter.js", reenter)];
    },
  });
  w.host.screen.messageChanged.fire();
  const state = w.host.kernel.settings.state("reenter") as { nested?: unknown; n?: unknown } | null;
  eq("a re-entrant fire runs after the listener returns, once per outer call at most", String(state?.nested) + " " + String(state?.n), "0 9");
  eq("the last re-run's message is the one shown", w.host.screen.message.peek(), "loop 9");
  const dropped = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("dropped") && l.includes("re-entrant")) : [];
  eq("past the bound, one line says what was dropped", String(dropped.length), "1");
  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();

  w = await openWidecode({
    folder,
    before: (app: Widecode) => {
      app.js.extra = [new PluginSource("failing.js", failing)];
    },
  });
  for (let i = 0; i < 20; i++) w.host.roles.chat.submit("/fail");
  ok("a plugin failing repeatedly is switched off, saying why", !w.host.kernel.has("failing") && w.js.errors.some((e) => e.includes("plugin failing switched off: it kept failing: Error: nope")));
  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();

  w = await openWidecode({ folder });
  const fired: string[] = [];
  const noted: string[] = [];
  w.host.screen.messageChanged.add("guard", () => fired.push(w.host.screen.message.peek()));
  w.host.onLog = (text: string) => noted.push(text);
  w.host.screen.tell("same");
  w.host.screen.tell("same");
  w.host.screen.tell("other");
  eq("the same message told twice fires messageChanged once", fired.join(" | "), "same | other");
  eq("and both tells are still noted", String(noted.filter((t) => t === "same").length), "2");
  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();
  openLog(null);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
