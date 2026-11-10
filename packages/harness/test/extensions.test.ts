// ffi: @light/plugins/native/ffi.json
// The plugins' agent halves over AcpAgent and the fake model: a registered tool the model calls (its
// details kept in the session file), a command answered without a turn, tool_call blocking Bash and
// changing a Read's path, tool_result rewriting content, before_agent_start appending to the system
// prompt, context dropping a message, a handler that throws (the turn goes on), one in a busy loop
// (switched off, the turn goes on), a trusted folder's plugin loaded and an untrusted one's not, a
// built-in replaced by a store plugin of the same id, a plugin switched off by config.json, the
// plugin's settings, a plugin's top-level widecode.util and widecode.theme, and a session with no
// agent parts making no engine.
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
import { PluginSource } from "@light/plugins/sources.ts";
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
  server: AcpServer;
  private readonly encoder = new TextEncoder();
  private n = 0;

  constructor(fixture: string, builtins: PluginSource[] = []) {
    this.folder = mkdtempSync(join(tmpdir(), "harness-ext-"));
    this.home = join(this.folder, "home");
    this.paths = new HarnessPaths(this.home);
    openLog(join(this.folder, "log.txt"));
    const server = new AcpServer();
    this.server = server;
    server.sink = (line: string) => this.out.push(line);
    const config = new HarnessConfig();
    const registry = registryFor(config, true);
    this.client = FakeClient.fromText(fixture);
    this.agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(this.folder, "auth.json")), "node", this.client), new ToolSet(builtInTools()), registry, config, "test", "linux", this.paths, builtins);
  }

  extension(code: string, project = false): void {
    const dir = project ? join(this.folder, ".widecode", "plugins") : join(this.home, "plugins");
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

  /** initialize, saying whether the client takes `_widecode/ui`. */
  initialize(ui: boolean): void {
    const params: Record<string, unknown> = ui ? { clientCapabilities: { _meta: { widecode: { ui: true } } } } : { clientCapabilities: {} };
    this.send("initialize", params);
  }

  session(params: Record<string, unknown>): string {
    const id = this.send("session/new", params);
    const line = this.out.find((l) => l.includes('"id":' + id + ",") && l.includes("sessionId"));
    return /"sessionId":"([^"]+)"/.exec(line ?? "")?.[1] ?? "";
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const id = this.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    await until(() => this.out.some((line) => line.includes('"id":' + id + ",")));
    return id;
  }

  /** A `_widecode/ui` request, taken out of the output; `method` the dialog's, when given. */
  async uiRequest(method?: string): Promise<{ id: number; params: Record<string, unknown> }> {
    let got: { id: number; params: Record<string, unknown> } | null = null;
    await until(() => {
      for (let i = 0; i < this.out.length; i++) {
        const line = this.out[i];
        if (!/"id":\d+,"method":"_widecode\/ui"/.test(line)) continue;
        const msg = JSON.parse(line) as { id: number; params: Record<string, unknown> };
        if (method !== undefined && msg.params["method"] !== method) continue;
        this.out.splice(i, 1);
        got = { id: msg.id, params: msg.params };
        return true;
      }
      return false;
    });
    return got as unknown as { id: number; params: Record<string, unknown> };
  }

  /** A `_widecode/ui` notification with `method`, taken out of the output. */
  async uiNotification(method: string): Promise<Record<string, unknown>> {
    let got: Record<string, unknown> | null = null;
    await until(() => {
      for (let i = 0; i < this.out.length; i++) {
        const line = this.out[i];
        if (!/"method":"_widecode\/ui"/.test(line) || /"id":\d+/.test(line)) continue;
        const msg = JSON.parse(line) as { params: Record<string, unknown> };
        if (msg.params["method"] !== method) continue;
        this.out.splice(i, 1);
        got = msg.params;
        return true;
      }
      return false;
    });
    return got as unknown as Record<string, unknown>;
  }

  /** Every `_widecode/ui` notification with `method` now in the output. */
  uiNotifications(method: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < this.out.length; i++) {
      const line = this.out[i];
      if (!/"method":"_widecode\/ui"/.test(line) || /"id":\d+/.test(line)) continue;
      const msg = JSON.parse(line) as { params: Record<string, unknown> };
      if (msg.params["method"] !== method) continue;
      out.push(msg.params);
      this.out.splice(i, 1);
      i--;
    }
    return out;
  }

  /** The client's answer to request `id`. */
  respond(id: number, result: unknown): void {
    const line = JSON.stringify({ jsonrpc: "2.0", id, result });
    this.server.feed(this.encoder.encode(line + "\n"));
  }

  /** The client's refusal of request `id`. */
  refuse(id: number, message: string): void {
    const line = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message } });
    this.server.feed(this.encoder.encode(line + "\n"));
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
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerTool({ name: "echo", label: "Echo", description: "Echo the text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async (id, params) => ({ content: [{ type: "text", text: "echo: " + params.text }], details: { seen: params.text } }) });',
      '  agent.registerCommand("hello", { description: "Say hello", handler: (args) => {} });',
      "} });",
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
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt + "\\nEXTRA" }));',
      '  agent.on("tool_call", (e) => {',
      '    if (e.toolName === "Bash" && String(e.input.command).indexOf("rm -rf") >= 0) return { block: true, reason: "not here" };',
      '    if (e.toolName === "Read") e.input.file_path = "b.txt";',
      "  });",
      '  agent.on("tool_result", (e) => { if (e.toolName === "Bash") return { content: [{ type: "text", text: "rewritten" }] }; });',
      '  agent.on("context", (e) => ({ messages: e.messages.filter((m) => JSON.stringify(m.content).indexOf("drop me") < 0) }));',
      "} });",
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
    rig.extension(['widecode.plugin({ id: "ext", agent(agent) {', '  agent.on("tool_call", () => { throw new Error("nope"); });', "} });"].join("\n"));
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
    rig.extension(['widecode.plugin({ id: "ext", agent(agent) {', '  agent.on("before_agent_start", () => { while (true) {} });', "} });"].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "hello");
    eq("the turn goes on without the handler", text(rig.taken()), "Hello there.");
    ok("the log says it was switched off for its time budget", readFileSync(logFile, "utf8").includes("switched off") && readFileSync(logFile, "utf8").includes("time budget"));
    rig.close();
  }

  // A trusted folder's extension loads; the same folder untrusted keeps it out.
  {
    const code = ['widecode.plugin({ id: "ext", agent(agent) {', '  agent.on("tool_call", (e) => { if (e.toolName === "Bash") return { block: true, reason: "trusted only" }; });', "} });"].join("\n");
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

  // A tool_call handler that waits in its promise still decides before the call runs.
  {
    const rig = new Rig(['{"match":"sleepblock","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}', '{"match":"result","text":"Blocked after sleep."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("tool_call", async () => { await agent.exec("sleep", ["0.03"]); return { block: true, reason: "slept first" }; });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "sleepblock");
    const turn = rig.taken();
    ok("a waiting tool_call handler still blocks the call", toolText(turn).includes("blocked by") && toolText(turn).includes("slept first"));
    eq("the turn goes on after the block", text(turn), "Running.Blocked after sleep.");
    rig.close();
  }

  // A tool's execute awaits the host and its answer reaches the model.
  {
    const rig = new Rig(['{"match":"slowtool","text":"Calling.","tools":[{"name":"slow","input":{}}]}', '{"match":"result","text":"Slow done."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerTool({ name: "slow", label: "Slow", description: "Answer later", parameters: { type: "object" }, execute: async () => { await agent.exec("sleep", ["0.03"]); return { content: [{ type: "text", text: "after sleep" }] }; } });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "slowtool");
    const turn = rig.taken();
    eq("the tool's answer after its sleep is the result", toolText(turn), "after sleep");
    const asks = rig.asks();
    ok("and the next request carries it", asks[asks.length - 1].messages.some((m) => m.parts.some((p) => p.kind === "tool_result" && p.text === "after sleep")));
    rig.close();
  }

  // A tool's execute has the session's UI: its dialog goes to the client.
  {
    const rig = new Rig(['{"match":"asktool","text":"Asking.","tools":[{"name":"pick","input":{}}]}', '{"match":"result","text":"Picked."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerTool({ name: "pick", label: "Pick", description: "Ask the user", parameters: { type: "object" }, execute: async (id, params, signal, onUpdate, ctx) => ({ content: [{ type: "text", text: String(ctx.hasUI) + ":" + String(await ctx.ui.select("Which?", ["a", "b"])) }] }) });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const prompted = rig.prompt(sid, "asktool");
    const asked = await rig.uiRequest("select");
    ok("the tool's select names its session", asked.params["sessionId"] === sid);
    rig.respond(asked.id, { value: "b" });
    await prompted;
    eq("and the tool gets the answer", toolText(rig.taken()), "true:b");
    rig.close();
  }

  // A command handler awaiting the host answers the prompt afterwards.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("slowcmd", { description: "Answer later", handler: async (args, ctx) => { await agent.exec("sleep", ["0.03"]); ctx.ui.notify("command slept"); } });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const before = rig.asks().length;
    await rig.prompt(sid, "/slowcmd now");
    const command = rig.taken();
    ok("the command is answered after its wait, without a turn", command.some((line) => line.includes('"stopReason":"end_turn"')) && rig.asks().length === before);
    ok("its continuation ran", readFileSync(logFile, "utf8").includes("command slept"));
    rig.close();
  }

  // Two sessions of one folder with handlers waiting at once both answer.
  {
    const rig = new Rig(['{"match":"first","text":"First answer."}', '{"match":"second","text":"Second answer."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", async () => { await agent.exec("sleep", ["0.04"]); });',
      "} });",
    ].join("\n"));
    const one = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const two = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await Promise.all([rig.prompt(one, "first"), rig.prompt(two, "second")]);
    const both = rig.taken();
    ok("both waiting sessions are answered", text(both).includes("First answer.") && text(both).includes("Second answer."));
    rig.close();
  }

  // A continuation that runs past the budget is switched off and the turn goes on.
  {
    const rig = new Rig(['{"match":"budget","text":"Went on."}'].join("\n"));
    const logFile = rig.logFile();
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", async () => { await agent.exec("sleep", ["0.02"]); while (true) {} });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    await rig.prompt(sid, "budget");
    eq("the turn goes on after the continuation was cut", text(rig.taken()), "Went on.");
    ok("the log says it was switched off for its time budget", readFileSync(logFile, "utf8").includes("switched off") && readFileSync(logFile, "utf8").includes("time budget"));
    rig.close();
  }

  // A confirm over _widecode/ui: false blocks the call, true lets it run.
  {
    const rig = new Rig([
      '{"match":"askno","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}',
      '{"match":"result","text":"No done."}',
      '{"match":"askyes","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hi"}}]}',
      '{"match":"result","text":"Yes done."}',
    ].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("tool_call", async (e, ctx) => {',
      '    if (e.toolName !== "Bash") return;',
      '    const yes = await ctx.ui.confirm("Run it?", "really run it");',
      '    return yes ? undefined : { block: true, reason: "said no" };',
      "  });",
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const no = rig.prompt(sid, "askno");
    const asked = await rig.uiRequest("confirm");
    eq("the dialog carries the session, title and message", String(asked.params["sessionId"]) + "|" + String(asked.params["title"]) + "|" + String(asked.params["message"]), sid + "|Run it?|really run it");
    rig.respond(asked.id, { confirmed: false });
    await no;
    const blocked = rig.taken();
    ok("a false answer blocks the call", toolText(blocked).includes("blocked by") && toolText(blocked).includes("said no"));
    const yes = rig.prompt(sid, "askyes");
    const again = await rig.uiRequest("confirm");
    rig.respond(again.id, { confirmed: true });
    await yes;
    ok("a true answer lets the call run", toolText(rig.taken()).includes("hi"));
    rig.close();
  }

  // Select, a cancelled input and a timeout.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("askselect", { handler: async (a, ctx) => { const v = await ctx.ui.select("Pick", ["a", "b"]); ctx.ui.notify("sel:" + String(v)); } });',
      '  agent.registerCommand("askinput", { handler: async (a, ctx) => { const v = await ctx.ui.input("Name"); ctx.ui.notify("in:" + String(v)); } });',
      '  agent.registerCommand("asktimeout", { handler: async (a, ctx) => { const v = await ctx.ui.confirm("Wait", "nobody", { timeout: 50 }); ctx.ui.notify("to:" + String(v)); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const sel = rig.prompt(sid, "/askselect");
    const req = await rig.uiRequest("select");
    eq("a select sends its options", JSON.stringify(req.params["options"]), '["a","b"]');
    rig.respond(req.id, { value: "b" });
    await sel;
    eq("the value reaches the extension and its prompt is answered", String((await rig.uiNotification("notify"))["message"]), "sel:b");
    const inp = rig.prompt(sid, "/askinput");
    const iq = await rig.uiRequest("input");
    rig.respond(iq.id, { cancelled: true });
    await inp;
    eq("a cancelled input is undefined", String((await rig.uiNotification("notify"))["message"]), "in:undefined");
    const to = rig.prompt(sid, "/asktimeout");
    const tq = await rig.uiRequest("confirm");
    eq("the timeout goes out with the dialog", String(tq.params["timeout"]), "50");
    await to;
    eq("the timeout resolves the default", String((await rig.uiNotification("notify"))["message"]), "to:false");
    rig.close();
  }

  // The turn's cancel resolves an open dialog to its default.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("wait", { handler: async (a, ctx) => { const v = await ctx.ui.select("Pick", ["a"]); ctx.ui.notify("after:" + String(v)); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const p = rig.prompt(sid, "/wait");
    await rig.uiRequest("select");
    rig.send("session/cancel", { sessionId: sid });
    await p;
    eq("the cancel resolves the dialog to its default", String((await rig.uiNotification("notify"))["message"]), "after:undefined");
    rig.close();
  }

  // Two dialogs open at once, answered out of order.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("ask", { handler: async (a, ctx) => { const v = await ctx.ui.select("Pick", ["x", "y"]); ctx.ui.notify("picked:" + String(v)); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const one = rig.session({ cwd: rig.folder, mcpServers: [] });
    const two = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const p1 = rig.prompt(one, "/ask");
    const p2 = rig.prompt(two, "/ask");
    const r1 = await rig.uiRequest("select");
    const r2 = await rig.uiRequest("select");
    eq("each request names its session", String(r1.params["sessionId"]) + "," + String(r2.params["sessionId"]), one + "," + two);
    rig.respond(r2.id, { value: "Y" });
    rig.respond(r1.id, { value: "X" });
    await Promise.all([p1, p2]);
    const messages = [String((await rig.uiNotification("notify"))["message"]), String((await rig.uiNotification("notify"))["message"])].sort().join(",");
    eq("each session gets the answer sent for it", messages, "picked:X,picked:Y");
    rig.close();
  }

  // Every ui notification carries the session, and statuses can be cleared.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("uiall", { handler: (a, ctx) => {',
      '    ctx.ui.notify("hello", "warning");',
      '    ctx.ui.setStatus("k", "busy");',
      '    ctx.ui.setStatus("k", undefined);',
      '    ctx.ui.setWidget("w", ["one", "two"], { placement: "belowEditor" });',
      '    ctx.ui.setTitle("T");',
      '    ctx.ui.setEditorText("typed");',
      '    ctx.ui.pasteToEditor("pasted");',
      '    ctx.ui.notify("ed:" + ctx.ui.getEditorText());',
      "  } });",
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "/uiall");
    const notes = rig.uiNotifications("notify");
    ok("notify carries the session, message and type", notes.some((p) => p["sessionId"] === sid && p["message"] === "hello" && p["notifyType"] === "warning"));
    const statuses = rig.uiNotifications("setStatus");
    ok("setStatus sets and clears", statuses.length === 2 && statuses[0]["sessionId"] === sid && statuses[0]["statusText"] === "busy" && statuses[1]["statusText"] === undefined);
    const widgets = rig.uiNotifications("setWidget");
    ok("setWidget sends its lines and placement", widgets.length === 1 && JSON.stringify(widgets[0]["widgetLines"]) === '["one","two"]' && widgets[0]["widgetPlacement"] === "belowEditor" && widgets[0]["sessionId"] === sid);
    const titles = rig.uiNotifications("setTitle");
    ok("setTitle carries the session and the title", titles.length === 1 && titles[0]["sessionId"] === sid && titles[0]["title"] === "T");
    const edits = rig.uiNotifications("set_editor_text");
    eq("both editor calls send set_editor_text", String(edits.length) + ":" + String(edits[0]["text"]) + "," + String(edits[1]["text"]), "2:typed,pasted");
    ok("getEditorText answers empty and each notification names the session", notes.some((p) => p["message"] === "ed:") && notes.every((p) => p["sessionId"] === sid));
    rig.close();
  }

  // Without the capability the dialogs answer pi's defaults and nothing goes out.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("askconfirm", { handler: async (a, ctx) => { const v = await ctx.ui.confirm("Sure?"); if (v === false) throw new Error("default confirm"); } });',
      "} });",
    ].join("\n"));
    rig.initialize(false);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "/askconfirm");
    const turn = rig.taken();
    ok("the confirm answered false without a request", text(turn).includes("default confirm") && !turn.some((line) => line.includes("_widecode/ui")));
    rig.close();
  }

  // Two sessions of one folder each get their own module state.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  let n = 0;',
      '  agent.registerCommand("count", { handler: (a, ctx) => { n++; ctx.ui.notify(String(n)); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const one = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const two = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(one, "/count");
    eq("the first session counts from 1", String((await rig.uiNotification("notify"))["message"]), "1");
    await rig.prompt(two, "/count");
    eq("the second session counts from 1 too", String((await rig.uiNotification("notify"))["message"]), "1");
    await rig.prompt(one, "/count");
    eq("and the first keeps its own count", String((await rig.uiNotification("notify"))["message"]), "2");
    rig.close();
  }

  // What an instance registers later is its own, though another session's instance began after it.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("reg", { handler: (a, ctx) => { agent.registerCommand("late", { handler: (b, c) => { c.ui.notify("late"); } }); ctx.ui.notify("registered"); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const one = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const two = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(one, "/reg");
    eq("the first session registers a command", String((await rig.uiNotification("notify"))["message"]), "registered");
    await rig.prompt(one, "/late");
    const late = await rig.uiNotification("notify");
    ok("and it runs in that session", late["message"] === "late" && late["sessionId"] === one && two.length > 0);
    rig.close();
  }

  // agent.exec: the streams and code, a failing command, a shell exit, a timeout, the session's folder and a cap.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("exechi", { handler: async (a, ctx) => { const r = await agent.exec("printf", ["hi"]); ctx.ui.notify("hi:" + r.stdout + ":" + String(r.code)); } });',
      '  agent.registerCommand("execfail", { handler: async (a, ctx) => { const r = await agent.exec("false", []); ctx.ui.notify("fail:" + String(r.code)); } });',
      '  agent.registerCommand("exitsh", { handler: async (a, ctx) => { const r = await agent.exec("sh", ["-c", "exit 3"]); ctx.ui.notify("sh:" + String(r.code)); } });',
      '  agent.registerCommand("exectimeout", { handler: async (a, ctx) => { const r = await agent.exec("sleep", ["5"], { timeout: 100 }); ctx.ui.notify("to:" + String(r.killed)); } });',
      '  agent.registerCommand("execpwd", { handler: async (a, ctx) => { const r = await agent.exec("pwd", []); ctx.ui.notify("pwd:" + r.stdout.trim()); } });',
      '  agent.registerCommand("exectrunc", { handler: async (a, ctx) => { const r = await agent.exec("sh", ["-c", "seq 1 20000"]); ctx.ui.notify("tr:" + String(r.truncated)); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "/exechi");
    eq("printf hi answers its stdout and code 0", String((await rig.uiNotification("notify"))["message"]), "hi:hi:0");
    await rig.prompt(sid, "/execfail");
    ok("a failing command answers its code", String((await rig.uiNotification("notify"))["message"]) === "fail:1");
    await rig.prompt(sid, "/exitsh");
    eq("sh -c exit 3 answers code 3", String((await rig.uiNotification("notify"))["message"]), "sh:3");
    const started = Date.now();
    await rig.prompt(sid, "/exectimeout");
    const elapsed = Date.now() - started;
    eq("a timeout kills the child", String((await rig.uiNotification("notify"))["message"]), "to:true");
    ok("and answers well under five seconds", elapsed < 3000);
    await rig.prompt(sid, "/execpwd");
    eq("cwd defaults to the session's folder", String((await rig.uiNotification("notify"))["message"]), "pwd:" + rig.folder);
    await rig.prompt(sid, "/exectrunc");
    eq("a long stream is cut and says so", String((await rig.uiNotification("notify"))["message"]), "tr:true");
    rig.close();
  }

  // A plugin with only activate makes no engine: the harness runs agent parts alone.
  {
    const folder = mkdtempSync(join(tmpdir(), "harness-plugin-activate-"));
    const root = join(folder, "home");
    const paths = new HarnessPaths(root);
    mkdirSync(join(root, "plugins"), { recursive: true });
    writeFileSync(join(root, "plugins", "ext.js"), 'widecode.plugin({ id: "ext", activate(api) {} });');
    const one = new ExtensionsRegistry(paths).forSession(folder, true);
    ok("a plugin with only activate makes no engine", one.engine === null);
    rmSync(folder, { recursive: true, force: true });
  }

  // A built-in source with an agent part handed to the registry, replaced by a store plugin of the same id.
  {
    const builtin = new PluginSource("builtin:gate.js", 'widecode.plugin({ id: "gate", agent(agent) { agent.registerCommand("builtin", { handler() {} }); } });');
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"), [builtin]);
    rig.extension('widecode.plugin({ id: "gate", agent(agent) { agent.registerCommand("store", { handler() {} }); } });');
    rig.session({ cwd: rig.folder, mcpServers: [] });
    const made = rig.taken();
    ok("the store plugin replaced the built-in's agent part", made.some((line) => line.includes('"name":"store"')) && !made.some((line) => line.includes('"name":"builtin"')));
    rig.close();
  }

  // plugins.<id>: false in the store's config.json, or a trusted folder's over it, switches the agent part off.
  {
    const folder = mkdtempSync(join(tmpdir(), "harness-plugin-off-"));
    const root = join(folder, "home");
    const paths = new HarnessPaths(root);
    mkdirSync(join(root, "plugins"), { recursive: true });
    writeFileSync(join(root, "plugins", "ext.js"), 'widecode.plugin({ id: "ext", agent(agent) { agent.registerCommand("off", { handler() {} }); } });');
    writeFileSync(join(root, "config.json"), '{"plugins":{"ext":false}}');
    const off = new ExtensionsRegistry(paths).forSession(folder, true);
    ok("the user's false makes no engine", off.engine === null);
    writeFileSync(join(root, "config.json"), '{"plugins":{}}');
    mkdirSync(join(folder, ".widecode"), { recursive: true });
    writeFileSync(join(folder, ".widecode", "config.json"), '{"plugins":{"ext":false}}');
    const loose = new ExtensionsRegistry(paths).forSession(folder, false);
    ok("an untrusted folder's false is not read", loose.engine !== null);
    const trusted = new ExtensionsRegistry(paths).forSession(folder, true);
    ok("a trusted folder's false switches it off", trusted.engine === null);
    rmSync(folder, { recursive: true, force: true });
  }

  // agent.settings answers the plugin's section of plugins.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("settings", { handler: (a, ctx) => { ctx.ui.notify(JSON.stringify(agent.settings())); } });',
      "} });",
    ].join("\n"));
    writeFileSync(join(rig.home, "config.json"), '{"plugins":{"ext":{"greeting":"hi","n":2}}}');
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "/settings");
    eq("agent.settings is its section", String((await rig.uiNotification("notify"))["message"]), '{"greeting":"hi","n":2}');
    rig.close();
  }

  // A plugin's top level reads widecode.util, widecode.theme and widecode.version.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      "const u = widecode.util;",
      "const T = widecode.theme;",
      'const label = u.str("ok") + ":" + String(widecode.version) + ":" + String(T.dim.length > 0);',
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("theme", { handler: (a, ctx) => { ctx.ui.notify(label); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "/theme");
    eq("widecode.util and widecode.theme exist at a plugin's top level", String((await rig.uiNotification("notify"))["message"]), "ok:1:true");
    rig.close();
  }

  // No file, no engine; the same pair stays one.
  {
    const folder = mkdtempSync(join(tmpdir(), "harness-ext-empty-"));
    const registry = new ExtensionsRegistry(new HarnessPaths(join(folder, "home")));
    const one = registry.forSession(folder, true);
    const two = registry.forSession(folder, true);
    ok("no extension file makes no engine, and the pair stays one", one.engine === null && one === two);
    rmSync(folder, { recursive: true, force: true });
  }

  // agent.appendEntry: a custom entry in the file, outside the context, still there after a load elsewhere.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("save", { handler: (a, ctx) => { agent.appendEntry("note", { count: 3, marker: "custom-marker" }); ctx.ui.notify("saved"); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "hello");
    rig.taken();
    await rig.prompt(sid, "/save");
    await rig.uiNotification("notify");
    const store = new SessionStore(rig.paths!.sessionsDir(rig.folder));
    const file = store.pathOf(sid);
    const kept = readFileSync(file, "utf8");
    ok("appendEntry writes a custom entry with its data", kept.includes('"kind":"custom"') && kept.includes('"customType":"note"') && kept.includes('"data":{"count":3,"marker":"custom-marker"}'));
    ok("and the model never got it", rig.asks().every((r) => r.messages.every((m) => !m.text().includes("custom-marker"))));
    const out2: string[] = [];
    const server2 = new AcpServer();
    server2.sink = (line: string) => out2.push(line);
    const config = new HarnessConfig();
    const registry = registryFor(config, true);
    const agent2 = new AcpAgent(server2, new ModelClient(registry, new Auth(join(rig.folder, "auth.json")), "node", FakeClient.fromText('{"match":"hello","text":"Again."}')), new ToolSet(builtInTools()), registry, config, "test", "linux", rig.paths!);
    agent2.receive(new Incoming("session/load", { sessionId: sid, cwd: rig.folder, mcpServers: [] }, "1"));
    await until(() => out2.some((line) => line.includes('"id":1,')));
    ok("a load in a fresh agent keeps the custom entry", readFileSync(file, "utf8").includes('"customType":"note"') && readFileSync(file, "utf8").includes("custom-marker"));
    rig.close();
  }

  // ctx.sessionManager: the session's ids, header and every entry on the branch, in pi's shapes.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("save", { handler: () => { agent.appendEntry("note", { count: 3 }); } });',
      '  agent.registerCommand("inspect", { handler: (a, ctx) => {',
      "    const sm = ctx.sessionManager;",
      '    const entries = sm.getEntries();',
      '    const custom = entries.filter((e) => e.type === "custom")[0];',
      '    ctx.ui.notify("inspect:" + JSON.stringify({ id: sm.getSessionId(), file: sm.getSessionFile(), cwd: sm.getCwd(), leaf: sm.getLeafId(), header: sm.getHeader(), entries: entries.length, branch: sm.getBranch().map((e) => e.type), custom: custom === undefined ? null : sm.getEntry(custom.id) }));',
      "  } });",
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "hello");
    const store = new SessionStore(rig.paths!.sessionsDir(rig.folder));
    await until(() => readFileSync(store.pathOf(sid), "utf8").includes('"kind":"title"'));
    await rig.prompt(sid, "/save");
    await rig.prompt(sid, "/inspect");
    const params = await rig.uiNotification("notify");
    const got = JSON.parse(String(params["message"]).slice("inspect:".length)) as Record<string, unknown>;
    ok("the manager names the session, its file, folder and leaf", got["id"] === sid && String(got["file"]).endsWith(sid + ".jsonl") && got["cwd"] === rig.folder && String(got["leaf"]).length > 0);
    eq("the header is pi's session header", String((got["header"] as Record<string, unknown>)["type"]) + ":" + String((got["header"] as Record<string, unknown>)["cwd"]), "session:" + rig.folder);
    eq("the branch's types in order", (got["branch"] as string[]).join(","), "model_change,message,message,session_info,custom");
    eq("every entry is there", String(got["entries"]), "5");
    const custom = got["custom"] as Record<string, unknown>;
    ok("getEntry of the custom one keeps its type and data", custom !== null && custom["type"] === "custom" && custom["customType"] === "note" && JSON.stringify(custom["data"]) === '{"count":3}');
    ok("the messages are pi message entries", (got["branch"] as string[]).length === 5);
    rig.close();
  }

  // agent.setSessionName and getSessionName: the title entry and the session_info_update.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("rename", { handler: (a, ctx) => { agent.setSessionName("Fresh name"); ctx.ui.notify("name:" + String(agent.getSessionName())); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "hello");
    await rig.prompt(sid, "/rename");
    const named = await rig.uiNotification("notify");
    const lines = rig.taken();
    ok("the session_info_update names it", lines.some((line) => line.includes('"sessionUpdate":"session_info_update","name":"Fresh name"')));
    eq("getSessionName reads it back", String(named["message"]), "name:Fresh name");
    ok("the title entry is written", readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8").includes('"kind":"title"') && rig.agent !== null && rig.agent.titleOf(sid) === "Fresh name");
    rig.close();
  }

  // agent.sendUserMessage while idle: a turn at once, the client told the user's message.
  {
    const rig = new Rig(['{"match":"hello","text":"Hello there."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("sendnow", { handler: () => { agent.sendUserMessage("hello now"); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const before = rig.asks().length;
    const prompted = rig.prompt(sid, "/sendnow");
    await until(() => rig.asks().length > before);
    await prompted;
    const asks = rig.asks();
    ok("the message is the request's user turn", asks[asks.length - 1].messages.some((m) => m.role === "user" && m.text() === "hello now"));
    ok("a user_message_chunk marks it as the user's", rig.out.some((line) => line.includes('"sessionUpdate":"user_message_chunk"') && line.includes('"text":"hello now"')));
    rig.close();
  }

  // agent.sendUserMessage steered and followed up while a turn runs.
  {
    const rig = new Rig(['{"match":"slow","text":"First answer."}', '{"match":"steer","text":"Steered answer."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", (e) => { if (e.prompt === "slow") agent.sendUserMessage("steer words", { deliverAs: "steer" }); });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "slow");
    await until(() => rig.asks().length >= 2);
    const asks = rig.asks();
    ok("a steered message is the next request's user turn", asks[1].messages.some((m) => m.role === "user" && m.text() === "steer words"));
    eq("both replies stream", text(rig.taken()), "First answer.Steered answer.");
    rig.close();
  }
  {
    const rig = new Rig(['{"match":"slow","text":"First answer."}', '{"match":"follow","text":"Followed answer."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", (e) => { if (e.prompt === "slow") agent.sendUserMessage("follow after", { deliverAs: "followUp" }); });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "slow");
    await until(() => rig.asks().length >= 2);
    const asks = rig.asks();
    ok("a follow-up starts a turn after the first", asks[1].messages.some((m) => m.role === "user" && m.text() === "follow after"));
    await until(() => text(rig.out).includes("Followed answer."));
    eq("both replies stream", text(rig.taken()), "First answer.Followed answer.");
    rig.close();
  }

  // agent.sendMessage with triggerTurn while idle, and steered into a running turn.
  {
    const rig = new Rig(['{"match":"custom","text":"Saw custom."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("sendcustom", { handler: () => { agent.sendMessage({ customType: "note", content: "custom words", display: true, details: { a: 1 } }, { triggerTurn: true }); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const before = rig.asks().length;
    const prompted = rig.prompt(sid, "/sendcustom");
    await until(() => rig.asks().length > before);
    await prompted;
    const asks = rig.asks();
    ok("the custom message is what the model reads", asks[asks.length - 1].messages.some((m) => m.role === "user" && m.text() === "custom words"));
    ok("it is written with its type and details", readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8").includes('"customType":"note"') && readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8").includes('"details":{"a":1}'));
    rig.close();
  }
  {
    const rig = new Rig(['{"match":"slow","text":"First answer."}', '{"match":"injected","text":"Injected answer."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", (e) => { if (e.prompt === "slow") agent.sendMessage({ customType: "inject", content: "injected words", display: true }, { deliverAs: "steer" }); });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "slow");
    await until(() => rig.asks().length >= 2);
    const asks = rig.asks();
    ok("a steered custom message is the next request's user turn", asks[1].messages.some((m) => m.role === "user" && m.text() === "injected words"));
    ok("it is kept with its custom type", readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8").includes('"customType":"inject"'));
    eq("both replies stream", text(rig.taken()), "First answer.Injected answer.");
    rig.close();
  }

  // agent.sendMessage nextTurn: kept and added before the next turn's prompt.
  {
    const rig = new Rig(['{"match":"slow","text":"First answer."}', '{"match":"after","text":"After answer."}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.on("before_agent_start", (e) => { if (e.prompt === "slow") agent.sendMessage({ customType: "later", content: "next words", display: true }, { deliverAs: "nextTurn" }); });',
      "} });",
    ].join("\n"));
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "slow");
    await rig.prompt(sid, "after");
    await until(() => rig.asks().length >= 2);
    const asks = rig.asks();
    const texts = asks[1].messages.map((m) => m.text());
    ok("the next turn carries the custom message before its prompt", texts.includes("next words") && texts.indexOf("next words") < texts.indexOf("after"));
    ok("it is kept with its custom type", readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8").includes('"customType":"later"'));
    rig.close();
  }

  // A command registered from another command's handler is announced again.
  {
    const rig = new Rig(['{"match":"never","text":"ok"}'].join("\n"));
    rig.extension([
      'widecode.plugin({ id: "ext", agent(agent) {',
      '  agent.registerCommand("reg", { handler: () => { agent.registerCommand("late", { handler: (b, c) => { c.ui.notify("late"); } }); } });',
      "} });",
    ].join("\n"));
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    const initial = rig.taken();
    eq("the first announcement lists only the known command", String(initial.filter((line) => line.includes("available_commands_update")).length), "1");
    await rig.prompt(sid, "/reg");
    const lines = rig.taken();
    ok("a late command is announced again", lines.some((line) => line.includes("available_commands_update") && line.includes('"name":"late"')));
    rig.close();
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
