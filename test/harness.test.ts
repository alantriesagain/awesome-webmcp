// ffi: @lightstart/plugins/native/ffi.json
// The project's harness, `.widecode/` trusted as one: its config.json over the user's (a plugin
// switched off, a section, the columns' widths), its plugins, its prompt.md appended to Claude
// Code's system prompt after the fixed paragraph that says the agent runs inside widecode (with
// --system-prompt-snapshot off, so an edit reaches a resumed session); prompt.md edited during a
// turn restarts the CLI at the turn's end on the same session; config.json edited applies without
// a reload; an untrusted folder's harness stays out, the prompt saying so. The harness plugin's
// tools, called with Claude's token over a painted screen; /harness and /harness init. Against the
// fake CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSource } from "@lightstart/plugins/sources.ts";
import { mergePlugins } from "../src/services/harness.ts";
import { Store } from "../src/services/store.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Caret, Clip, DEFAULT_STYLE, Screen, TRoot, frames, layout, mount, paint, KeyEvent } from "@lightstart/light/native/tui";
import { Run } from "@lightstart/tui/line-view.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const greeter = `widecode.plugin({ id: "greeter", defaults: () => ({ greeting: "hello" }), activate(api) {
  const greeting = String((api.settings.section() ?? { greeting: "hi" }).greeting);
  api.commands.add({ name: "/greet", usage: "<name>", run: (name) => api.tell(greeting + " " + name) });
} });`;
const probe = `widecode.plugin({ id: "probe", activate(api) {
  let harness = 0;
  api.on("harnessChanged", () => { harness++; });
  api.commands.add({ name: "/hc", run: () => api.tell(String(harness)) });
} });`;

/** A JSON-RPC POST to the server with `token`: the status, a space, the body's text. */
const post = (url: string, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token } }, (res: IncomingMessage) => {
      let text = "";
      res.on("data", (c: Buffer) => {
        text += c.toString("utf8");
      });
      res.on("end", () => resolve(String(res.statusCode) + " " + text));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

/** The CLI's recorded argv as text, one argument per line (the prompt spans several). */
const argvOf = (path: string): string => readFileSync(path, "utf8");
/** The value after `name` up to the next flag. */
const flag = (argv: string, name: string): string => {
  const at = argv.indexOf("\n" + name + "\n");
  if (at < 0) return "";
  const rest = argv.slice(at + name.length + 2);
  const end = rest.search(/\n--/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-harness-"));
  const home = mkdtempSync(join(tmpdir(), "widecode-harness-home-"));
  writeFileSync(join(home, "prompt.md"), "Be kind.\n");
  const dir = join(folder, ".widecode");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "prompt.md"), "Be terse.\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: { git: false, greeter: { greeting: "oi" } }, columns: { chat: "40%" }, permissions: { ask: ["Bash(git push *)"], deny: ["Bash(rm -rf *)"], allow: ["Bash"] } }));
  writeFileSync(join(dir, "plugins", "greeter.js"), greeter);
  const store = new Store(home);
  store.trust(folder);
  const args = join(folder, "args.txt");

  const logs: string[] = [];
  const w = await openWidecode({
    folder,
    before: async (w: Widecode) => {
      w.host.conversation.executable = fake;
      w.host.conversation.extraArgs.push("--fixture", join(fixtures, "ask.ndjson"), "--record-args", args);
      await w.host.session.useStore(store);
      w.js.dirs = [join(dir, "plugins")];
      w.js.extra = [new PluginSource("probe.js", probe)];
      w.host.session.userPermissions = { allow: ["Bash(npm test *)"], deny: ["Read(./.env)"] };
    },
  });
  const c = w.host.conversation;
  w.host.onLog = (text: string) => logs.push(text);
  eq("the project's columns over the user's", w.configureColumns({ chat: "30%" }), "");
  w.watchHarness();
  await w.host.session.load(w.host.folder, w.host.hooks);
  w.shell.resize(200);
  const tell = (text: string): string => {
    w.host.kernel.commands.run(text);
    return w.host.screen.message.peek();
  };
  ok("the project's config switches a plugin off and gives another its section", !w.host.kernel.has("git") && w.host.kernel.has("greeter") && tell("/greet Ana") === "oi Ana");
  eq("the chat column takes the project's width", String(w.shell.widthOf("chat")), "80");

  c.send("go", []);
  ok("a turn runs and asks, so it stays open", await until(() => c.model.openRequests().length > 0, 10000));
  const argv = argvOf(args);
  const prompt = flag(argv, "--append-system-prompt");
  ok("the CLI gets the fixed paragraph, the user's prompt and then the project's", prompt.startsWith("You are running inside widecode") && prompt.includes(".widecode/") && prompt.includes("\n\nBe kind.\n\nBe terse.") && prompt.endsWith("Be terse.") && !prompt.includes("not trusted"));
  eq("and the snapshot of the prompt off, so an edit reaches a resumed session", flag(argv, "--system-prompt-snapshot"), "off");
  eq("the permission rules go to the CLI as settings: the user's, the project's ask and deny added, its allow left out", flag(argv, "--settings"), '{"permissions":{"allow":["Bash(npm test *)"],"ask":["Bash(git push *)"],"deny":["Read(./.env)","Bash(rm -rf *)"]}}');
  const sid = c.sessionId;

  writeFileSync(join(dir, "prompt.md"), "Be terse. Prefer lists.\n");
  ok("prompt.md edited: the harness says so", await until(() => tell("/hc") === "1", 3000));
  ok("the CLI goes on with its turn", c.started && !logs.some((l) => l.includes("claude exited")));
  w.chat.pane.panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("at the turn's end the CLI stops to take the new prompt", await until(() => !c.started, 10000) && logs.some((l) => l.includes("claude stopped to pick up the harness")));
  rmSync(args, { force: true });
  c.send("again", []);
  ok("the next message starts it on the same session with the new prompt", await until(() => c.started && existsSync(args) && flag(argvOf(args), "--resume") === sid, 10000) && flag(argvOf(args), "--append-system-prompt").endsWith("Be terse. Prefer lists."));

  const exits = (): number => logs.filter((l) => l.includes("claude exited")).length;
  const exitsBefore = exits();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: { greeter: { greeting: "olá" } }, columns: { chat: "40%" }, permissions: { ask: ["Bash(git push *)"], deny: ["Bash(rm -rf *)"], allow: ["Bash"] } }));
  ok("config.json edited: the plugin switched on starts, the one whose section changed starts again, the CLI stays", await until(() => w.host.kernel.has("git") && tell("/greet Bo") === "olá Bo", 3000) && c.started && exits() === exitsBefore && tell("/hc") === "1");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: { greeter: { greeting: "olá" } }, columns: { chat: "40%" }, permissions: { ask: ["Bash(git push *)"], deny: ["Bash(rm -rf *)", "WebFetch"], allow: ["Bash"] } }));
  ok("its permissions edited: the harness changed for the agent, the CLI goes on with its turn", (await until(() => tell("/hc") === "2", 3000)) && c.started && exits() === exitsBefore);
  w.chat.pane.panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("at the turn's end the CLI stops to take the new rules", await until(() => !c.started, 10000));
  rmSync(args, { force: true });
  c.send("third", []);
  ok("the next message starts it on the same session with them", await until(() => c.started && existsSync(args) && flag(argvOf(args), "--resume") === sid, 10000) && flag(argvOf(args), "--settings") === '{"permissions":{"allow":["Bash(npm test *)"],"ask":["Bash(git push *)"],"deny":["Read(./.env)","Bash(rm -rf *)","WebFetch"]}}');

  writeFileSync(join(home, "prompt.md"), "Be kind. Be brief.\n");
  ok("the user's prompt edited during a turn: the harness says so", await until(() => c.model.openRequests().length > 0 && tell("/hc") === "3", 10000));
  w.chat.pane.panel.key(new KeyEvent("char", "1", false, false, false), true);
  ok("at the turn's end the CLI stops to take the new user prompt", await until(() => !c.started, 10000) && logs.some((l) => l.includes("claude stopped to pick up the harness")));

  eq("the project's sections over the user's, per id", JSON.stringify(mergePlugins({ a: { x: 1 }, b: false, d: true }, { b: { y: 2 }, c: true })), '{"a":{"x":1},"b":{"y":2},"d":true,"c":true}');
  eq("one side alone is the other", JSON.stringify([mergePlugins(null, { a: 1 }), mergePlugins({ a: 1 }, null), mergePlugins(null, null)]), "[{\"a\":1},{\"a\":1},null]");

  // The harness plugin's tools, called as Claude Code calls them (with its token), over a painted screen.
  const root = new TRoot();
  w.shell.resize(200);
  mount(w.shell, root);
  const painted = (): Screen => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, 200, 24, DEFAULT_STYLE);
    }
    const s = new Screen(200, 24);
    paint(root, s, new Clip(0, 0, 200, 24), DEFAULT_STYLE, new Caret(), null);
    return s;
  };
  w.host.screen.onScreen = (columns: string[]) => w.screenText(painted(), columns);
  const mcp = w.js.mcp;
  ok("the server listens, asked for by the Claude plugin", await until(() => mcp.url.length > 0, 3000));
  const token = mcp.tokenFor("claude");
  let rpc = 10;
  const callTool = async (name: string, params: string): Promise<{ text: string; error: boolean }> => {
    const answer = await post(mcp.url, token, '{"jsonrpc":"2.0","id":' + String(++rpc) + ',"method":"tools/call","params":{"name":"' + name + '","arguments":' + params + "}}");
    const data = answer.split("\n").find((l) => l.startsWith("data: "));
    if (data === undefined) return { text: answer, error: true };
    const v = JSON.parse(data.slice(6)) as { result?: { content: { text: string }[]; isError: boolean }; error?: { message: string } };
    return v.result !== undefined ? { text: v.result.content.map((c) => c.text).join(""), error: v.result.isError } : { text: v.error?.message ?? answer, error: true };
  };
  const listed = await post(mcp.url, token, '{"jsonrpc":"2.0","id":9,"method":"tools/list"}');
  ok("the harness plugin's seven tools reach Claude", ["screen", "state", "log", "reload", "api", "check", "config"].every((t) => listed.includes('"name":"' + t + '"')));
  const screen = await callTool("screen", "{}");
  ok("screen: the screen as drawn without the chat, the Files tab among it, the messages not", !screen.error && screen.text.includes("Files") && !screen.text.includes("third"));
  const chatOnly = await callTool("screen", '{"columns":["chat"]}');
  ok("the chat alone when named: the messages sent, the tabs not", !chatOnly.error && chatOnly.text.includes("third") && !chatOnly.text.includes("Files"));
  const state = JSON.parse((await callTool("state", "{}")).text) as { active: { column: string }; plugins: { id: string; state: string; file: string }[]; harness: { trusted: boolean; plugins: string[] }; tools: string[]; columns: { id: string }[] };
  ok("state: the active column, the plugins with their states and files, the harness folder, the tools", state.active.column.length > 0 && state.plugins.some((p) => p.id === "harness" && p.state === "running") && state.plugins.some((p) => p.id === "greeter" && p.state === "running" && p.file.endsWith("greeter.js")) && state.harness.trusted && state.harness.plugins.length === 1 && state.tools.includes("screen") && state.columns.some((c) => c.id === "chat"));
  const log = await callTool("log", '{"n":0}');
  ok("log: the status bar's messages and the notes", log.text.includes("the project's permissions.allow is not used") && log.text.includes("olá Bo") && log.text.includes("claude stopped to pick up the harness"));
  const good = JSON.parse((await callTool("check", JSON.stringify({ code: 'widecode.plugin({ id: "zed", requires: ["nope"], activate(api) { globalThis.z = 1; } });', file: ".widecode/plugins/zed.js" }))).text) as { ok: boolean; plugins: { id: string; requires: string[] }[]; errors: string[]; warnings: string[] };
  eq("check: a source that loads, its plugin, a requirement nobody provides and a globalThis write as warnings", [good.ok, good.plugins.map((p) => p.id + ":" + p.requires.join("+")).join(","), good.errors.length, good.warnings.join(" | ")].join(" / "), "true / zed:nope / 0 / zed requires nope, which no plugin provides | a write to globalThis reaches every plugin and outlives a reload of the file");
  const broken = JSON.parse((await callTool("check", JSON.stringify({ code: "widecode.plugin({ id: " }))).text) as { ok: boolean; errors: string[] };
  ok("a syntax error", !broken.ok && broken.errors.length === 1 && broken.errors[0].includes("SyntaxError"));
  const bare = JSON.parse((await callTool("check", JSON.stringify({ code: 'widecode.plugin({ id: "x" });' }))).text) as { ok: boolean; plugins: { id: string }[]; errors: string[] };
  ok("a plugin without activate loads, registering nothing", bare.ok && bare.errors.length === 0 && bare.plugins[0].id === "x");
  const noId = JSON.parse((await callTool("check", JSON.stringify({ code: 'widecode.plugin({ activate(api) {} });' }))).text) as { ok: boolean; errors: string[] };
  ok("a plugin without an id is refused", !noId.ok && noId.errors[0].includes("a plugin needs an id"));
  const none = JSON.parse((await callTool("check", JSON.stringify({ code: "const x = 1;" }))).text) as { ok: boolean; errors: string[] };
  ok("a file registering nothing", !none.ok && none.errors[0].includes("registers no plugin"));
  const replacing = JSON.parse((await callTool("check", JSON.stringify({ code: 'widecode.plugin({ id: "greeter", activate(api) {} });', file: ".widecode/plugins/other.js" }))).text) as { warnings: string[] };
  ok("a running plugin of another file it would replace", replacing.warnings.some((t) => t.startsWith("greeter would replace the running plugin greeter")));
  writeFileSync(join(dir, "plugins", "zed.js"), 'widecode.plugin({ id: "zed", activate(api) { api.commands.add({ name: "/zed", run: () => api.tell("zed!") }); } });');
  const reloaded = JSON.parse((await callTool("reload", '{"file":".widecode/plugins/zed.js"}')).text) as { plugins: { id: string; state: string }[]; errors: string[] };
  ok("reload: the file evaluated, its plugin running, its command there", reloaded.plugins.length === 1 && reloaded.plugins[0].id === "zed" && reloaded.plugins[0].state === "running" && reloaded.errors.length === 0 && tell("/zed") === "zed!");
  ok("a file outside the plugin folders is refused", (await callTool("reload", '{"file":"prompt.md"}')).error);
  const toolsPart = await callTool("api", '{"part":"tools"}');
  ok("api: one namespace of the types", toolsPart.text.startsWith("    tools: {") && toolsPart.text.includes("add(tool: Tool): void;"));
  ok("an interface", (await callTool("api", '{"part":"Tool"}')).text.includes("interface Tool {"));
  const guide = (await callTool("api", '{"part":"guide"}')).text;
  ok("the guide: its opening and its sections", guide.startsWith("# widecode's plugins") && guide.includes("The harness, ") && !guide.includes("[widecode cut this result:"));
  ok("a section of the guide", (await callTool("api", '{"part":"The harness"}')).text.startsWith("## The harness"));
  ok("the types by part", (await callTool("api", '{"part":"types"}')).text.includes("interfaces: "));
  const found = (await callTool("api", '{"find":"harnessChanged"}')).text;
  ok("looked up in both", found.split("\n").some((l) => l.startsWith("PLUGINS.md:")) && found.includes("widecode.d.ts:"));
  const index = (await callTool("api", "{}")).text;
  ok("the index: the namespaces and the interfaces", index.includes("tools") && index.includes("Tool") && index.includes("guide"));
  ok("a part it has not", (await callTool("api", '{"part":"nope"}')).error);
  const config = JSON.parse((await callTool("config", "{}")).text) as { present: boolean; project: { plugins: { greeter: { greeting: string } } }; user: { columns: { chat: string } }; effective: { plugins: { greeter: { greeting: string } }; columns: { chat: string }; permissions: { deny: string[] }; notice: string } };
  eq("config: the project's, the user's and the result of one over the other, the permissions as the agent gets them", [config.present, config.project.plugins.greeter.greeting, config.user.columns.chat, config.effective.plugins.greeter.greeting, config.effective.columns.chat, config.effective.permissions.deny.join("+"), config.effective.notice].join(" "), "true olá 30% olá 40% Read(./.env)+Bash(rm -rf *)+WebFetch the project's permissions.allow is not used: a project adds ask and deny rules only");

  // The same folder without trust: nothing of the harness is in use, and the agent is told.
  const other = new Store(mkdtempSync(join(tmpdir(), "widecode-harness-home2-")));
  writeFileSync(join(other.root, "prompt.md"), "Be kind.\n");
  const args2 = join(folder, "args2.txt");
  const w2: Widecode = await openWidecode({
    folder,
    load: true,
    before: async (w2: Widecode) => {
      w2.host.conversation.executable = fake;
      w2.host.conversation.extraArgs.push("--fixture", join(fixtures, "turn.ndjson"), "--record-args", args2);
      await w2.host.session.useStore(other);
    },
  });
  const c2 = w2.host.conversation;
  ok("untrusted: the project's plugins and config stay out", !w2.host.kernel.has("greeter") && w2.host.kernel.has("git") && w2.host.harness.hasFolder() && !w2.host.harness.trusted);
  eq("and the folder's harness is summed up for the notice", JSON.stringify(w2.host.harness.summary()), '{"plugins":2,"prompt":true,"config":true}');
  c2.send("go", []);
  ok("a turn ran", await until(() => !c2.model.running && c2.model.turns.length === 1, 10000));
  const prompt2 = flag(argvOf(args2), "--append-system-prompt");
  ok("the agent gets the fixed paragraph and the user's prompt alone, the folder's out and the folder said not trusted", prompt2.startsWith("You are running inside widecode") && prompt2.includes("not trusted yet") && prompt2.includes("Be kind.") && !prompt2.includes("Be terse.") && prompt2.endsWith("Be kind."));
  const chatOf = (x: Widecode): string => {
    const s = x.chat.pane.source;
    s.prepare(160);
    const out: string[] = [];
    for (let i = 0; i < s.count(); i++) out.push(s.line(i, 160).runs.map((r: Run) => r.text).join(""));
    return out.join("\n").replace(/\s+/g, " ");
  };
  w2.host.kernel.commands.run("/harness");
  ok("/harness untrusted: the chat says so, the plugin files not loaded, the config not in use", chatOf(w2).includes("not trusted (/trust runs it)") && chatOf(w2).includes("greeter.js (not loaded)") && chatOf(w2).includes("zed.js (not loaded)") && chatOf(w2).includes("config.json: present, not in use"));

  // Without a store (--ephemeral): no user-wide prompt, the folder's alone.
  const w4: Widecode = await openWidecode({
    folder,
    load: true,
    before: async (w4: Widecode) => {
      await w4.host.session.useStore(null);
    },
  });
  ok("no store: no user prompt, only the trusted folder's", w4.host.harness.userPromptPath === "" && !w4.host.harness.systemPrompt([]).includes("Be kind.") && w4.host.harness.systemPrompt([]).endsWith("Be terse. Prefer lists."));

  // /harness and /harness init on a folder of its own, trusted from the start.
  const folder3 = mkdtempSync(join(tmpdir(), "widecode-harness-init-"));
  store.trust(folder3);
  const w3: Widecode = await openWidecode({
    folder: folder3,
    load: true,
    before: async (w3: Widecode) => {
      w3.host.conversation.executable = fake;
      w3.host.conversation.extraArgs.push("--fixture", join(fixtures, "turn.ndjson"));
      await w3.host.session.useStore(store);
      w3.js.dirs = [join(folder3, ".widecode", "plugins")];
    },
  });
  const run3 = (text: string): string => {
    w3.host.kernel.commands.run(text);
    return w3.host.screen.message.peek();
  };
  run3("/harness");
  ok("/harness on a folder without one: says so and how to start", chatOf(w3).includes("This folder has no harness") && chatOf(w3).includes("/harness init"));
  const skeleton = [".widecode/prompt.md", ".widecode/plugins/example.js", ".widecode/config.json", ".claude/skills/widecode/SKILL.md"];
  const told = run3("/harness init");
  ok("/harness init writes the four files, names them in the chat, and the example plugin loads at once", skeleton.every((f) => existsSync(join(folder3, f))) && chatOf(w3).includes("Harness written: .widecode/prompt.md, .widecode/plugins/example.js, .widecode/config.json, .claude/skills/widecode/SKILL.md. The example plugin runs") && told === "reloaded example.js: example");
  const skill = readFileSync(join(folder3, ".claude", "skills", "widecode", "SKILL.md"), "utf8");
  ok("the skill: its frontmatter, the loop, the tools", skill.startsWith("---\nname: widecode\ndescription: Extend widecode") && skill.split("\n---\n").length === 2 && skill.includes("mcp__widecode__api") && skill.includes("mcp__widecode__check"));
  eq("the config skeleton parses", JSON.stringify(JSON.parse(readFileSync(join(folder3, ".widecode", "config.json"), "utf8"))), '{"plugins":{},"columns":{},"permissions":{"allow":[],"ask":[],"deny":[]}}');
  ok("the example plugin loads: its tab and its command", (await until(() => w3.host.kernel.has("example"), 3000)) && w3.host.screen.panelsIn("side").some((p) => p.id === "example") && run3("/example hi") === "example: hi");
  eq("run again: nothing written", run3("/harness init"), "the harness is already there: nothing written (/harness shows it)");
  run3("/harness");
  const report3 = chatOf(w3);
  ok("/harness: trusted, the plugin file and its state, the prompt, the config, the tools", report3.includes("trusted. Plugins: .widecode/plugins/example.js (example running)") && report3.includes("prompt.md: ") && report3.includes("config.json: plugins, columns") && report3.includes("Tools: screen, state, log, reload, api, check, config"));
  closeWidecode(w3);
  rmSync(folder3, { recursive: true, force: true });

  c.kill();
  closeWidecode(w2);
  w.host.harness.stopWatching();
  w.js.stopWatching();
  w4.host.harness.stopWatching();
  w4.host.kernel.stop();
  w4.js.killProcesses();
  w4.host.workspace.close();
  w.host.workspace.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
