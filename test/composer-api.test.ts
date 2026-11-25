// ffi: @lightstart/plugins/native/ffi.json
// The composer from a plugin (api.composer, api.keys.run): its lines and caret read, set (the
// caret clamped) and inserted into; whether it is empty, the suggestion strip shows or the request
// panel is open; an action run by name with a count; the border title set; lightcode.util.graphemes
// counting as the caret does; and a "*" action of the "input" scope in a layer, turned on, taking
// every key before the composer's own (a vi mode's normal mode), turned off giving them back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import type { Lightcode } from "../src/compose.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { DEFAULT_STYLE, KeyEvent, TRoot, frames, layout, mount } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const plugin = `lightcode.plugin({
  id: "composer-test",
  activate(api) {
    const say = (v) => api.tell(JSON.stringify(v));
    api.commands.add({ name: "/get", run: () => say(api.composer.get()) });
    api.commands.add({ name: "/set", run: (arg) => { const [lines, row, col] = JSON.parse(arg); api.composer.set(lines, row, col); } });
    api.commands.add({ name: "/insert", run: (arg) => api.composer.insert(arg) });
    api.commands.add({ name: "/run", run: (arg) => { const [id, count] = arg.split(" "); say(api.keys.run(id, Number(count ?? 1))); } });
    api.commands.add({ name: "/label", run: (arg) => api.composer.setLabel(arg) });
    api.commands.add({ name: "/graphemes", run: (arg) => say(lightcode.util.graphemes(arg)) });
    let taken = [];
    api.keys.action({ id: "test.normal", scope: "input", run: (key) => { taken.push(key.spec); return true; } });
    const normal = api.keys.layer("normal", { input: { "*": "test.normal" } });
    normal.off();
    api.commands.add({ name: "/normal", run: (arg) => (arg === "on" ? normal.on() : normal.off()) });
    api.commands.add({ name: "/taken", run: () => say(taken.splice(0)) });
  },
});`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "lightcode-composer-api-"));
  const w = await openLightcode({
    folder,
    before: (w: Lightcode) => {
      w.js.extra = [new PluginSource("composer.js", plugin)];
    },
  });
  const c = w.host.conversation;
  // Mounted, so the composer's change and submit events reach the pane (the strip follows them).
  const root = new TRoot();
  w.shell.resize(160);
  mount(w.shell, root);
  await w.host.session.load(w.host.folder, w.host.hooks);
  frames.flush();
  layout(root, 160, 30, DEFAULT_STYLE);
  const input = w.chat.pane.input;
  const press = (name: string, text = ""): boolean => w.shell.handleKey(new KeyEvent(name, text, false, false, false));
  const said = (command: string): string => {
    w.host.roles.chat.submit(command);
    return w.host.screen.message.peek();
  };
  w.host.screen.focus("chat");

  eq("the composer read, empty", said("/get"), '{"lines":[""],"row":0,"col":0,"empty":true,"strip":false,"panel":false}');
  w.host.roles.chat.submit('/set [["one","twö"],1,9]');
  eq("set, the caret clamped to the line", said("/get"), '{"lines":["one","twö"],"row":1,"col":3,"empty":false,"strip":false,"panel":false}');
  w.host.roles.chat.submit("/insert X");
  eq("inserted at the caret", JSON.stringify(input.lines) + " " + String(input.col), '["one","twöX"] 4');
  eq("an action run by name with a count (two word moves: the word's start, then the line before's end)", said("/run editor.wordLeft 2") + " " + JSON.stringify(input.lines) + " @" + String(input.row) + ":" + String(input.col), 'true ["one","twöX"] @0:3');
  eq("one that is not there", said("/run nope"), "false");
  eq("graphemes as the caret counts", said("/graphemes é👍🏽x"), '["é","👍🏽","x"]');
  w.host.roles.chat.submit("/label -- NORMAL --");
  eq("the label", w.chat.pane.label.peek(), "-- NORMAL --");
  // The strip and the panel, read as the plugin would (a command submitted would close the strip first).
  const get = (): string => w.js.answer("composer.get", "[]").text;
  w.host.roles.chat.submit("/set [[\"\"],0,0]");
  press("char", "/");
  press("char", "h");
  ok("the strip showing (a command typed) is said", get().includes('"strip":true'));
  press("escape");
  ok("and gone", get().includes('"strip":false'));
  w.host.roles.chat.submit("/set [[\"\"],0,0]");
  c.model.send("x", 0);
  c.receive(JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] } } }));
  ok("the panel open is said", get().includes('"panel":true'));
  press("escape");
  ok("and declined", get().includes('"panel":false'));

  // A layer's "*" in the input scope: every key the composer would take, before it.
  w.host.roles.chat.submit("/set [[\"\"],0,0]");
  w.host.roles.chat.submit("/normal on");
  ok("on: the keys go to the plugin, the composer stays", press("char", "a") && press("left") && press("backspace") && said("/taken") === '["char:a","left","backspace"]' && input.value() === "");
  ok("the shell's keys still come first", press("f3") && w.host.screen.active.peek() === "code" && said("/taken") === "[]");
  w.host.screen.focus("chat");
  w.host.roles.chat.submit("/normal off");
  ok("off: the composer again", press("char", "a") && input.value() === "a" && said("/taken") === "[]");

  closeLightcode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
