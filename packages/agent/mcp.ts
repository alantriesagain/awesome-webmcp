// An app's own tools, served to the agents the user runs over MCP (the Model Context Protocol,
// its streamable HTTP transport): a JSON-RPC message POSTed to 127.0.0.1, at a port the system
// picks, with the server's token. It answers initialize, ping, tools/list and tools/call; a call is
// answered when its tool answers (a plugin's, which may wait on the user), as an event stream that
// carries a progress notification every few seconds meanwhile, so the agent's client keeps waiting.
// Each agent's plugin gets a token of its own, and sees the tools not excepted for it: a tool's
// `except` names the plugins whose agents keep a tool of their own for the need. An agent that takes
// its servers from a file (Claude Code's --mcp-config) gets one written for it, readable by the
// user alone. No sessions, no stream of the server's own, no resources or prompts.
import { randomBytes } from "node:crypto";
import { isRecord } from "@light/lib/json.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The protocol versions it speaks: the client's when it is one of them, else the first. */
const VERSIONS = ["2025-06-18", "2025-11-25", "2025-03-26"];
const MAX_BODY = 1048576;

interface Rpc {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface Params {
  protocolVersion?: unknown;
  name?: unknown;
  arguments?: unknown;
  requestId?: unknown;
  _meta?: unknown;
}

interface Meta {
  progressToken?: unknown;
}

const params = (v: unknown): Params => (isRecord(v) ? (v as Params) : {});

/** One message of an event stream. */
const event = (data: string): string => "event: message\ndata: " + data + "\n\n";
const result = (id: string, value: string): string => '{"jsonrpc":"2.0","id":' + id + ',"result":' + value + "}";
const failure = (id: string, code: number, message: string): string => '{"jsonrpc":"2.0","id":' + id + ',"error":{"code":' + String(code) + ',"message":' + JSON.stringify(message) + "}}";

/** A tool offered: its name, what it does, its input's JSON schema (as text), what kind of call it is (as the views draw it: "question", "plan", ""), who answers its calls (plugin `owner`'s function `fn`), and the agent plugins it is kept from. */
export class McpTool {
  readonly name: string;
  readonly description: string;
  readonly schema: string;
  readonly category: string;
  readonly owner: string;
  readonly fn: number;
  readonly except: string[];

  constructor(name: string, description: string, schema: string, category: string, owner: string, fn: number, except: string[]) {
    this.name = name;
    this.description = description;
    this.schema = schema;
    this.category = category;
    this.owner = owner;
    this.fn = fn;
    this.except = except;
  }
}

/** An agent's plugin as a client of the server: the token its requests carry. */
export class McpClient {
  readonly owner: string;
  readonly token: string;

  constructor(owner: string, token: string) {
    this.owner = owner;
    this.token = token;
  }
}

/** A call waiting on its tool: its arguments as JSON text, its JSON-RPC id and progress token as JSON text ("" for none). */
export class McpCall {
  readonly id: number;
  readonly tool: McpTool;
  readonly args: string;
  readonly rpcId: string;
  readonly token: string;
  /** The agent's own id for the tool call (`_meta["claudecode/toolUseId"]` from Claude Code; "" when it gave none). */
  readonly toolUseId: string;
  readonly res: ServerResponse;
  progress = 0;
  done = false;

  constructor(id: number, tool: McpTool, args: string, rpcId: string, token: string, toolUseId: string, res: ServerResponse) {
    this.id = id;
    this.tool = tool;
    this.args = args;
    this.rpcId = rpcId;
    this.token = token;
    this.toolUseId = toolUseId;
    this.res = res;
  }
}

export class McpServer {
  /** The app's name: the server's, the config's key and the tmp folder's prefix. */
  readonly name: string;
  tools: McpTool[] = [];
  /** Where it listens ("" until it does). */
  url = "";
  /** The agent plugins that asked for the server, each with its token (`Authorization: Bearer <token>`). */
  clients: McpClient[] = [];
  /** How long a call waits between progress notifications. */
  progressMs = 10000;
  /** Called with each call to a tool it offers; `answer` ends it. */
  onToolCall: ((call: McpCall) => void) | null = null;
  /** Called when the agent cancelled a call with `notifications/cancelled`, before the response closes. */
  onToolCancel: ((call: McpCall) => void) | null = null;
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  private calls: McpCall[] = [];
  private seq = 0;
  /** The folder holding the config files written for agents, made on the first. */
  private runDir = "";


  constructor(name: string) {
    this.name = name;
  }

  /** The token of plugin `owner`'s requests, made on its first ask and kept for the process. */
  tokenFor(owner: string): string {
    for (const c of this.clients) if (c.owner === owner) return c.token;
    const c = new McpClient(owner, randomBytes(24).toString("hex"));
    this.clients.push(c);
    return c.token;
  }

  /** Forget plugin `owner`'s token and its config file: a retired plugin cannot call with an old one. */
  forgetOwner(owner: string): void {
    this.clients = this.clients.filter((c) => c.owner !== owner);
    if (this.runDir.length === 0) return;
    try {
      rmSync(join(this.runDir, owner + ".json"), { force: true });
    } catch {
      // The file is gone already, or the folder with it.
    }
  }

  private clientOf(token: string): McpClient | null {
    for (const c of this.clients) if (c.token === token) return c;
    return null;
  }

  /** The tools plugin `owner`'s agent sees: every one not excepted for it. */
  visible(owner: string): McpTool[] {
    return this.tools.filter((t) => !t.except.includes(owner));
  }

  /** The names of the tools plugin `owner`'s agent sees. */
  visibleNames(owner: string): string[] {
    return this.visible(owner).map((t) => t.name);
  }

  /** An MCP config file for plugin `owner`'s agent (Claude Code's `--mcp-config` shape), written for the user alone; "" when it cannot be written. */
  configFile(owner: string): string {
    if (this.url.length === 0) return "";
    try {
      if (this.runDir.length === 0) this.runDir = mkdtempSync(join(tmpdir(), this.name + "-mcp-"));
      const path = join(this.runDir, owner + ".json");
      writeFileSync(path, '{"mcpServers":{' + JSON.stringify(this.name) + ':{"type":"http","url":' + JSON.stringify(this.url) + ',"headers":{"Authorization":' + JSON.stringify("Bearer " + this.tokenFor(owner)) + "}}}}\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    } catch {
      return "";
    }
  }

  /** Listen, once: answers the URL, "" when it cannot. It does not keep the program running. */
  start(): Promise<string> {
    const started = this.listening;
    if (started !== null) return started;
    const p = new Promise<string>((resolve) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => this.request(req, res));
      server.on("error", (_e: Error) => resolve(""));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address !== null && typeof address === "object" ? address.port : 0;
        this.url = port > 0 ? "http://127.0.0.1:" + String(port) + "/mcp" : "";
        resolve(this.url);
      });
      server.unref();
      this.server = server;
    });
    this.listening = p;
    return p;
  }

  /** End call `id` with `text`, an error when `isError`; a call already ended (the agent went away) is let be. */
  answer(id: number, text: string, isError: boolean): void {
    for (const c of this.calls) {
      if (c.id !== id) continue;
      this.finish(c);
      c.res.end(event(result(c.rpcId, '{"content":[{"type":"text","text":' + JSON.stringify(text) + '}],"isError":' + String(isError) + "}")));
      return;
    }
  }

  /** End every call waiting, with `text` as their error (the plugins answering them are gone). */
  failAll(text: string): void {
    for (const c of this.calls.slice()) this.answer(c.id, text, true);
  }

  /** Fail the calls waiting on plugin `owner`'s tools. */
  failOwner(owner: string, text: string): void {
    for (const c of this.calls.slice()) if (c.tool.owner === owner) this.answer(c.id, text, true);
  }

  close(): void {
    this.failAll(this.name + " is closing");
    const server = this.server;
    if (server !== null) server.close();
    this.server = null;
    if (this.runDir.length > 0) {
      try {
        rmSync(this.runDir, { recursive: true, force: true });
      } catch {
        this.runDir = "";
      }
      this.runDir = "";
    }
  }

  private finish(c: McpCall): void {
    c.done = true;
    this.calls = this.calls.filter((x: McpCall) => x !== c);
  }

  private plain(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(text);
  }

  private json(res: ServerResponse, text: string): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(text);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    if (req.url !== "/mcp") return this.plain(res, 404, "not found");
    const auth = req.headers["authorization"];
    const client = typeof auth === "string" && auth.startsWith("Bearer ") ? this.clientOf(auth.slice(7)) : null;
    if (client === null) return this.plain(res, 401, "unauthorized");
    if (req.method !== "POST") return this.plain(res, 405, "only POST");
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) this.plain(res, 413, "too large");
      else this.message(Buffer.concat(chunks).toString("utf8"), res, client);
    });
  }

  private message(text: string, res: ServerResponse, client: McpClient): void {
    let m: Rpc | null = null;
    try {
      const v = JSON.parse(text) as unknown;
      m = isRecord(v) ? (v as Rpc) : null;
    } catch {
      m = null;
    }
    if (m === null) return this.json(res, failure("null", -32700, "one JSON-RPC message, not a batch"));
    const method = typeof m.method === "string" ? m.method : "";
    const p = params(m.params);
    // A notification (or a response): taken, nothing to answer.
    if (m.id === undefined || m.id === null) {
      if (method === "notifications/cancelled") this.cancelled(JSON.stringify(p.requestId));
      res.writeHead(202);
      res.end();
      return;
    }
    const id = JSON.stringify(m.id);
    if (method === "initialize") {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      const version = VERSIONS.includes(asked) ? asked : VERSIONS[0];
      return this.json(res, result(id, '{"protocolVersion":' + JSON.stringify(version) + ',"capabilities":{"tools":{}},"serverInfo":{"name":' + JSON.stringify(this.name) + ',"version":"1"}}'));
    }
    if (method === "ping") return this.json(res, result(id, "{}"));
    if (method === "tools/list") {
      const tools: string[] = [];
      for (const t of this.visible(client.owner)) tools.push('{"name":' + JSON.stringify(t.name) + ',"description":' + JSON.stringify(t.description) + ',"inputSchema":' + t.schema + "}");
      return this.json(res, result(id, '{"tools":[' + tools.join(",") + "]}"));
    }
    if (method === "tools/call") return this.call(id, p, res, client);
    this.json(res, failure(id, -32601, this.name + " offers no " + method));
  }

  private call(rpcId: string, p: Params, res: ServerResponse, client: McpClient): void {
    const name = typeof p.name === "string" ? p.name : "";
    let tool: McpTool | null = null;
    for (const t of this.visible(client.owner)) if (t.name === name) tool = t;
    if (tool === null) return this.json(res, failure(rpcId, -32602, this.name + " has no tool " + name));
    const meta = params(p._meta) as Meta;
    const token = typeof meta.progressToken === "string" || typeof meta.progressToken === "number" ? JSON.stringify(meta.progressToken) : "";
    const metaRecord = meta as Record<string, unknown>;
    const toolUseId = typeof metaRecord["claudecode/toolUseId"] === "string" ? (metaRecord["claudecode/toolUseId"] as string) : "";
    const args = typeof p.arguments === "object" && p.arguments !== null ? JSON.stringify(p.arguments) : "{}";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const c = new McpCall(++this.seq, tool, args, rpcId, token, toolUseId, res);
    this.calls.push(c);
    // The agent went away (its process ended, the call was aborted): nothing to answer, and the
    // tool stops the work it started.
    res.on("close", () => {
      if (c.done) return;
      const cancelled = this.onToolCancel;
      if (cancelled !== null) cancelled(c);
      this.finish(c);
    });
    if (token.length > 0) this.keepAlive(c);
    const fn = this.onToolCall;
    if (fn !== null) fn(c);
    else this.answer(c.id, "no one answers " + this.name + "'s tools", true);
  }

  /** A progress notification every few seconds while call `c` waits: the client's timeout starts again on each. */
  private keepAlive(c: McpCall): void {
    setTimeout(() => {
      if (c.done) return;
      c.progress++;
      c.res.write(event('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":' + c.token + ',"progress":' + String(c.progress) + "}}"));
      this.keepAlive(c);
    }, this.progressMs).unref();
  }

  /** The client cancelled the call with JSON-RPC id `rpcId`: it ends with no answer. */
  private cancelled(rpcId: string): void {
    for (const c of this.calls.slice()) {
      if (c.rpcId !== rpcId) continue;
      const fn = this.onToolCancel;
      if (fn !== null) fn(c);
      this.finish(c);
      c.res.end();
    }
  }
}
