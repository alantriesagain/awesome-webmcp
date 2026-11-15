// The benchmark's side of ACP: an agent's process on stdio, requests sent and answered by id, its
// notifications handed on, and the requests it makes of the client answered: a permission granted
// with its first option that allows (the benchmark measures what the agent does unattended), a
// file read or write refused (the client offers no file system; the agent uses its own tools).
import { spawn, type ChildProcess } from "node:child_process";
import { listOf, recordOf, str } from "@lightstart/lib/json.ts";

/** What a request answered: its result as JSON text, or the error's message. */
export class RpcReply {
  resultJson = "";
  error = "";
}

/** A request waiting for its answer. */
class Waiting {
  settle: ((r: RpcReply) => void) | null = null;
}

/** A notification from the agent: its method and its params, parsed. */
export class AgentNote {
  readonly method: string;
  readonly params: Record<string, unknown>;

  constructor(method: string, params: Record<string, unknown>) {
    this.method = method;
    this.params = params;
  }
}

export class AcpClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, Waiting>();
  private buffer = "";
  private ended = false;
  /** The agent's stderr, the last of it, for a failure's report. */
  stderr = "";
  onNote: ((n: AgentNote) => void) | null = null;
  onExit: ((code: number) => void) | null = null;

  /** Start `command` in `cwd` with `env` added. */
  start(command: string[], cwd: string, env: Record<string, string>): void {
    const vars: Record<string, string> = {};
    for (const k of Object.keys(process.env)) {
      const v = process.env[k];
      if (typeof v === "string" && k !== "CLAUDECODE" && k !== "CLAUDE_CODE_ENTRYPOINT") vars[k] = v;
    }
    for (const k of Object.keys(env)) vars[k] = env[k];
    const child = spawn(command[0], command.slice(1), { cwd, env: vars, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout!.on("data", (c: Buffer) => this.feed(c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (err: Error) => {
      this.stderr = (this.stderr + err.message).slice(-4000);
      this.endedWith(-1);
    });
    child.on("close", (code: number | null) => this.endedWith(code ?? -1));
  }

  private endedWith(code: number): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiting.values()) {
      const fn = w.settle;
      const r = new RpcReply();
      r.error = "the agent ended (" + String(code) + ")";
      if (fn !== null) fn(r);
    }
    this.waiting.clear();
    const fn = this.onExit;
    if (fn !== null) fn(code);
  }

  private write(text: string): void {
    const c = this.child;
    if (c !== null && c.stdin !== null && !c.stdin.destroyed) c.stdin.write(text + "\n");
  }

  /** Send `method` with `params` (JSON text); settles with its answer. */
  request(method: string, paramsJson: string): Promise<RpcReply> {
    const id = ++this.seq;
    return new Promise<RpcReply>((settle) => {
      const w = new Waiting();
      w.settle = settle;
      this.waiting.set(id, w);
      this.write('{"jsonrpc":"2.0","id":' + String(id) + ',"method":' + JSON.stringify(method) + ',"params":' + paramsJson + "}");
    });
  }

  notify(method: string, paramsJson: string): void {
    this.write('{"jsonrpc":"2.0","method":' + JSON.stringify(method) + ',"params":' + paramsJson + "}");
  }

  stop(): void {
    const c = this.child;
    if (c === null) return;
    if (c.stdin !== null) c.stdin.end();
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGTERM");
    }, 2000);
  }

  private feed(text: string): void {
    this.buffer += text;
    for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.length > 0) this.line(line);
    }
  }

  private line(line: string): void {
    let m: Record<string, unknown> | null = null;
    try {
      m = recordOf(JSON.parse(line));
    } catch {
      return;
    }
    if (m === null) return;
    const method = str(m["method"]);
    const hasId = m["id"] !== undefined && m["id"] !== null;
    if (method.length > 0 && hasId) {
      this.answerAgent(JSON.stringify(m["id"]), method, recordOf(m["params"]) ?? {});
      return;
    }
    if (method.length > 0) {
      const fn = this.onNote;
      if (fn !== null) fn(new AgentNote(method, recordOf(m["params"]) ?? {}));
      return;
    }
    const id = typeof m["id"] === "number" ? (m["id"] as number) : -1;
    const w = this.waiting.get(id);
    if (w === undefined) return;
    this.waiting.delete(id);
    const r = new RpcReply();
    const err = recordOf(m["error"]);
    if (err !== null) r.error = str(err["message"]).length > 0 ? str(err["message"]) : "refused";
    else r.resultJson = JSON.stringify(m["result"] ?? null);
    const fn = w.settle;
    if (fn !== null) fn(r);
  }

  /** A request of the agent's: a permission allowed with its first allowing option, anything else refused. */
  private answerAgent(idText: string, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") {
      let chosen = "";
      for (const v of listOf(params["options"])) {
        const o = recordOf(v);
        if (o === null) continue;
        const kind = str(o["kind"]);
        if (chosen.length === 0 && (kind === "allow_once" || kind === "allow_always")) chosen = str(o["optionId"]);
      }
      const outcome = chosen.length > 0 ? '{"outcome":"selected","optionId":' + JSON.stringify(chosen) + "}" : '{"outcome":"cancelled"}';
      this.write('{"jsonrpc":"2.0","id":' + idText + ',"result":{"outcome":' + outcome + "}}");
      return;
    }
    this.write('{"jsonrpc":"2.0","id":' + idText + ',"error":{"code":-32601,"message":"the benchmark offers no ' + method.replace(/"/g, "") + '"}}');
  }
}
