// ffi: @lightstart/plugins/native/ffi.json
// The user's keys.json and /keymap. keys.json (beside config.json) is the keymap's top layer: it
// rebinds a core action (F6 to the code column), binds a key to a plugin's action, unbinds one with
// null (F5 cycles no model), its entries drawn in the hints and /help; a malformed file gives a
// notice and the keys stay the keymap's; /reload reads it again. A plugin brings a keymap
// (api.keys.keymap) and turns its layer on when state.keymap() names it: config.json's "keymap"
// chooses it at start, /keymap switches (an unknown name refused, the names completed), the choice
// kept in state.json and read before config.json's on the next start; the keymapChanged hook.
// The keymap unasked is emacs.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import { Store } from "../src/services/store.ts";
import type { Widecode } from "../src/compose.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

const vi = `widecode.plugin({
  id: "vi-test",
  activate(api) {
    const layer = api.keys.layer("vi-normal", { "": { f9: "app.focus.code" } });
    const follow = () => (api.state.keymap() === "vi" ? layer.on() : layer.off());
    api.keys.keymap({ id: "vi", name: "vi keys" });
    api.on("keymapChanged", () => { follow(); api.tell("keymap now " + api.state.keymap()); });
    follow();
    api.keys.action({ id: "vi.hello", scope: "", run: () => { api.tell("hello from vi"); return true; } });
  },
});`;

/** An app over `home`'s store, with the vi test plugin, started as main starts it (keys.json, the keymap kept or config.json's). */
const start = async (folder: string, home: string, config: unknown): Promise<Widecode> => {
  const store = new Store(home);
  let plugins: unknown = null;
  const w = await openWidecode({
    folder,
    start: false,
    before: (w: Widecode) => {
      w.js.extra = [new PluginSource("vi.js", vi)];
      const read = store.loadConfig(w.defaults());
      w.host.keys.onRead = () => store.readKeys();
      w.host.keys.applyUser();
      if (read.keymap.length > 0) w.host.keys.keymap = read.keymap;
      plugins = config !== null ? config : read.plugins;
    },
  });
  w.start(plugins, store.stateFile(), []);
  await w.host.load();
  return w;
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-keys-json-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-keys-json-home-"));
  writeFileSync(join(home, "keys.json"), '{ "": { "f6": "app.focus.code", "f8": "vi.hello", "f5": null }, "code": { "char:n": null } }\n');
  const w = await start(folder, home, null);
  const press = (app: Widecode, name: string, text = ""): boolean => app.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const said = (app: Widecode): string => app.host.screen.message.peek();

  ok("keys.json rebinds a core action's key: F6 goes to the code column", press(w, "f6") && w.host.screen.active.peek() === "code");
  ok("binds a key to a plugin's action", press(w, "f8") && said(w) === "hello from vi");
  ok("null unbinds: F5 cycles no model, n no change", !press(w, "f5") && !press(w, "char", "n"));
  w.host.screen.focus("chat");
  eq("the hints follow: no F5 model, the code column on F6", w.host.screen.hints(), "Enter sends · @ file · Esc interrupts · Shift+Tab plan · /help");
  w.host.screen.focus("code");
  eq("in the code column: p alone for the changes", w.host.screen.hints().split(" · ")[1], "p changes");
  w.host.roles.chat.submit("/help");
  const help = w.host.conversation.model.turns[w.host.conversation.model.turns.length - 1].after.children.map((i) => i.text).join("");
  ok("/help says the keys as keys.json has them, and the keymap, emacs unasked", help.includes("F6 code") && help.includes("F1 chat") && help.includes("Keymap: emacs"));

  // A malformed file: a notice, the keymap's own keys; /reload reads the file again.
  writeFileSync(join(home, "keys.json"), "{ nope\n");
  ok("a malformed keys.json is said, and the keys are the keymap's again", w.host.keys.applyUser().startsWith("keys.json is not valid JSON") && press(w, "f5"));
  writeFileSync(join(home, "keys.json"), '{ "": { "f6": "app.focus.side" } }\n');
  w.js.reload();
  ok("/reload reads keys.json again", press(w, "f6") && w.host.screen.active.peek() === "side");

  // /keymap.
  eq("the keymaps there are, emacs in use", w.host.keys.names().join(",") + " " + w.host.keys.keymap, "default,emacs,vi emacs");
  w.host.roles.chat.submit("/keymap");
  eq("/keymap says", said(w), "keymap emacs (default, emacs, vi); /keymap <name> switches");
  w.host.roles.chat.submit("/keymap nope");
  eq("an unknown name", said(w), "no keymap named nope (default, emacs, vi)");
  ok("the plugin's layer is off", !press(w, "f9"));
  w.host.roles.chat.submit("/keymap vi");
  ok("switched: the plugin turned its layer on from the hook", said(w) === "keymap vi" && press(w, "f9") && w.host.screen.active.peek() === "code");
  const command = w.host.kernel.commands.find("/keymap");
  eq("the names complete", command !== null && command.onComplete !== null ? command.onComplete("v").map((s) => s.value + (s.detail.length > 0 ? ":" + s.detail : "")).join(",") : "none", "vi:now");
  closeWidecode(w);

  // The next start: the choice kept in state.json comes before config.json's "keymap".
  writeFileSync(join(home, "config.json"), '{ "keymap": "emacs", "plugins": {} }\n');
  const w2 = await start(folder, home, null);
  ok("kept for the next run, before config.json's", w2.host.keys.keymap === "vi" && press(w2, "f9") && w2.host.screen.active.peek() === "code");
  closeWidecode(w2);

  // config.json's "keymap" when nothing is kept.
  const home2 = mkdtempSync(join(tmpdir(), "widecode-keys-json-home2-"));
  writeFileSync(join(home2, "config.json"), '{ "keymap": "vi", "plugins": {} }\n');
  const w3 = await start(folder, home2, null);
  ok("config.json chooses the keymap at start", w3.host.keys.keymap === "vi" && press(w3, "f9") && w3.host.screen.active.peek() === "code");
  closeWidecode(w3);

  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(home2, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
