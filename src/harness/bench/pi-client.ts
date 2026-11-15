// The benchmark's side of pi's RPC mode: pi's process on stdio, one JSON object a line written to
// its stdin, its records read strictly on "\n" (its documentation warns that a line reader which
// also splits on Unicode separators would break a JSON string), and the waits a run makes: for the
// session to settle and for one command's response.
import { spawn, type ChildProcess } from "node:child_process";
import { recordOf, str } from "@light/lib/json.ts";

class Duty {
  settle: (() => void) | null = null;
}

class Answer {
  settle: ((r: Record<string, unknown> | null) => void) | null = null;
}

export class PiClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private settled = false;
  private closed = false;
  private readonly duties: Duty[] = [];
  private readonly answers = new Map<string, Answer>();
  /** The last of pi's stderr, for a failure's report. */
  stderr = "";
  onRecord: ((r: Record<string, unknown>) => void) | null = null;

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
      this.ended();
    });
    child.on("close", () => this.ended());
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.settled = true;
    for (const d of this.duties.splice(0)) {
      const fn = d.settle;
      if (fn !== null) fn();
    }
    for (const a of this.answers.values()) {
      const fn = a.settle;
      if (fn !== null) fn(null);
    }
    this.answers.clear();
  }

  /** Write one command. */
  send(record: Record<string, unknown>): void {
    const c = this.child;
    if (c !== null && c.stdin !== null && !c.stdin.destroyed) c.stdin.write(JSON.stringify(record) + "\n");
  }

  /** Settle when pi's `agent_settled` arrives (immediately when it already has). */
  waitSettled(): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise<void>((settle) => {
      const d = new Duty();
      d.settle = () => settle();
      this.duties.push(d);
    });
  }

  /** Settle with the response whose id is `id` (null when pi ends first). */
  waitResponse(id: string): Promise<Record<string, unknown> | null> {
    return new Promise<Record<string, unknown> | null>((settle) => {
      const a = new Answer();
      a.settle = settle;
      this.answers.set(id, a);
    });
  }

  /** Close pi's stdin, the orderly shutdown its documentation asks for. */
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
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = line.trim();
      if (line.length > 0) this.line(line);
    }
  }

  private line(line: string): void {
    let r: Record<string, unknown> | null = null;
    try {
      r = recordOf(JSON.parse(line));
    } catch {
      return;
    }
    if (r === null) return;
    const type = str(r["type"]);
    if (type === "response") {
      const a = this.answers.get(str(r["id"]));
      if (a !== undefined) {
        this.answers.delete(str(r["id"]));
        const fn = a.settle;
        if (fn !== null) fn(r);
      }
    } else if (type === "agent_settled") {
      this.settled = true;
      for (const d of this.duties.splice(0)) {
        const fn = d.settle;
        if (fn !== null) fn();
      }
    }
    const fn = this.onRecord;
    if (fn !== null) fn(r);
  }
}
