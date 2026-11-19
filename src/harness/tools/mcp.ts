// The tools of an MCP server the client named for the session (widecode's own, over HTTP with its
// token): `tools/list` once the session opens, each tool offered to the model as
// `mcp__<server>__<tool>` and shown to the client as `<server>_<tool>` (the title opencode gives
// it, which the acp plugin knows), and `tools/call` when the model calls one: the answer read to
// the end of its event stream (a question waits on the user, with progress meanwhile), the call
// dropped on abort. A server is assumed to need no MCP session id (widecode's does not).
import { listOf, recordOf, str } from "@lightstart/lib/json.ts";
import { Abort, Stopper } from "../loop/abort.ts";
import { SseSplitter } from "../model/sse.ts";
import { HttpRequest, HttpStream } from "../http/stream.ts";

const PROTOCOL = "2025-06-18";
/** How long a listing may take, and a call (a question waits for the user). */
const LIST_MS = 15000;
const CALL_MS = 24 * 3600 * 1000;

/** What a request answered: its result as JSON text, else why not. */
export class RpcAnswer {
  resultJson = "";
  error = "";
}

/** A name as a tool's part: letters, digits, `_` and `-`. */
export const toolPart = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** A tool a server offers: its name there, its description and input schema as JSON text. */
export class McpToolInfo {
  readonly server: string;
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;

  constructor(server: string, name: string, description: string, schemaJson: string) {
    this.server = server;
    this.name = name;
    this.description = description;
    this.schemaJson = schemaJson;
  }

  /** The name the model calls it by. */
  calledAs(): string {
    return "mcp__" + toolPart(this.server) + "__" + toolPart(this.name);
  }

  /** The title its calls show with. */
  titledAs(): string {
    return toolPart(this.server) + "_" + toolPart(this.name);
  }
}

export class McpLink {
  readonly name: string;
  readonly url: string;
  /** Header name and value pairs. */
  readonly headers: string[][];
  httpKind = "node";
  private seq = 0;
  private initialized = false;

  constructor(name: string, url: string, headers: string[][]) {
    this.name = name;
    this.url = url;
    this.headers = headers;
  }

  /** The HTTP servers of a session's `mcpServers` (JSON text, ACP's shape: `{type: "http", name, url, headers: [{name, value}]}`). */
  static fromSession(serversText: string): McpLink[] {
    const out: McpLink[] = [];
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(serversText);
    } catch {
      return out;
    }
    for (const v of listOf(parsed)) {
      const s = recordOf(v);
      if (s === null || str(s["type"]) !== "http" || str(s["name"]).length === 0 || str(s["url"]).length === 0) continue;
      const headers: string[][] = [];
      for (const h of listOf(s["headers"])) {
        const r = recordOf(h);
        if (r !== null && str(r["name"]).length > 0) headers.push([str(r["name"]), str(r["value"])]);
      }
      out.push(new McpLink(str(s["name"]), str(s["url"]), headers));
    }
    return out;
  }

  private requestHeaders(): string[][] {
    const out: string[][] = [["content-type", "application/json"], ["accept", "application/json, text/event-stream"]];
    for (const h of this.headers) out.push(h);
    return out;
  }

  /** One JSON-RPC request (`paramsJson` its params as JSON text); the answer read from a JSON body or an event stream. */
  async rpc(method: string, paramsJson: string, abort: Abort, totalMs: number): Promise<RpcAnswer> {
    const answer = new RpcAnswer();
    const id = ++this.seq;
    const http = new HttpStream(this.httpKind);
    const stopper = new Stopper();
    stopper.stopNow = () => http.abort();
    abort.watch(stopper);
    let status = 0;
    let body = "";
    http.onStatus = (n: number) => {
      status = n;
    };
    http.onChunk = (text: string) => {
      body += text;
    };
    const r = new HttpRequest(this.url);
    r.headers = this.requestHeaders();
    r.body = '{"jsonrpc":"2.0","id":' + String(id) + ',"method":' + JSON.stringify(method) + ',"params":' + paramsJson + "}";
    r.totalMs = totalMs;
    const end = await http.start(r);
    abort.unwatch(stopper);
    if (abort.aborted) {
      answer.error = "interrupted";
      return answer;
    }
    if (end.error.length > 0 || status !== 200) {
      answer.error = end.error.length > 0 ? end.error : "the server answered " + String(status) + (body.length > 0 ? ": " + body.trim().slice(0, 200) : "");
      return answer;
    }
    // One JSON message, or an event stream whose message of this id is the answer.
    const texts: string[] = [];
    if (body.trimStart().startsWith("{")) texts.push(body);
    else {
      const sse = new SseSplitter();
      for (const ev of sse.push(body)) texts.push(ev.data);
      for (const ev of sse.flush()) texts.push(ev.data);
    }
    for (const text of texts) {
      let m: Record<string, unknown> | null = null;
      try {
        m = recordOf(JSON.parse(text));
      } catch {
        m = null;
      }
      if (m === null || m["id"] !== id) continue;
      const err = recordOf(m["error"]);
      if (err !== null) answer.error = str(err["message"]).length > 0 ? str(err["message"]) : "the server refused " + method;
      else answer.resultJson = JSON.stringify(m["result"] ?? {});
      return answer;
    }
    answer.error = "no answer to " + method;
    return answer;
  }

  /** The handshake, once: initialize, then the notification that it is done. */
  private async handshake(abort: Abort): Promise<string> {
    if (this.initialized) return "";
    const got = await this.rpc("initialize", '{"protocolVersion":"' + PROTOCOL + '","capabilities":{},"clientInfo":{"name":"widecode-harness","version":"1"}}', abort, LIST_MS);
    if (got.error.length > 0) return got.error;
    this.initialized = true;
    const note = new HttpStream(this.httpKind);
    const r = new HttpRequest(this.url);
    r.headers = this.requestHeaders();
    r.body = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
    r.totalMs = LIST_MS;
    await note.start(r);
    return "";
  }

  /** The server's tools; none when it cannot be reached (`error` says why). */
  async listTools(abort: Abort): Promise<McpListing> {
    const out = new McpListing();
    const failed = await this.handshake(abort);
    if (failed.length > 0) {
      out.error = failed;
      return out;
    }
    const got = await this.rpc("tools/list", "{}", abort, LIST_MS);
    if (got.error.length > 0) {
      out.error = got.error;
      return out;
    }
    const result = recordOf(JSON.parse(got.resultJson));
    for (const v of listOf(result !== null ? result["tools"] : null)) {
      const t = recordOf(v);
      if (t === null || str(t["name"]).length === 0) continue;
      const schema = recordOf(t["inputSchema"]);
      out.tools.push(new McpToolInfo(this.name, str(t["name"]), str(t["description"]), schema !== null ? JSON.stringify(schema) : '{"type":"object","properties":{}}'));
    }
    return out;
  }

  /** Call `tool` with `argsJson`: the text it answered, and whether that is an error. */
  async callTool(tool: string, argsJson: string, abort: Abort, totalMs = CALL_MS): Promise<McpCallEnd> {
    const out = new McpCallEnd();
    const failed = await this.handshake(abort);
    if (failed.length > 0) {
      out.text = this.name + " cannot be reached: " + failed;
      out.isError = true;
      return out;
    }
    const got = await this.rpc("tools/call", '{"name":' + JSON.stringify(tool) + ',"arguments":' + (argsJson.length > 0 ? argsJson : "{}") + ',"_meta":{"progressToken":' + String(this.seq + 1) + "}}", abort, totalMs);
    if (got.error.length > 0) {
      out.text = got.error;
      out.isError = true;
      return out;
    }
    const result = recordOf(JSON.parse(got.resultJson));
    const texts: string[] = [];
    for (const v of listOf(result !== null ? result["content"] : null)) {
      const c = recordOf(v);
      if (c !== null && str(c["type"]) === "text") texts.push(str(c["text"]));
    }
    out.text = texts.join("\n");
    out.isError = result !== null && result["isError"] === true;
    return out;
  }
}

export class McpListing {
  tools: McpToolInfo[] = [];
  error = "";
}

export class McpCallEnd {
  text = "";
  isError = false;
}
