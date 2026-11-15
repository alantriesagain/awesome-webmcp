import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { LineSplitter } from "@lightstart/lib/ndjson.ts";
import { AgentEvent, ErrorEvent, ExitEvent, StderrEvent, decodeEnvelope } from "./envelope.ts";

/**
 * The CLI to run for `given`: the path given (`--claude`), else `claude` in a directory of `path`
 * (PATH's value), else the installer's `~/.local/bin/claude` under `home`, else the bare name. The
 * claude plugin resolves the agent's own the same way, on the plugin API.
 */
export const claudeExecutable = (given: string, path: string, home: string): string => {
  if (given.length > 0) return given;
  for (const dir of path.split(":")) if (dir.length > 0 && existsSync(dir + "/claude")) return dir + "/claude";
  const local = home + "/.local/bin/claude";
  return existsSync(local) ? local : "claude";
};

/** How to launch the Claude Code CLI. `null` means "do not pass the flag". */
export class AgentOptions {
  executable = "claude";
  systemPrompt: string | null = null;
  appendSystemPrompt: string | null = null;
  model: string | null = null;
  resume: string | null = null;
  /** `""` disables every built-in tool; `null` keeps the CLI default. */
  tools: string | null = null;
  permissionMode: string | null = null;
  maxTurns: number | null = null;
  /** `--effort`: low, medium, high, xhigh or max. */
  effort: string | null = null;
  /** `--permission-prompt-tool`; `"stdio"` sends permission prompts to the host as control requests. */
  permissionPromptTool: string | null = null;
  /** `--forward-subagent-text`: subagent messages arrive tagged with `parent_tool_use_id`. */
  forwardSubagentText = false;
  /** `--replay-user-messages`: user messages written to stdin come back on stdout. */
  replayUserMessages = false;
  /** `--session-id`: start a new session under this UUID. */
  sessionId: string | null = null;
  /** `--fork-session`: resume into a new session id. */
  forkSession = false;
  /** The folder the CLI runs in; `null` keeps the caller's. */
  cwd: string | null = null;
  /** Launch through `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`, so a CLI started from inside
   * Claude Code does not take itself for a nested session. */
  cleanEnv = false;
  extraArgs: string[] = [];

  /** The program to spawn: the CLI itself, or `env` in front of it. */
  command(): string {
    return this.cleanEnv ? "env" : this.executable;
  }

  /** The arguments for `command()`. */
  commandArgs(): string[] {
    const a = this.args();
    if (!this.cleanEnv) return a;
    const out: string[] = ["-u", "CLAUDECODE", "-u", "CLAUDE_CODE_ENTRYPOINT", this.executable];
    for (const x of a) out.push(x);
    return out;
  }

  args(): string[] {
    const a: string[] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (this.systemPrompt !== null) a.push("--system-prompt", this.systemPrompt);
    if (this.appendSystemPrompt !== null) a.push("--append-system-prompt", this.appendSystemPrompt);
    if (this.model !== null) a.push("--model", this.model);
    if (this.resume !== null) a.push("--resume", this.resume);
    if (this.tools !== null) a.push("--tools", this.tools);
    if (this.permissionMode !== null) a.push("--permission-mode", this.permissionMode);
    if (this.maxTurns !== null) a.push("--max-turns", String(this.maxTurns));
    if (this.effort !== null) a.push("--effort", this.effort);
    if (this.permissionPromptTool !== null) a.push("--permission-prompt-tool", this.permissionPromptTool);
    if (this.forwardSubagentText) a.push("--forward-subagent-text");
    if (this.replayUserMessages) a.push("--replay-user-messages");
    if (this.sessionId !== null) a.push("--session-id", this.sessionId);
    if (this.forkSession) a.push("--fork-session");
    for (const x of this.extraArgs) a.push(x);
    return a;
  }
}

/**
 * The Claude Code CLI as a sidecar: one long-lived `claude -p` process per session, user turns
 * written as NDJSON to its stdin, events decoded from its stdout. Delivery is synchronous from
 * the stdout `data` callback; consumers batch their state writes.
 */
export class ClaudeAgent {
  /** Receives every event the agent produces; a plain field, since a generic emitter class across modules miscompiles natively. */
  onEvent: ((e: AgentEvent) => void) | null = null;
  /** Receives every stdout line as written, before any decoding; set it to forward the stream
   * untouched. Lines are decoded into events only while `onEvent` is set and `decodeLines` holds. */
  onLine: ((line: string) => void) | null = null;
  /** Decode stdout lines into events; off for a consumer that parses `onLine` itself and wants
   * `onEvent` only for stderr, errors and the exit. */
  decodeLines = true;

  private deliverLine(line: string): void {
    // A handler that throws must not end the stream: every later line would be lost unseen.
    try {
      const raw = this.onLine;
      if (raw !== null) raw(line);
      if (this.decodeLines && this.onEvent !== null) this.emitEvent(decodeEnvelope(line));
    } catch (err) {
      this.emitEvent(new ErrorEvent("a stdout line's handler failed: " + (err instanceof Error ? err.message : "error") + " (line: " + line.slice(0, 120) + ")"));
    }
  }

  private emitEvent(e: AgentEvent): void {
    const fn = this.onEvent;
    if (fn !== null) fn(e);
  }
  private child: ChildProcess | null = null;
  private readonly lines = new LineSplitter();
  private exited = false;

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** The process is over: its last lines, then one exit, once. */
  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const line of this.lines.flush()) this.deliverLine(line);
    this.emitEvent(new ExitEvent(code));
  }

  start(o: AgentOptions): void {
    if (this.child !== null) throw new Error("[agent] already started");
    const cwd = o.cwd;
    const child = cwd !== null ? spawn(o.command(), o.commandArgs(), { cwd: cwd, stdio: ["pipe", "pipe", "pipe"] }) : spawn(o.command(), o.commandArgs(), { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const line of this.lines.push(chunk)) this.deliverLine(line);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      this.emitEvent(new StderrEvent(chunk.toString()));
    });
    child.on("error", (err: Error) => {
      if (this.exited) return;
      this.emitEvent(new ErrorEvent(err.message));
      this.finish(-1);
    });
    child.on("close", (code: number | null) => {
      this.finish(code === null ? -1 : code);
    });
    // A write to a process that has gone (EPIPE) is an error, not an unhandled stream event.
    child.stdin!.on("error", (err: Error) => {
      if (this.exited) return;
      this.emitEvent(new ErrorEvent(err.message));
      this.finish(-1);
    });
  }

  /** Send one user turn. */
  send(text: string): void {
    const child = this.child;
    if (child === null || this.exited) throw new Error("[agent] not running");
    child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  }

  /** Write one NDJSON line to the CLI's stdin as given (a user message or a control message). */
  write(line: string): void {
    const child = this.child;
    if (child === null || this.exited) throw new Error("[agent] not running");
    child.stdin!.write(line + "\n");
  }

  /** Close stdin: the CLI finishes the current turn and exits. */
  endInput(): void {
    const child = this.child;
    if (child === null || this.exited) return;
    child.stdin!.end();
  }

  /** Close stdin and, if the process is still alive after a grace period, terminate it, then kill it. */
  stop(graceMs: number): void {
    const child = this.child;
    if (child === null || this.exited) return;
    child.stdin!.end();
    const term = setTimeout(() => {
      if (this.exited) return;
      child.kill("SIGTERM");
      const hard = setTimeout(() => {
        if (!this.exited) child.kill("SIGKILL");
      }, Math.max(0, graceMs));
      hard.unref();
    }, Math.max(0, graceMs));
    term.unref();
  }

  /** Hard stop. */
  kill(): void {
    const child = this.child;
    if (child === null || this.exited) return;
    child.kill("SIGKILL");
  }
}
