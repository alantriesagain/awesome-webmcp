// ffi: @lightstart/plugins/native/ffi.json
// widecode's JS plugins in the embedded engine (natively QuickJS; under node, node:vm through
// wcjs-node.mjs, the same calls): a plugin's command, key, hook, message, settings and kept state;
// the drawing helpers; one replacing a built-in of its id, and a later one replacing an earlier; a
// requirement not met reported; an error in a plugin's function reported without stopping
// widecode; a plugin running past its time budget switched off with what it added, the plugin that
// ran its command left running; a call from another async function (natively, another fiber's
// stack), a hook the core fires inside an async function, and a recursion too deep, ending in an
// error the plugin could catch; an edit taking effect on reload, asked for from inside a plugin's
// call (the old command gone); plugin files read from a folder; trust for a project's own plugins.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringWidth } from "@lightstart/light/native/tui/width.ts";
import { PluginSource, sourcesIn } from "@lightstart/plugins/sources.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { Store } from "../src/services/store.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const greeter = `widecode.plugin({
  id: "greeter",
  defaults: () => ({ greeting: "hello" }),
  activate(api) {
    const greeting = (api.settings.section() ?? { greeting: "hi" }).greeting;
    let changes = 0;
    api.commands.add({ name: "/greet", usage: "<name>", help: "say hello", run: (name) => api.tell(greeting + " " + name) });
    api.commands.add({ name: "/boom", help: "fail", run: () => { throw new Error("boom"); } });
    api.keys.add("char:z", "code", "z greet", (key) => { api.tell("z pressed: " + key.spec); return true; });
    api.keys.add("char:q", "code", "", () => false);
    api.on("conversationChanged", () => { changes++; api.settings.setState({ changes }); });
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-js-"));
  // One state for every app below: what a plugin keeps outlives the app that kept it.
  const state = new NoStateFile();
  const make = (sources: PluginSource[], config: string): Promise<Widecode> =>
    openWidecode({
      folder,
      plugins: JSON.parse(config),
      state,
      before: (w: Widecode) => {
        w.js.extra = sources;
      },
    });
  const press = (w: Widecode, name: string, text: string): boolean => w.shell.handleKey(new KeyEvent(name, text, false, false, false));

  let w = await make([new PluginSource("greeter.js", greeter)], '{"greeter": {"greeting": "olá"}}');
  ok("a JS plugin starts beside the compiled ones", w.host.kernel.has("greeter") && w.host.kernel.has("code") && w.js.errors.length === 0);
  w.host.roles.chat.submit("/greet Ana");
  eq("its command, with its settings", w.host.screen.message.peek(), "olá Ana");
  w.host.screen.focus("code");
  ok("its key, in its scope", press(w, "char", "z") && w.host.screen.message.peek() === "z pressed: char:z");
  ok("a key it passes on goes on", !press(w, "char", "q"));
  ok("its hint among the column's", w.host.screen.hints().includes("z greet"));
  w.host.conversation.changed();
  w.host.conversation.changed();
  const kept = w.host.kernel.settings.state("greeter") as { changes?: unknown } | null;
  ok("its hook, and the state it keeps", kept !== null && typeof kept.changes === "number" && kept.changes >= 2);
  w.host.roles.chat.submit("/boom");
  ok("an error in its function is reported, widecode goes on", w.js.errors.some((e) => e.startsWith("greeter: Error: boom")) && w.host.kernel.has("greeter"));
  eq("its default section for a new config.json", JSON.stringify(w.defaults().filter((d) => d.id === "greeter").map((d) => d.value)), '[{"greeting":"hello"}]');
  w.host.kernel.stop();

  const models = `widecode.plugin({ id: "models", activate(api) { api.commands.add({ name: "/model", help: "from JS", run: () => api.tell("the JS models") }); } });`;
  w = await make([new PluginSource("models.js", models)], "{}");
  w.host.roles.chat.submit("/model");
  eq("a plugin with a built-in's id replaces it", w.host.screen.message.peek() + " | " + String(w.host.kernel.started.filter((p) => p.id === "models").length), "the JS models | 1");
  w.host.kernel.stop();

  const first = `widecode.plugin({ id: "twice", activate(api) { api.commands.add({ name: "/which", run: () => api.tell("first") }); } });`;
  const second = `widecode.plugin({ id: "twice", activate(api) { api.commands.add({ name: "/which", run: () => api.tell("second") }); } });`;
  const needy = `widecode.plugin({ id: "needy", requires: ["nothing-here"], activate(api) {} });`;
  const broken = `widecode.plugin({ id: "broken" activate() {} });`;
  w = await make([new PluginSource("first.js", first), new PluginSource("second.js", second), new PluginSource("needy.js", needy), new PluginSource("broken.js", broken)], "{}");
  w.host.roles.chat.submit("/which");
  eq("a later plugin of an id replaces an earlier", w.host.screen.message.peek(), "second");
  ok("a requirement not met is reported", w.host.kernel.problems.some((p) => p === "needy: needs nothing-here, which is not built in"));
  ok("a file that does not parse is reported, the others load", w.js.errors.some((e) => e.startsWith("broken.js: SyntaxError")) && w.host.kernel.has("twice"));
  w.host.kernel.stop();

  const utils = `widecode.plugin({ id: "utils", activate(api) {
    const u = widecode.util;
    api.commands.add({ name: "/util", run: () => api.tell([u.width("日本a"), u.clip("abcdef", 4), u.clip("👨‍👩‍👧👨‍👩‍👧x", 3), u.runsWidth(u.pad([{ text: "ab" }], 5)), [12000, 200000, 8400000, 25 * 86400000].map(u.age).join(" "), u.elapsed(65000), u.tokens(1234567)].join(" ")) });
    api.commands.add({ name: "/widths", run: (list) => api.tell(JSON.stringify(JSON.parse(list).map(u.width))) });
  } });`;
  w = await make([new PluginSource("utils.js", utils)], "{}");
  w.host.roles.chat.submit("/util");
  eq("the drawing helpers: cells, clipping, padding, times, tokens", w.host.screen.message.peek(), "5 abc… 👨‍👩‍👧… 5 12s 3m 2h20m 25d 1m 1.2M");
  const samples = ["plain", "日本語", "e\u0301", "👍", "👍🏽", "👨‍👩‍👧", "🇧🇷", "🇧🇷🇺🇸x", "❤️", "☀", "⌚", "│─┌ →●▸⎇↻▰▱", "a\tb", "Ａ", "〿", "🌡", "✅ done", "한국"];
  w.host.roles.chat.submit("/widths " + JSON.stringify(samples));
  eq("widths as the screen counts them", w.host.screen.message.peek(), JSON.stringify(samples.map(stringWidth)));
  w.host.kernel.stop();

  const runaway = `widecode.plugin({ id: "runaway", activate(api) {
    api.commands.add({ name: "/spin", help: "loop", run: () => { for (;;) {} } });
    api.keys.add("char:s", "code", "s spin", () => { for (;;) {} });
  } });`;
  // A plugin that runs another command from inside its own.
  const caller = `widecode.plugin({ id: "caller", activate(api) {
    api.commands.add({ name: "/call", usage: "<command>", run: (command) => { api.commands.run(command); api.tell("caller goes on"); } });
  } });`;
  w = await make([new PluginSource("runaway.js", runaway), new PluginSource("caller.js", caller)], "{}");
  w.host.roles.chat.submit("/call /spin");
  ok("past its time budget: switched off, with what it added", !w.host.kernel.has("runaway") && w.host.kernel.commands.find("/spin") === null && w.js.errors.some((e) => e.includes("runaway switched off")));
  ok("the plugin that ran its command goes on: a call it makes has its own budget", w.host.kernel.has("caller") && w.host.screen.message.peek() === "caller goes on");
  w.host.screen.focus("code");
  ok("its key went with it", !press(w, "char", "s"));
  w.host.kernel.stop();

  const deep = `widecode.plugin({ id: "deep", activate(api) {
    const down = (n) => (n <= 0 ? 0 : 1 + down(n - 1));
    api.commands.add({ name: "/deep", usage: "<n>", help: "recurse", run: (n) => api.tell("deep " + down(Number(n))) });
  } });`;
  w = await make([new PluginSource("deep.js", deep)], "{}");
  /** `text` submitted from another async function (natively, on its own fiber), and the message after. */
  const elsewhere = async (text: string): Promise<string> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    w.host.roles.chat.submit(text);
    return w.host.screen.message.peek();
  };
  eq("called from another async function", await elsewhere("/deep 150"), "deep 150");
  await elsewhere("/deep 10000000");
  ok("too deep: an error, and the plugin goes on", w.js.errors.some((e) => e.startsWith("deep: RangeError")) && w.host.kernel.has("deep"));
  eq("and still answers", await elsewhere("/deep 3"), "deep 3");
  w.host.kernel.stop();

  // A hook the core fires inside an async function runs on that function's own stack, while the plugin that set it off waits on its own.
  const hooked = `widecode.plugin({ id: "hooked", activate(api) {
    const down = (n) => (n <= 0 ? 0 : 1 + down(n - 1));
    let heard = 0;
    api.on("baseChanged", () => { heard = down(100); });
    api.commands.add({ name: "/rebase", run: () => {
      api.actions.setBase("HEAD", "head", "HEAD");
      api.tell("heard " + heard + ", then " + down(150));
    } });
  } });`;
  w = await make([new PluginSource("hooked.js", hooked)], "{}");
  eq("a hook fired inside an async function, and the caller after it", await elsewhere("/rebase"), "heard 100, then 150");
  w.host.kernel.stop();

  const dir = join(folder, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "b.js"), `widecode.plugin({ id: "editable", activate(api) { api.commands.add({ name: "/v", run: () => api.tell("v1") }); api.commands.add({ name: "/old", run: () => api.tell("old") }); } });`);
  writeFileSync(join(dir, "a.txt"), "not a plugin");
  eq("a folder's plugin files, by name", sourcesIn(dir).map((s) => s.file.slice(dir.length + 1)).join(" "), "b.js");
  w = await openWidecode({
    folder,
    state,
    before: (w: Widecode) => {
      w.js.dirs = [dir];
      w.js.extra = [new PluginSource("caller.js", caller)];
    },
  });
  w.host.roles.chat.submit("/v");
  eq("loaded from the folder", w.host.screen.message.peek(), "v1");
  writeFileSync(join(dir, "b.js"), `widecode.plugin({ id: "editable", activate(api) { api.commands.add({ name: "/v", run: () => api.tell("v2") }); } });`);
  // Asked for from inside a plugin's call: the context it runs in is let go after the call.
  w.host.roles.chat.submit("/call /reload");
  w.host.roles.chat.submit("/v");
  eq("an edit takes effect on reload, asked for from inside a plugin's call", w.host.screen.message.peek(), "v2");
  ok("and what the old version added is gone", w.host.kernel.commands.find("/old") === null && w.host.kernel.has("editable"));

  // A saved file reloads alone: its plugins replaced, the others untouched.
  const callerBefore = w.host.kernel.started.find((p) => p.id === "caller");
  writeFileSync(join(dir, "b.js"), `widecode.plugin({ id: "editable", activate(api) { api.commands.add({ name: "/v", run: () => api.tell("v3") }); api.every(5, () => { globalThis.__ticks = (globalThis.__ticks ?? 0) + 1; }); } });
widecode.plugin({ id: "second", activate(api) { api.commands.add({ name: "/s", run: () => api.tell("s") }); } });`);
  w.js.syncFolder(dir);
  w.host.roles.chat.submit("/v");
  const v3 = w.host.screen.message.peek();
  w.host.roles.chat.submit("/s");
  eq("a file saved reloads its own plugins, two of them here", v3 + " " + w.host.screen.message.peek(), "v3 s");
  ok("the other plugins are untouched, not restarted", w.host.kernel.started.find((p) => p.id === "caller") === callerBefore && w.host.kernel.has("caller"));
  writeFileSync(join(dir, "b.js"), `widecode.plugin({ id: "editable" activate() {} });`);
  w.js.syncFolder(dir);
  w.host.roles.chat.submit("/v");
  ok("a file that fails to evaluate keeps its previous plugins running, and says why", w.host.screen.message.peek() === "v3" && w.host.kernel.has("second") && w.js.errors.some((e) => e.includes("b.js: SyntaxError")));
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  writeFileSync(join(dir, "b.js"), `widecode.plugin({ id: "editable", activate(api) { api.commands.add({ name: "/ticks", run: () => api.tell(String(globalThis.__ticks ?? 0)) }); } });`);
  w.js.syncFolder(dir);
  ok("a plugin the file no longer defines is gone", !w.host.kernel.has("second") && w.host.kernel.commands.find("/s") === null);
  w.host.roles.chat.submit("/ticks");
  const ticksThen = w.host.screen.message.peek();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  w.host.roles.chat.submit("/ticks");
  ok("the retired instance's timer stopped", Number(ticksThen) > 0 && w.host.screen.message.peek() === ticksThen);
  writeFileSync(join(dir, "models.js"), models);
  w.js.syncFolder(dir);
  w.host.roles.chat.submit("/model");
  eq("a file saved with a built-in's id replaces it", w.host.screen.message.peek() + " " + (w.js.plugins.find((p) => p.id === "models")?.file.endsWith("models.js") === true ? "from the file" : "?"), "the JS models from the file");
  rmSync(join(dir, "models.js"));
  w.js.syncFolder(dir);
  ok("the file removed, the built-in comes back", w.host.kernel.has("models") && (w.js.plugins.find((p) => p.id === "models")?.file ?? "").endsWith("/dist/plugins/models/index.js") && w.host.kernel.commands.find("/model") !== null);
  w.host.kernel.stop();

  const home = mkdtempSync(join(tmpdir(), "widecode-js-home-"));
  const store = new Store(home);
  ok("a project's plugins are not trusted at first", !store.trusted(folder));
  store.trust(folder);
  ok("then trusted, and kept", new Store(home).trusted(folder) && !new Store(home).trusted("/elsewhere"));
  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
