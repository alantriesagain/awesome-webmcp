// ffi: @lightstart/plugins/native/ffi.json
// Keys as actions and keymaps, from a plugin: an action with a name and its default key, one with
// several keys and one with none (a keymap alone binds it), the count its function gets; a layer
// rebinding a core action's key (F6 to the code column), binding a key the core leaves alone,
// unbinding one with null (F5 cycles no model), a "*" entry seeing every key of a scope after the
// key's own actions, turned off and on; the hints and /help showing the actions' help; a later
// action of an id replacing the core's; the plugin switched off taking its actions and layers
// with it. Runs under node and natively.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Lightcode } from "../src/compose.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";

const keymap = `lightcode.plugin({
  id: "keymap-test",
  activate(api) {
    const seen = [];
    api.keys.action({ id: "test.hello", scope: "code", help: "hello", key: "char:h", run: (key, count) => { seen.push("hello " + key.spec + " x" + count); return true; } });
    api.keys.action({ id: "test.two", scope: "code", help: "two", key: ["char:i", "char:j"], run: (key) => { seen.push("two " + key.spec); return true; } });
    api.keys.action({ id: "test.bare", scope: "", run: () => { seen.push("bare"); return true; } });
    api.keys.action({ id: "test.any", scope: "code", key: "*", run: (key) => { seen.push("any " + key.spec); return key.name === "delete"; } });
    const layer = api.keys.layer("mine", { "": { f6: "app.focus.code", f9: "test.bare", f5: null }, code: { "char:k": ["test.two", "test.hello"] } });
    api.commands.add({ name: "/seen", run: () => api.tell("[" + seen.splice(0).join(", ") + "]") });
    api.commands.add({ name: "/layer", run: (arg) => (arg === "off" ? layer.off() : layer.on()) });
    api.commands.add({ name: "/replace", run: () => api.keys.action({ id: "app.focus.side", key: "f2", run: () => { seen.push("mine, not the core's"); return true; } }) });
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-keymap-"));
  const w = await openLightcode({
    folder,
    load: true,
    before: (w: Lightcode) => {
      w.js.extra = [new PluginSource("keymap.js", keymap)];
    },
  });
  const c = w.host.conversation;
  const press = (name: string, text: string): boolean => w.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const said = (): string => w.host.screen.message.peek();
  const seen = (): string => {
    w.host.roles.chat.submit("/seen");
    return said().slice(1, -1);
  };

  w.host.screen.focus("code");
  ok("an action on its key, in its scope, with a count of 1", press("char", "h") && seen() === "hello char:h x1");
  ok("one with several keys", press("char", "i") && press("char", "j") && seen() === "two char:i, two char:j");
  ok("* sees a key of the scope after the key's own actions, and passes what it does not take", !press("char", "q") && press("delete", "") && seen() === "any char:q, any delete");
  w.host.screen.focus("chat");
  ok("the same key in the chat: not the action's scope, so the composer takes it", press("char", "h") && seen() === "" && w.chat.pane.input.value() === "h");
  w.chat.pane.input.lines = [""];
  w.chat.pane.input.col = 0;
  ok("a layer rebinds a core action's key: F6 goes to the code column", press("f6", "") && w.host.screen.active.peek() === "code");
  ok("and binds a key to an action with no key of its own (the code column's * saw it first and passed)", press("f9", "") && seen() === "any f9, bare");
  ok("null unbinds: F5 cycles no model", !press("f5", "") && seen() === "any f5");
  ok("an entry with two actions runs the first that takes the key", press("char", "k") && seen() === "two char:k");
  eq("the hints show the actions' keys as the keymap binds them (k from the layer), and their help", w.host.screen.hints().split(" · ").slice(0, 6).join(" · "), "[/] changed files · n/p changes · w wrap · f follow · h/k hello · i/k two");
  w.host.roles.chat.submit("/layer off");
  ok("the layer off: the core's F6 again, F9 nothing, F5 the model", press("f6", "") && w.host.screen.active.peek() === "tools" && !press("f9", "") && press("f5", ""));
  w.host.roles.chat.submit("/layer on");
  ok("and on", press("f6", "") && w.host.screen.active.peek() === "code");
  w.host.roles.chat.submit("/replace");
  seen();
  ok("a later action of an id replaces the core's", press("f2", "") && w.host.screen.active.peek() === "code" && seen() === "any f2, mine, not the core's");
  w.host.roles.chat.submit("/help");
  const help = c.model.turns[c.model.turns.length - 1].after.children.map((i) => i.text).join("");
  ok("/help lists the keys and help", help.includes("h/k hello") && help.includes("i/k two") && help.includes("Keymap: emacs"));

  // Switched off: its actions and layer are gone.
  closeLightcode(w);
  const off: unknown = { "keymap-test": false };
  const w2 = await openLightcode({
    folder,
    plugins: off,
    load: true,
    before: (w: Lightcode) => {
      w.js.extra = [new PluginSource("keymap.js", keymap)];
    },
  });
  const press2 = (name: string, text: string): boolean => w2.shell.handleKey(new KeyEvent(name, text, false, false, false));
  w2.host.screen.focus("code");
  ok("switched off: no action, no layer", !press2("char", "h") && press2("f6", "") && w2.host.screen.active.peek() === "tools" && w2.host.kernel.keys.all().every((l) => l.owner !== "keymap-test"));
  closeLightcode(w2);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
