// The ACP side of the daemon: JSON-RPC 2.0, one message per line on stdin and stdout, as the ACP
// client plugin speaks it. A line with a `method` and an `id` is a request, with a `method` alone a
// notification, with an `id` alone a response to one of ours; the client's id is kept as JSON text
// and echoed as it came. Lines in and out go to a trace file when `--log` names one (the tests
// read it). Nothing but protocol lines goes to stdout.
import { appendFileSync } from "node:fs";
import { parseJson, recordOf, str } from "@light/lib/json.ts";

/** A request (`idText` its id as JSON text) or a notification (`idText` "") from the client. */
export class Incoming {
  readonly method: string;
  readonly params: unknown;
  readonly idText: string;

  constructor(method: string, params: unknown, idText: string) {
    this.method = method;
    this.params = params;
    this.idText = idText;
  }
}

/** One of our requests waiting for the client's answer. */
export class Pending {
  onResult: ((result: unknown) => void) | null = null;
  onFailure: ((message: string) => void) | null = null;
}

export class AcpServer {
  onIncoming: ((m: Incoming) => void) | null = null;
  onStdinEnd: (() => void) | null = null;
  /** Where lines go when it is not stdout (a test). */
  sink: ((line: string) => void) | null = null;
  tracePath = "";
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** Read stdin until it ends. */
  listen(): void {
    process.stdin.on("data", (chunk: Uint8Array) => this.feed(chunk));
    process.stdin.on("end", () => {
      const rest = this.buffer;
      this.buffer = "";
      if (rest.trim().length > 0) this.took(rest);
      const fn = this.onStdinEnd;
      if (fn !== null) fn();
    });
  }

  /** Bytes from the client, in any pieces. */
  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let at = this.buffer.indexOf("\n");
    while (at >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim().length > 0) this.took(line);
      at = this.buffer.indexOf("\n");
    }
  }

  private took(line: string): void {
    this.trace("in  " + line);
    const m = recordOf(parseJson(line));
    if (m === null) return;
    const method = str(m["method"]);
    const id = m["id"];
    if (method.length === 0) {
      if (typeof id !== "number") return;
      const p = this.pending.get(id);
      if (p === undefined) return;
      this.pending.delete(id);
      const error = recordOf(m["error"]);
      if (error !== null) {
        const fn = p.onFailure;
        if (fn !== null) fn(str(error["message"]));
      } else {
        const fn = p.onResult;
        if (fn !== null) fn(m["result"]);
      }
      return;
    }
    const idText = id === undefined || id === null ? "" : JSON.stringify(id);
    const fn = this.onIncoming;
    if (fn !== null) fn(new Incoming(method, m["params"], idText));
  }

  /** Answer request `idText` with `resultText`, JSON. */
  answer(idText: string, resultText: string): void {
    this.send('{"jsonrpc":"2.0","id":' + idText + ',"result":' + resultText + "}");
  }

  /** Fail request `idText`. */
  refuse(idText: string, code: number, message: string): void {
    this.send('{"jsonrpc":"2.0","id":' + idText + ',"error":{"code":' + String(code) + ',"message":' + JSON.stringify(message) + "}}");
  }

  /** A notification to the client, `paramsText` JSON. */
  notify(method: string, paramsText: string): void {
    this.send('{"jsonrpc":"2.0","method":' + JSON.stringify(method) + ',"params":' + paramsText + "}");
  }

  /** A request to the client, settled with its result. */
  sendRequest(method: string, paramsText: string): Promise<unknown> {
    const id = ++this.seq;
    const p = new Pending();
    const promise = new Promise<unknown>((settle, reject) => {
      p.onResult = (result: unknown) => settle(result);
      p.onFailure = (message: string) => reject(new Error(message));
    });
    this.pending.set(id, p);
    this.send('{"jsonrpc":"2.0","id":' + String(id) + ',"method":' + JSON.stringify(method) + ',"params":' + paramsText + "}");
    return promise;
  }

  private send(line: string): void {
    this.trace("out " + line);
    const sink = this.sink;
    if (sink !== null) sink(line);
    else process.stdout.write(line + "\n");
  }

  private trace(line: string): void {
    if (this.tracePath.length === 0) return;
    try {
      appendFileSync(this.tracePath, line + "\n");
    } catch {
      this.tracePath = "";
    }
  }
}
