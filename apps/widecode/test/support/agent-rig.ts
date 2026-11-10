// A rig for the agent part of a built-in plugin: an AcpAgent over the fake model, the test playing
// the ACP client. The plugin sources are the ones the app's prepare step wrote for a test run
// (src/runtime/generated/<id>.js.txt: the plugin's index.ts with its types stripped), which keeps
// these tests free of node's type stripper and runnable natively as well as under node. Settings and
// switches are the store's config.json, as the daemon reads them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLog } from "@light/lib/log.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { AcpAgent } from "@widecode/harness/acp/agent.ts";
import { AcpServer, Incoming } from "@widecode/harness/acp/server.ts";
import { Auth } from "@widecode/harness/auth.ts";
import { registryFor } from "@widecode/harness/cli.ts";
import { HarnessConfig } from "@widecode/harness/config.ts";
import { ModelClient, ModelRequest } from "@widecode/harness/model/client.ts";
import { FakeClient } from "@widecode/harness/model/fake.ts";
import { HarnessPaths } from "@widecode/harness/paths.ts";
import { ToolSet, builtInTools } from "@widecode/harness/tools/tool.ts";

/** The folder holding the generated sources, from the member's folder or the repository's root. */
const generatedDir = (): string => {
  const local = join("src", "runtime", "generated");
  if (existsSync(local)) return local;
  const root = join("apps", "widecode", "src", "runtime", "generated");
  if (existsSync(root)) return root;
  return local;
};

/** The built-in plugins' sources, as the app's prepare step wrote them. */
export const builtinSources = (ids: string[]): PluginSource[] => {
  const dir = generatedDir();
  const out: PluginSource[] = [];
  for (const id of ids) {
    const path = join(dir, id + ".js.txt");
    if (!existsSync(path)) throw new Error("agent-rig: no " + path + "; run the app's prepare step (node --no-warnings scripts/builtin-plugins.mjs)");
    const name = "builtin:" + id + ".js";
    out.push(new PluginSource(name, readFileSync(path, "utf8")));
  }
  return out;
};

/** Wait until `what` holds. */
export const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

/** The `text` of the first text part in a line, with its JSON escapes applied. */
const textIn = (line: string): string => {
  const found = /"text":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (found === null) return "";
  return JSON.parse('"' + found[1] + '"') as string;
};

/** The agent message text in a turn's lines. */
export const textOf = (lines: string[]): string =>
  lines
    .filter((line) => line.includes("agent_message_chunk"))
    .map(textIn)
    .join("");

/** The tool results in a turn's lines, one after another. */
export const toolTextOf = (lines: string[]): string =>
  lines
    .filter((line) => line.includes('"sessionUpdate":"tool_call_update"'))
    .map(textIn)
    .join("|");

export class AgentRig {
  folder = "";
  home = "";
  out: string[] = [];
  client: FakeClient | null = null;
  agent: AcpAgent | null = null;
  paths: HarnessPaths | null = null;
  server: AcpServer;
  private readonly encoder = new TextEncoder();
  private n = 0;

  constructor(fixture: string, ids: string[]) {
    this.folder = mkdtempSync(join(tmpdir(), "widecode-agent-rig-"));
    this.home = join(this.folder, "home");
    mkdirSync(this.home, { recursive: true });
    this.paths = new HarnessPaths(this.home);
    openLog(join(this.folder, "log.txt"));
    const server = new AcpServer();
    this.server = server;
    server.sink = (line: string) => this.out.push(line);
    const config = new HarnessConfig();
    const registry = registryFor(config, true);
    this.client = FakeClient.fromText(fixture);
    this.agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(this.folder, "auth.json")), "node", this.client), new ToolSet(builtInTools()), registry, config, "test", "linux", this.paths, builtinSources(ids));
  }

  /** Write the store's config.json (the plugin settings and switches) before a session is made. */
  configure(value: unknown): void {
    writeFileSync(join(this.home, "config.json"), JSON.stringify(value));
  }

  /** A fresh agent over the same store and folder, as a session loaded again in a new process. */
  reopen(ids: string[], fixture: string): void {
    if (this.agent !== null) this.agent.stop();
    const server = new AcpServer();
    this.server = server;
    server.sink = (line: string) => this.out.push(line);
    const config = new HarnessConfig();
    const registry = registryFor(config, true);
    this.client = FakeClient.fromText(fixture);
    this.agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(this.folder, "auth.json")), "node", this.client), new ToolSet(builtInTools()), registry, config, "test", "linux", this.paths!, builtinSources(ids));
  }

  /** Load session `sessionId` into this agent, as a reopened session; the test waits for the answer. */
  load(sessionId: string): string {
    return this.send("session/load", { sessionId: sessionId, cwd: this.folder, mcpServers: [] });
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

  /** The client's answer to request `id`. */
  respond(id: number, result: unknown): void {
    const line = JSON.stringify({ jsonrpc: "2.0", id, result });
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
    if (this.agent !== null) this.agent.stop();
    rmSync(this.folder, { recursive: true, force: true });
  }
}
