// ffi: @light/plugins/native/ffi.json
// A plugin file saved while the agent runs: the file's plugins are replaced and the agent's process
// goes on (its session, its turn), the tools the new version adds are served; the folder watcher
// picks the save up on its own; a plugin of its own folder is added, saved and removed, the watcher
// following its folder; /reload, the full one, restarts the agent, which resumes the
// session on the next message. Against the fake Claude Code CLI replaying one turn.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const fixtures = join(process.cwd(), "test", "fixtures");
const fake = join(process.cwd(), "test", "fake-claude.mjs");

const plugin = (version: string, tool: string): string => `widecode.plugin({ id: "hello", activate(api) {
  api.commands.add({ name: "/v", run: () => api.tell("${version}") });
  api.tools.add({ name: "${tool}", description: "echoes", input: { type: "object", properties: { text: { type: "string" } } }, call: (args) => args.text });
} });`;

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-reload-"));
  const dir = join(folder, ".widecode", "plugins");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "a.js");
  writeFileSync(file, plugin("v1", "echo1"));
  const args = join(folder, "args.txt");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  c.executable = fake;
  c.extraArgs.push("--fixture", join(fixtures, "turn.ndjson"), "--record-args", args);
  const logs: string[] = [];
  const w = composeWidecode(ws, c);
  w.js.dirs = [dir];
  w.start(null, new NoStateFile(), []);
  w.host.onLog = (text: string) => logs.push(text);
  await w.host.load();
  w.js.watchFolders();
  const names = (): string => w.js.mcp.tools.map((t) => t.name).filter((n) => n.startsWith("echo")).join(",");
  w.host.roles.chat.submit("/v");
  eq("the project's plugin, with its tool", w.host.screen.message.peek() + " " + names(), "v1 echo1");

  c.send("go", []);
  ok("a turn ran", await until(() => !c.model.running && c.model.turns.length === 1, 10000));
  const sid = c.sessionId;
  ok("the agent's process stays on after the turn", c.started && sid.length > 0);

  writeFileSync(file, plugin("v2", "echo2"));
  w.js.syncFolder(dir);
  w.host.roles.chat.submit("/v");
  eq("the file saved: its plugin replaced, its tool with it", w.host.screen.message.peek() + " " + names(), "v2 echo2");
  ok("the agent went on: the same process, its turns kept", c.started && !logs.some((l) => l.includes("claude exited")) && c.model.turns.length === 1 && c.sessionId === sid);

  writeFileSync(file, plugin("v3", "echo3"));
  ok("the folder watcher picks a save up on its own", await until(() => (w.host.roles.chat.submit("/v"), w.host.screen.message.peek() === "v3"), 3000));
  eq("and the tools follow", names(), "echo3");
  ok("the agent still went on", c.started && !logs.some((l) => l.includes("claude exited")));

  const notes = join(dir, "notes");
  const folderPlugin = (version: string): string => `widecode.plugin({ id: "notes", activate(api) { api.commands.add({ name: "/n", run: () => api.tell("${version}") }); } });`;
  mkdirSync(notes);
  writeFileSync(join(notes, "README.md"), "Notes.");
  writeFileSync(join(notes, "index.js"), folderPlugin("n1"));
  ok("a plugin folder added: its index.js loads", await until(() => (w.host.roles.chat.submit("/n"), w.host.screen.message.peek() === "n1"), 3000));
  writeFileSync(join(notes, "index.js"), folderPlugin("n2"));
  ok("a save inside the folder reloads it", await until(() => (w.host.roles.chat.submit("/n"), w.host.screen.message.peek() === "n2"), 3000));
  rmSync(notes, { recursive: true, force: true });
  ok("the folder removed takes its plugin away", await until(() => !w.host.kernel.has("notes"), 3000));

  w.js.reload();
  ok("/reload, the full one, restarts the agent and keeps the session to resume", await until(() => !c.started, 3000) && c.resumeId === sid);
  c.send("again", []);
  ok("the next message starts the agent on the same session", await until(() => c.started && readFileSync(args, "utf8").includes("--resume\n" + sid), 10000));
  ok("the plugin came back with the reload", (w.host.roles.chat.submit("/v"), w.host.screen.message.peek() === "v3"));

  c.kill();
  w.js.stopWatching();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
