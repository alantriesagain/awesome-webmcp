// The Claude sidecar as a desktop service: owns a ClaudeAgent and its options, encodes each
// AgentEvent subclass to the JSON the page receives, and reports through nullable callback
// fields (the native rule: no generic emitter class). The shell knows nothing of it; the backend
// registers its methods and forwards its events.
import {
  AgentEvent,
  AgentOptions,
  AssistantEvent,
  ClaudeAgent,
  ErrorEvent,
  ExitEvent,
  InitEvent,
  ResultEvent,
  StderrEvent,
  SystemEvent,
  TextDeltaEvent,
} from "@widecode/agent";
import { log } from "@light/lib/log.ts";

export class AgentService {
  readonly options: AgentOptions;
  private agent = new ClaudeAgent();
  /** An event for the page: its name and its JSON value. */
  onEmit: ((name: string, value: unknown) => void) | null = null;
  /** The turn ended: the result's subtype and whether it was an error. */
  onResult: ((subtype: string, isError: boolean) => void) | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.agent.running;
  }

  /** Start the sidecar when it is not running; answers "" or the reason it could not start. */
  ensureStarted(): string {
    if (this.agent.running) return "";
    const agent = new ClaudeAgent();
    agent.onEvent = (e) => this.handleEvent(e);
    try {
      agent.start(this.options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cannot start claude";
      log("start failed: " + msg);
      return msg;
    }
    this.agent = agent;
    log("agent started: " + this.options.executable + " " + this.options.args().join(" "));
    return "";
  }

  send(text: string): void {
    this.agent.send(text);
  }

  stop(): void {
    this.agent.stop(1500);
  }

  private emit(name: string, value: unknown): void {
    const fn = this.onEmit;
    if (fn !== null) fn(name, value);
  }

  handleEvent(e: AgentEvent): void {
    if (e instanceof TextDeltaEvent) {
      this.emit("delta", { text: e.text });
      return;
    }
    if (e instanceof InitEvent) {
      log("init session=" + e.sessionId + " model=" + e.model + " tools=" + String(e.tools.length));
      this.emit("init", { sessionId: e.sessionId, model: e.model, tools: e.tools.length, version: e.version });
      return;
    }
    if (e instanceof AssistantEvent) {
      this.emit("assistant", { text: e.text });
      return;
    }
    if (e instanceof ResultEvent) {
      log("result " + e.subtype + " turns=" + String(e.numTurns) + " cost=" + String(e.costUsd));
      this.emit("result", { subtype: e.subtype, isError: e.isError, numTurns: e.numTurns, costUsd: e.costUsd, result: e.result, errors: e.errors.join("; ") });
      const fn = this.onResult;
      if (fn !== null) fn(e.subtype, e.isError);
      return;
    }
    if (e instanceof SystemEvent) {
      this.emit("status", { subtype: e.subtype, status: e.status });
      return;
    }
    if (e instanceof StderrEvent) {
      const line = e.text.trim();
      if (line.length > 0) {
        log("stderr: " + line);
        this.emit("stderr", { text: line });
      }
      return;
    }
    if (e instanceof ErrorEvent) {
      log("agent error: " + e.message);
      this.emit("error", { message: e.message });
      return;
    }
    if (e instanceof ExitEvent) {
      log("agent exit " + String(e.code));
      this.emit("exit", { code: e.code });
    }
  }
}
