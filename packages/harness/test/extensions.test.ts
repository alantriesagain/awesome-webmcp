// ffi: @light/plugins/native/ffi.json
// The extension runtime over AcpAgent and the fake model: a registered tool the model calls (its
// details kept in the session file), a command answered without a turn, tool_call blocking bash and
// changing a read's path, tool_result rewriting content, before_agent_start appending to the system
// prompt, context dropping a message, a handler that throws (the turn goes on), one in a busy loop
// (switched off, the turn goes on), a trusted folder's extension loaded and an untrusted one's not,
// and a session with no files making no engine.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLog } from "@light/lib/log.ts";
import { AcpAgent } from "../acp/agent.ts";
import { AcpServer, Incoming } from "../acp/server.ts";
import { Auth } from "../auth.ts";
import { registryFor } from "../cli.ts";
import { HarnessConfig } from "../config.ts";
import { ExtensionsRegistry } from "../ext/extensions.ts";
import { ModelClient, ModelRequest } from "../model/client.ts";
import { FakeClient } from "../model/fake.ts";
import { HarnessPaths } from "../paths.ts";
import { SessionStore } from "../session/store.ts";
import { ToolSet, builtInTools } from "../tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

class Rig {
  folder = "";
  home = "";
  out: string[] = [];
  client: FakeClient | null = null;
  agent: AcpAgent | null = null;
  paths: HarnessPaths | null = null;
  private n = 0;

  constructor(fixture: string) {
    this.folder = mkdtempSync(join(tmpdir(), "harness-ext-"));
    this.home = join(this.folder, "home");
    this.paths = new HarnessPaths(this.home);
    openLog(join(this.folder, "log.txt"));
    const server = new AcpServer();
    server.sink = (line: string) => this.out.push(line);
    const config = new HarnessConfig();
    const registry = registryFor(config, true);
    this.client = FakeClient.fromText(fixture);
    this.agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(this.folder, "auth.json")), "node", this.client), new ToolSet(builtInTools()), registry, config, "test", "linux", this.paths);
  }

  extension(code: string, project = false): void {
    const dir = project ? join(this.folder, ".widecode", "extensions") : join(this.home, "extensions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ext.js"), code);
  }

  logFile(): string {
    const file = join(this.folder, "log.txt");
    openLog(file);
    return file;
  }

  send(method: string, params: unknown): string {
    const id = String(++this.n);
    this.agent!.receive(new Incoming(method, params, id));
    return id;
  }

  session(params: Record<string, unknown>): string {
    this.send("session/new", params);
    return /"sessionId":"([^"]+)"/.exec(this.out[0] ?? "")?.[1] ?? "";
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const id = this.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    await until(() => this.out.some((line) => line.includes('"id":' + id + ",")));
    return id;
  }

  taken(): string[] {
    return this.out.splice(0, this.out.length);
  }

  /** The requests a turn made, without the naming and compaction ones. */
  asks(): ModelRequest[] {
    const all = this.client!.requests;
    return all.filter((r) => !(r.system.length > 0 && (r.system[0].startsWith("You name") || r.system[0].startsWith("You summarize"))));
  }

  close(): void {
    rmSync(this.folder, { recursive: true, force: true });
  }
}

const text = (lines: string[]): string =>
  lines
    .filter((line) => line.includes("agent_message_chunk"))
    .map((line) => /"text":"([^"]*)"/.exec(line)?.[1] ?? "")
    .join("");

const toolText = (lines: string[]): string =>
  lines
    .filter((line) => line.includes('"sessionUpdate":"tool_call_update"'))
    .map((line) => /"text":"([^"]*)"/.exec(line)?.[1] ?? "")
    .join("|");

const main = async (): Promise<void> => {
  // A registered tool and a command.
  {
    const rig = new Rig(['{"match":"calltool","text":"Calling.","tools":[{"name":"echo","input":{"text":"hi"}}]}', '{"match":"result","text":"Echoed."}'].join("\n"));
    rig.extension([
      "export default function (pi) {",
      '  pi.registerTool({ name: "echo", label: "Echo", description: "Echo the text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async (id, params) => ({ content: [{ type: "text", text: "echo: " + params.text }], details: { seen: params.text } }) });',
      '  pi.registerCommand("hello", { description: "Say hello", handler: (args) => {} });',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    const made = rig.taken();
    ok("the command is announced after the built-ins", made.some((line) => line.includes('{"name":"hello","description":"Say hello"}')));
    await rig.prompt(sid, "calltool");
    const turn = rig.taken();
    eq("the registered tool runs, its text the result", toolText(turn), "echo: hi");
    const kept = readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8");
    ok("its details are in the session file's outcome", kept.includes("detailsJson") && kept.includes('seen') && kept.includes("hi"));
    const before = rig.asks().length;
    await rig.prompt(sid, "/hello world");
    const command = rig.taken();
    ok("the command is answered without a turn", command.some((line) => line.includes('"stopReason":"end_turn"')) && rig.asks().length === before);
    rig.close();
  }

  // Hooks: system prompt, mapped names, blocking, input changes, result content and the context.
  {
    const rig = new Rig([
      '{"match":"hook","text":"Reading.","tools":[{"name":"Read","input":{"file_path":"a.txt"}}]}',
      '{"match":"result","text":"Read it."}',
      '{"match":"block","text":"Running.","tools":[{"name":"Bash","input":{"command":"rm -rf /tmp/nope"}}]}',
      '{"match":"result","text":"Blocked it."}',
      '{"match":"rewrite","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}',
      '{"match":"result","text":"Rewritten it."}',
    ].join("\n"));
    writeFileSync(join(rig.folder, "a.txt"), "first\n");
    writeFileSync(join(rig.folder, "b.txt"), "second\n");
    rig.extension([
      "export default function (pi) {",
      '  pi.on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt + "\\nEXTRA" }));',
      '  pi.on("tool_call", (e) => {',
      '    if (e.toolName === "bash" && String(e.input.command).indexOf("rm -rf") >= 0) return { block: true, reason: "not here" };',
      '    if (e.toolName === "read") e.input.path = "b.txt";',
      "  });",
      '  pi.on("tool_result", (e) => { if (e.toolName === "bash") return { content: [{ type: "text", text: "rewritten" }] }; });',
      '  pi.on("context", (e) => ({ messages: e.messages.filter((m) => JSON.stringify(m.content).indexOf("drop me") < 0) }));',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "hook it");
    const read = rig.taken();
    ok("before_agent_start's system prompt replaces the turn's", rig.asks()[0].system.join("\n").includes("EXTRA"));
    eq("tool_call's changed input runs: a's read became b's", toolText(read), "     1\\tsecond");
    await rig.prompt(sid, "block it");
    const blocked = rig.taken();
    ok("tool_call blocks bash and the call ends with the reason", toolText(blocked).includes("blocked by") && toolText(blocked).includes("not here"));
    await rig.prompt(sid, "rewrite it");
    const rewritten = rig.taken();
    eq("tool_result rewrites what the model gets", toolText(rewritten), "rewritten");
    const after = rig.asks();
    ok("and the next request carries the rewritten result", after[after.length - 1].messages.some((m) => m.parts.some((p) => p.kind === "tool_result" && p.text === "rewritten")));
    await rig.prompt(sid, "drop me please");
    await until(() => rig.asks().length > 0);
    const context = rig.asks();
    ok("context drops the message before the request", !context[context.length - 1].messages.some((m) => m.text().includes("drop me")));
    rig.close();
  }

  // A handler that throws blocks the call, the turn goes on, and the log names the file and the error.
  {
    const rig = new Rig(['{"match":"boomtool","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}', '{"match":"result","text":"Went on."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension(["export default function (pi) {", '  pi.on("tool_call", () => { throw new Error("nope"); });', "}"].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "boomtool");
    const turn = rig.taken();
    ok("the call is blocked and the turn ends", toolText(turn).includes("blocked by") && text(turn) === "Running.Went on.");
    ok("the log names the extension and its error", readFileSync(logFile, "utf8").includes("ext.js") && readFileSync(logFile, "utf8").includes("nope"));
    rig.close();
  }

  // A busy loop is stopped and the extension switched off for the daemon's life.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension(["export default function (pi) {", '  pi.on("before_agent_start", () => { while (true) {} });', "}"].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "hello");
    eq("the turn goes on without the handler", text(rig.taken()), "Hello there.");
    ok("the log says it was switched off for its time budget", readFileSync(logFile, "utf8").includes("switched off") && readFileSync(logFile, "utf8").includes("time budget"));
    rig.close();
  }

  // A trusted folder's extension loads; the same folder untrusted keeps it out.
  {
    const code = ["export default function (pi) {", '  pi.on("tool_call", (e) => { if (e.toolName === "bash") return { block: true, reason: "trusted only" }; });', "}"].join("\n");
    const rig = new Rig(['{"match":"run","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}', '{"match":"result","text":"Done."}', '{"match":"run","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}', '{"match":"result","text":"Done."}'].join("\n"));
    rig.extension(code, true);
    const untrusted = rig.session({ cwd: rig.folder, mcpServers: [], _meta: { widecode: { trusted: false } } });
    await rig.prompt(untrusted, "run it");
    const free = rig.taken();
    ok("an untrusted folder's extension is not loaded", !toolText(free).includes("trusted only") && toolText(free).includes("hi"));
    const trusted = rig.session({ cwd: rig.folder, mcpServers: [], _meta: { widecode: { trusted: true } } });
    await rig.prompt(trusted, "run it");
    ok("a trusted one is", toolText(rig.taken()).includes("trusted only"));
    rig.close();
  }

  // A tool_call handler that sleeps in its promise still decides before the call runs.
  {
    const rig = new Rig(['{"match":"sleepblock","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}', '{"match":"result","text":"Blocked after sleep."}'].join("\n"));
    rig.extension([
      "export default function (pi) {",
      '  pi.on("tool_call", async () => { await globalThis.__harnessTest.sleep(30); return { block: true, reason: "slept first" }; });',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "sleepblock");
    const turn = rig.taken();
    ok("a slept tool_call handler still blocks the call", toolText(turn).includes("blocked by") && toolText(turn).includes("slept first"));
    eq("the turn goes on after the block", text(turn), "Running.Blocked after sleep.");
    rig.close();
  }

  // A tool's execute awaits the host and its answer reaches the model.
  {
    const rig = new Rig(['{"match":"slowtool","text":"Calling.","tools":[{"name":"slow","input":{}}]}', '{"match":"result","text":"Slow done."}'].join("\n"));
    rig.extension([
      "export default function (pi) {",
      '  pi.registerTool({ name: "slow", label: "Slow", description: "Answer later", parameters: { type: "object" }, execute: async () => { await globalThis.__harnessTest.sleep(30); return { content: [{ type: "text", text: "after sleep" }] }; } });',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "slowtool");
    const turn = rig.taken();
    eq("the tool's answer after its sleep is the result", toolText(turn), "after sleep");
    const asks = rig.asks();
    ok("and the next request carries it", asks[asks.length - 1].messages.some((m) => m.parts.some((p) => p.kind === "tool_result" && p.text === "after sleep")));
    rig.close();
  }

  // A command handler awaiting the host answers the prompt afterwards.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension([
      "export default function (pi) {",
      '  pi.registerCommand("slowcmd", { description: "Answer later", handler: async (args, ctx) => { await globalThis.__harnessTest.sleep(30); ctx.ui.notify("command slept"); } });',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const before = rig.asks().length;
    await rig.prompt(sid, "/slowcmd now");
    const command = rig.taken();
    ok("the command is answered after its sleep, without a turn", command.some((line) => line.includes('"stopReason":"end_turn"')) && rig.asks().length === before);
    ok("its continuation ran", readFileSync(logFile, "utf8").includes("command slept"));
    rig.close();
  }

  // Two sessions of one folder with handlers sleeping at once both answer.
  {
    const rig = new Rig(['{"match":"first","text":"First answer."}', '{"match":"second","text":"Second answer."}'].join("\n"));
    rig.extension([
      "export default function (pi) {",
      '  pi.on("before_agent_start", async () => { await globalThis.__harnessTest.sleep(40); });',
      "}",
    ].join("\n"));
    const one = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const two = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await Promise.all([rig.prompt(one, "first"), rig.prompt(two, "second")]);
    const both = rig.taken();
    ok("both sleeping sessions are answered", text(both).includes("First answer.") && text(both).includes("Second answer."));
    rig.close();
  }

  // A continuation that runs past the budget is switched off and the turn goes on.
  {
    const rig = new Rig(['{"match":"budget","text":"Went on."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension([
      "export default function (pi) {",
      '  pi.on("before_agent_start", async () => { await globalThis.__harnessTest.sleep(20); while (true) {} });',
      "}",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "budget");
    eq("the turn goes on after the continuation was cut", text(rig.taken()), "Went on.");
    ok("the log says it was switched off for its time budget", readFileSync(logFile, "utf8").includes("switched off") && readFileSync(logFile, "utf8").includes("time budget"));
    rig.close();
  }

  // No file, no engine; the same pair shares the instance.
  {
    const folder = mkdtempSync(join(tmpdir(), "harness-ext-empty-"));
    const registry = new ExtensionsRegistry(new HarnessPaths(join(folder, "home")));
    const one = registry.forSession(folder, true);
    const two = registry.forSession(folder, true);
    ok("no extension file makes no engine, and the pair shares its instance", one.engine === null && one === two);
    rmSync(folder, { recursive: true, force: true });
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
