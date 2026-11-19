// ffi: @lightstart/plugins/native/ffi.json
// A hook listener's own change of the state it hears is heard after it returns, never nested, and
// one turn delivers it at most nine times; a plugin whose calls keep failing is switched off; the same message told again is noted without changing
// the message.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLog } from "@lightstart/lib/log.ts";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Widecode } from "../src/compose.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { openWidecode } from "./support/app.ts";
import { afterChange } from "../src/host/after-change.ts";

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

const hungry = `widecode.plugin({
  id: "hungry",
  activate(api) {
    api.commands.add({ name: "/hungry", help: "fill the engine", run: () => { throw new Error("InternalError: out of memory"); } });
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
  w.host.screen.message.value = "start";
  const state = w.host.kernel.settings.state("reenter") as { nested?: unknown; n?: unknown } | null;
  eq("a listener's own change is heard after it returns, never nested, nine times in one turn at most", String(state?.nested) + " " + String(state?.n), "0 9");
  eq("the last delivered run's message is the one shown", w.host.screen.message.peek(), "loop 9");
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

  w = await openWidecode({
    folder,
    before: (app: Widecode) => {
      app.js.extra = [new PluginSource("hungry.js", hungry)];
    },
  });
  w.host.roles.chat.submit("/hungry");
  ok("an engine out of memory starts the plugins again instead of switching them off", w.host.kernel.has("hungry") && w.js.errors.some((e) => e.includes("ran out of their 256 MB and were started again")));
  for (let i = 0; i < 20; i++) w.host.roles.chat.submit("/hungry");
  ok("running out again soon after counts as any failure, and switches the plugin off", !w.host.kernel.has("hungry"));
  w.host.kernel.stop();
  w.js.stopWatching();
  w.host.workspace.close();

  w = await openWidecode({ folder });
  const fired: string[] = [];
  const noted: string[] = [];
  afterChange(w.host.screen.message, () => fired.push(w.host.screen.message.peek()));
  w.host.onLog = (text: string) => noted.push(text);
  w.host.screen.tell("same");
  w.host.screen.tell("same");
  w.host.screen.tell("other");
  eq("the same message told twice is heard once", fired.join(" | "), "same | other");
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
