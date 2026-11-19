// Agents over ACP, the Agent Client Protocol (agentclientprotocol.com: JSON-RPC 2.0 on the agent's
// stdin and stdout): each entry of this plugin's section of config.json is one the conversation can
// talk to, chosen with "agent" in config.json or --agent <id>. The agent's messages become the
// conversation's events: its text and thinking, its calls (their kind, title, files, diffs and
// output; a todo list or a subagent its input names), its plan as a todo list, its model, effort,
// mode and commands (config options, or the older modes and models), a session it loads replayed as
// turns, and the permissions it asks for, answered from the request panel. Its session starts with
// widecode (and after /new), so the models and efforts it offers are known before the first
// message; one made and never written to is deleted (the entry's "forget" command) when it is left,
// at once or by the next widecode when this one quit. An agent that takes MCP
// servers over HTTP gets widecode's (api.tools: AskUser, PresentPlan), whose calls show as their
// requests. Esc cancels its turn. The Sessions
// tab lists its sessions from session/list while it runs, when it offers that, else from the
// entry's "sessions" command (it prints them as JSON). ACP does not say which tools an agent has:
// the entry's "tools" command prints them for the mode ({mode} in it), as opencode's
// `debug agent <mode>` does, read once the session is made and again as its mode changes. Nor
// which skills: the entry's "skills" command prints them (opencode's `debug skill`: a list of name,
// description, location and content), read once the session is made; a call of the agent's `skill`
// tool, the skill's name in its input, is a skill call for the Skills tab. Its section:
// { "agents": { "opencode": { "name": "opencode", "command": ["opencode", "acp"],
//   "sessions": ["opencode", "session", "list", "--format", "json"],
//   "tools": ["opencode", "debug", "agent", "{mode}"], "skills": ["opencode", "debug", "skill"] } } };
// an entry with the id of a default replaces it.
// Three agents ship: opencode, the DeepSeek Harness (`dsh`, the `dsh --profile acp` command), and
// widecode's own, the harness (`{widecode} --harness`, the running binary, `own: true`: the
// project's prompt and trust go to it in `_meta.widecode` with each session and prompt). An
// agent that advertises session/load (opencode) replays a past session's turns; one that only
// advertises session/resume (the DeepSeek Harness) reopens it without them.

// This file keeps the plugin's registration and what only it uses: the run of a Task subagent
// (SubagentRun) and its state. agents.ts holds the entries, rules.ts what a mode lets its tools do,
// calls.ts a call's facts and diffs, shell.ts the entries' commands, sessions.ts the session list
// and records, settings.ts the model, mode and effort, tasks.ts the subagent targets and box, and
// acp-agent.ts the adapter itself.

import { obj, str, list, parse } from "./json.ts";
import type { Ev, Msg } from "./json.ts";
import { DEFAULT_AGENTS, agentsOf, resolved } from "./agents.ts";
import type { Entry } from "./agents.ts";
import { CATEGORY, NAME, resultOf } from "./calls.ts";
import { quote } from "./shell.ts";
import { sweep } from "./sessions.ts";
import { tasksOf, BoxRunner, TaskCalls } from "./tasks.ts";
import type { TaskTarget } from "./tasks.ts";
import { acpAgent } from "./acp-agent.ts";
import { approve, pathsOf } from "./approval.ts";

/** Sizes a run logs while it keeps its events, to diagnose memory growth. */
const EVENT_LOG_CHARS = 1024 * 1024;
const HISTORY_LOG_CHARS = 8 * 1024 * 1024;
/** Log lines a run keeps in its persisted transcript, as the conversation keeps them under its call. */
const MAX_LOG_LINES = 200;
/** How long an idle background run keeps its process for SendMessage, and how many such processes it keeps at most. */
const IDLE_MS = 120000;
const MAX_IDLE_RUNS = 6;

/** A test seam: an update handler failure injected to exercise the run's failure path. */
let crashOnUpdate = false;
/** A test seam: how long an idle background run keeps its process. */
let idleMs = IDLE_MS;

/** Run one step of settling a call, going on when it throws: a host call failing must not stop the next step. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // The next step still runs.
  }
}

/** End a process, killing it when stopping it throws. */
function end(proc: widecode.ProcessHandle, ms: number): void {
  try {
    proc.stop(ms);
  } catch {
    attempt(() => proc.kill());
  }
}

/** A request waiting on the subagent's answer, with what hears it. */
class Waiter {
  readonly id: number;
  readonly then: (result: Msg | null, error: string) => void;

  constructor(id: number, then: (result: Msg | null, error: string) => void) {
    this.id = id;
    this.then = then;
  }
}

/**
 * One Task run: an ACP agent started for a target, its session and prompt, mapped into the
 * conversation under the call Claude made. It answers the MCP call with the subagent's last words,
 * and dies with it.
 */
class SubagentRun {
  private readonly api: widecode.Api;
  private readonly entry: Entry;
  private readonly target: TaskTarget;
  private readonly box: BoxRunner | null;
  private readonly boxFolder: string;
  private readonly cwd: string;
  private readonly worktree: string;
  private readonly model: string;
  private readonly callId: string;
  private readonly description: string;
  private readonly synthetic: boolean;
  private readonly background: boolean;
  private readonly timeoutMs: number;
  private readonly onDone: () => void;
  private readonly onIdle: (idle: boolean) => void;
  private proc: widecode.ProcessHandle | null = null;
  /** Whether this run holds a VM run in the box's count, released as it ends. */
  private vmRun = false;
  private seq = 0;
  private waiting: Waiter[] = [];
  private session = "";
  private runSession = "";
  private modelConfig = "";
  private open = "";
  private openKind = "";
  private blocks = 0;
  private calls = new Map<string, string>();
  /** The last input JSON emitted for each open call, dropped when the call finishes. */
  private inputs = new Map<string, string>();
  private out: unknown[] = [];
  /** The events applied so far, each as its JSON line: encoded once, as it streams, so keeping them is a join. */
  private history: string[] = [];
  /** The characters kept in `history`, and the size at which the next line is logged. */
  private historyChars = 0;
  private historyLoggedAt = HISTORY_LOG_CHARS;
  /** The log notices kept in `history`, dropped oldest first past `MAX_LOG_LINES`. */
  private logLines = 0;
  private reply = "";
  /** The title of a permission this prompt's run refused, while it has not reported its end. */
  private refused = "";
  private busy = false;
  private closed = false;
  /** Whether this call has a result reported to the parent, so a later process exit does not report it again. */
  private reported = false;
  /** The last part of its stderr without a newline, until the rest arrives. */
  private stderrTail = "";
  private timeoutGen = 0;
  /** The idle timer's generation: a message to the run drops a pending idle stop. */
  private idleGen = 0;
  private resolve: (text: string) => void = () => {};
  private reject: (error: Error) => void = () => {};
  readonly promise: Promise<string>;

  constructor(api: widecode.Api, entry: Entry, target: TaskTarget, box: BoxRunner | null, boxFolder: string, cwd: string, worktree: string, model: string, callId: string, description: string, synthetic: boolean, background: boolean, timeoutMs: number, onDone: () => void, onIdle: (idle: boolean) => void) {
    this.api = api;
    this.entry = entry;
    this.target = target;
    this.box = box;
    this.boxFolder = boxFolder;
    this.cwd = cwd;
    this.worktree = worktree;
    this.model = model;
    this.callId = callId;
    this.description = description;
    this.synthetic = synthetic;
    this.background = background;
    this.timeoutMs = timeoutMs;
    this.onDone = onDone;
    this.onIdle = onIdle;
    this.promise = new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /** Keep `e` in the run's history, as the line a later read applies. */
  private keep(e: Ev): void {
    const line = JSON.stringify(e);
    if (line.length > EVENT_LOG_CHARS) this.api.note("acp: task " + this.callId + " event " + str(obj(e)?.type) + " " + String(line.length) + " characters");
    this.history.push(line);
    this.historyChars += line.length;
    const value = obj(e);
    if (value !== null && str(value.type) === "notice" && str(value.tone) === "log") {
      this.logLines++;
      if (this.logLines > MAX_LOG_LINES) {
        // The oldest log notice goes; the line just kept is the newest.
        const at = this.history.findIndex((kept) => kept.startsWith('{"type":"notice"') && kept.includes('"tone":"log"'));
        if (at >= 0) {
          this.historyChars -= this.history[at].length;
          this.history.splice(at, 1);
          this.logLines--;
        }
      }
    }
    while (this.historyChars >= this.historyLoggedAt) {
      this.api.note("acp: task " + this.callId + " history " + String(this.historyChars) + " characters");
      this.historyLoggedAt += HISTORY_LOG_CHARS;
    }
  }

  private flush(): void {
    if (this.out.length === 0) return;
    const batch = this.out;
    this.out = [];
    for (const e of batch) this.keep(e as Ev);
    this.api.conversation.subagent(this.callId, batch as widecode.ConversationEvent[]);
  }

  /** Keep this run's events under the project, so a later run can read its steps back. */
  private persist(): void {
    if (this.runSession.length === 0) this.runSession = this.api.agent.sessionId();
    const sid = this.runSession;
    if (sid.length === 0 || this.history.length === 0) return;
    this.api.store.saveTaskTranscript(sid, this.callId, this.history.join("\n") + "\n");
  }

  /** Run `work`, reporting a failure through the run's own failure path rather than the process's handler. */
  private guard(where: string, work: () => void): void {
    try {
      work();
    } catch (e) {
      this.crashed(where, e);
    }
  }

  private beginVm(): void {
    if (this.box === null || this.vmRun) return;
    this.vmRun = true;
    this.box.enterVm();
  }

  private releaseVm(): void {
    if (!this.vmRun || this.box === null) return;
    this.vmRun = false;
    this.box.leaveVm();
  }

  /** Stop its process once, after its final answer has been read, and say so. */
  private stopProcess(ms: number): void {
    const proc = this.proc;
    this.proc = null;
    if (proc === null) return;
    end(proc, ms);
    this.api.note("acp: subagent " + this.callId + " process stopped");
  }

  /** Whether it waits idle for a message, holding a process for one. */
  idle(): boolean {
    return this.background && !this.closed && !this.busy;
  }

  /** A finished background run waits for a message for a while; then its process goes. */
  private waitingIdle(): void {
    const gen = ++this.idleGen;
    this.onIdle(true);
    this.api.after(idleMs, () =>
      this.guard("its idle timer", () => {
        if (gen === this.idleGen && !this.closed && !this.busy) this.retire();
      }),
    );
  }

  /** Stop an idle background run's process, keeping its card's result. */
  retire(): void {
    if (this.closed || this.busy) return;
    this.idleGen++;
    this.onIdle(false);
    this.closed = true;
    this.timeoutGen++;
    this.stopProcess(1000);
    attempt(() => this.onDone());
  }

  /** An exception while handling what the process said: settle the call, or just note it once it has a result. */
  private crashed(where: string, e: unknown): void {
    const why = e instanceof Error ? e.message : String(e);
    const text = "the subagent run failed in " + where + ": " + why;
    try {
      if (!this.closed && !this.reported) this.fail(text);
      else this.api.note("acp: task " + this.callId + ": " + text);
    } catch {
      // A host call is failing; nothing more can be done from here.
    }
  }

  /** Whether a prompt is running: what counts against the bound on subagents at once. */
  working(): boolean {
    return this.busy && !this.closed;
  }

  private emit(e: Ev): void {
    this.out.push(e);
  }

  /** A key or call id of this run, so a subagent's ids cannot collide with the main conversation's. */
  private key(id: string): string {
    return "task:" + this.callId + ":" + id;
  }

  /** A main agent that names no call (an ACP agent) gets the card made here, under its open turn. */
  createCard(): boolean {
    if (!this.synthetic) return true;
    const n = this.api.conversation.apply([{ type: "block", key: this.callId, kind: "tool", id: this.callId, name: "Task", text: "" }]);
    return n > 0;
  }

  start(prompt: string): Promise<string> {
    this.runSession = this.api.agent.sessionId();
    this.busy = true;
    this.reported = false;
    this.emit({ type: "facts", id: this.callId, category: "agent", summary: this.target.name + ": " + this.description, agentType: this.target.name, agentTask: this.description, agentPrompt: prompt });
    this.emit({ type: "task", id: this.callId, taskId: this.callId, description: this.description, agentType: this.target.name, background: this.background });
    this.flush();
    if (this.target.box.length > 0) {
      if (this.box === null) {
        this.fail("no box is configured for " + this.target.name);
        return this.promise;
      }
      const kind = this.target.box;
      if (kind === "vm") this.beginVm();
      this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "running", summary: "starting the box" });
      this.flush();
      return this.box.ensure(this.boxFolder, kind).then((why) => {
        let out: Promise<string> = this.promise;
        this.guard("its box", () => {
          if (why.length > 0) this.fail(why);
          else out = this.launch(prompt, kind);
        });
        return out;
      });
    }
    return this.launch(prompt, "");
  }

  private launch(prompt: string, boxKind: string): Promise<string> {
    const command = resolved(this.api, this.entry.command);
    let words = command;
    if (boxKind.length > 0 && this.box !== null) {
      if (boxKind === "bwrap") {
        const projects: string[] = ["--project", this.boxFolder];
        for (const p of this.box.config.projects) projects.push("--project", p);
        words = ["node", this.box.config.script, "jail", "--proxy-port", String(this.box.config.proxyPort), ...projects, "--", ...command];
      } else {
        words = ["node", this.box.config.script, "ssh", "--forward-proxy", String(this.box.config.proxyPort), "--", ...command];
      }
    }
    const p = this.api.process.spawn(words, { cwd: this.cwd }, {
      // Each batch goes under the card as it comes, so the run streams and no one call carries all of it.
      lines: (lines) =>
        this.guard("its output", () => {
          for (const l of lines) this.line(l);
          this.flush();
        }),
      exit: (code) => this.guard("its exit", () => this.exited(code)),
      error: (text) => this.guard("its error output", () => this.stderr(text)),
    });
    if (!p.started) {
      this.releaseVm();
      const text = "cannot start " + words.join(" ");
      this.closed = true;
      this.onDone();
      if (this.background) this.notify(text, true);
      this.reject(new Error(text));
      return this.promise;
    }
    this.proc = p;
    this.rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "widecode", version: String(widecode.version) } }, (_result, error) => {
      if (error.length > 0) {
        this.fail(error);
        return;
      }
      this.newSession(prompt);
    });
    if (this.background) return Promise.resolve("subagent started: " + this.callId + (this.worktree.length > 0 ? "\nworktree: " + this.worktree : ""));
    return this.promise;
  }

  /** A message from the main agent to an idle run; "" or why not. */
  send(text: string): string {
    if (this.closed || this.proc === null) return "the subagent is not running";
    if (this.busy) return "the subagent is busy";
    this.idleGen++;
    this.onIdle(false);
    this.reported = false;
    this.reply = "";
    this.open = "";
    this.openKind = "";
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "running", summary: this.description });
    this.flush();
    this.prompt(text);
    return "";
  }

  /** The agent cancelled the call, or the user stopped the run: its session stops and its card says so. */
  cancel(): void {
    if (this.closed) return;
    this.releaseVm();
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    this.idleGen++;
    this.onIdle(false);
    this.reported = true;
    if (this.proc !== null) {
      const proc = this.proc;
      attempt(() => proc.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } })));
    }
    this.stopProcess(1000);
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: "stopped" });
    attempt(() => this.flush());
    attempt(() => this.persist());
    attempt(() => this.onDone());
    this.resolve(this.reply.length > 0 ? this.reply : "The subagent was stopped.");
  }

  /** End its process without reporting: the plugin, or the session it ran in, is going away (`why`, for its transcript). */
  stopQuietly(why: string): void {
    this.releaseVm();
    const unsettled = !this.reported && !this.closed;
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    this.idleGen++;
    this.onIdle(false);
    // A run that never reported keeps a stopped end in its transcript, so a later read does not say
    // it is still running. It is not sent to the conversation now, nor told to the parent.
    if (unsettled) {
      this.reported = true;
      this.keep({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: "stopped: " + why });
      attempt(() => this.persist());
    }
    this.stopProcess(1000);
  }

  /** Whether it ran in another session than `session`, so it should stop with that session. */
  elsewhere(session: string): boolean {
    return this.runSession.length > 0 && this.runSession !== session;
  }

  timeout(): void {
    if (this.closed || !this.busy) return;
    this.fail("The subagent took too long.");
  }

  /** A prompt or the start failed: the card says so, and a background run tells the main agent. */
  private fail(text: string): void {
    if (this.closed || this.reported) return;
    this.releaseVm();
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    this.idleGen++;
    this.onIdle(false);
    this.reported = true;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "failed", summary: text.split("\n")[0] });
    attempt(() => this.flush());
    attempt(() => this.persist());
    this.stopProcess(1000);
    attempt(() => this.onDone());
    if (this.background) {
      attempt(() => this.notify(text, true));
    } else this.reject(new Error(text));
  }

  private rpc(method: string, params: unknown, then: (result: Msg | null, error: string) => void): void {
    if (this.proc === null) {
      then(null, "the agent does not run");
      return;
    }
    const id = ++this.seq;
    this.waiting.push(new Waiter(id, then));
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private newSession(prompt: string): void {
    this.rpc("session/new", { cwd: this.cwd, mcpServers: [] }, (result, error) => {
      if (result === null) {
        this.fail(error.length > 0 ? error : "no session");
        return;
      }
      this.session = str(result.sessionId);
      const options = list(result.configOptions).map(obj).filter((o): o is Msg => o !== null);
      for (const o of options) if (str(o.category) === "model" || str(o.id) === "model") this.modelConfig = str(o.id);
      this.setModel(prompt);
    });
  }

  private setModel(prompt: string): void {
    if (this.model.length === 0) {
      this.prompt(prompt);
      return;
    }
    const then = (_result: Msg | null, error: string): void => {
      if (error.length > 0) this.fail(error);
      else this.prompt(prompt);
    };
    if (this.modelConfig.length > 0) this.rpc("session/set_config_option", { sessionId: this.session, configId: this.modelConfig, value: this.model }, then);
    else this.rpc("session/set_model", { sessionId: this.session, modelId: this.model }, then);
  }

  private prompt(text: string): void {
    this.busy = true;
    this.reported = false;
    this.refused = "";
    const gen = ++this.timeoutGen;
    this.api.after(this.timeoutMs, () =>
      this.guard("its timer", () => {
        if (gen === this.timeoutGen && this.busy) this.timeout();
      }),
    );
    this.rpc("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text }] }, (result, error) => {
      if (error.length > 0) {
        this.promptDone(error, true);
        return;
      }
      const stop = str(obj(result)?.stopReason);
      this.promptDone(this.reply.length > 0 ? this.reply : stop.length > 0 ? "The subagent stopped: " + stop : "The subagent said nothing.", stop === "refusal" || stop === "error");
    });
  }

  private promptDone(text: string, error: boolean): void {
    if (this.closed) return;
    this.busy = false;
    this.timeoutGen++;
    this.reported = true;
    const refused = this.refused;
    this.refused = "";
    const said = refused.length > 0 ? text + "\n\n[a permission was refused: " + refused + "]" : text;
    const summary = error ? said.split("\n")[0] : refused.length > 0 ? "a permission was refused: " + refused : this.description;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: error ? "failed" : "done", summary });
    attempt(() => this.flush());
    attempt(() => this.persist());
    if (!this.background) {
      this.closed = true;
      this.stopProcess(500);
      attempt(() => this.onDone());
      if (error) this.reject(new Error(said));
      else this.resolve(this.worktree.length > 0 ? said + "\n\n[worktree: " + this.worktree + "]" : said);
      return;
    }
    attempt(() => this.notify(this.worktree.length > 0 ? said + "\n\n[worktree: " + this.worktree + "]" : said, error));
    this.reply = "";
    this.open = "";
    this.openKind = "";
    if (this.proc === null) {
      // Its process ended as it reported: there is none to keep for a message.
      this.closed = true;
      this.idleGen++;
      this.onIdle(false);
      attempt(() => this.onDone());
      return;
    }
    this.waitingIdle();
  }

  /** Tell the main agent a background run finished or failed, when it is running to hear it. */
  /** A chunk of its stderr: each line goes into the log and under the call as a log notice. */
  private stderr(text: string): void {
    this.api.note(this.entry.name + ": " + text.trimEnd());
    const parts = (this.stderrTail + text).split("\n");
    this.stderrTail = parts.pop() ?? "";
    for (const l of parts) this.logLine(l);
    if (parts.length > 0) this.flush();
  }

  /** The last part of its stderr, if a line: the process ended. */
  private flushStderr(): void {
    const last = this.stderrTail;
    this.stderrTail = "";
    this.logLine(last);
    this.flush();
  }

  private logLine(text: string): void {
    const t = text.trimEnd();
    if (t.length === 0) return;
    // A notice with tone "log": the model keeps the last 200 under the call, and the subagent view draws them.
    this.emit({ type: "notice", parent: this.callId, tone: "log", text: t });
  }

  private notify(text: string, error: boolean): void {
    const status = error ? "failed" : "finished";
    // A run of a session left since it started tells only the log: the agent now running never started it.
    const elsewhere = this.api.agent.sessionId() !== this.runSession;
    this.api.note("background subagent " + this.callId + " " + status + (elsewhere ? " in another session" : ""));
    if (elsewhere) return;
    if (!this.api.agent.started()) return;
    const line = "[background subagent " + this.callId + " " + status + "]\n" + text;
    const r = this.api.agent.send(line, { from: "task" });
    if (r.error.length > 0) this.api.note("background subagent " + this.callId + ": " + r.error);
  }

  private line(text: string): void {
    const value = parse(text);
    const m = obj(value);
    if (m === null) return;
    const id = typeof m.id === "number" ? m.id : -1;
    if (id >= 0 && (m.result !== undefined || m.error !== undefined)) {
      const at = this.waiting.findIndex((w) => w.id === id);
      if (at < 0) return;
      const waiter = this.waiting[at];
      this.waiting.splice(at, 1);
      const error = obj(m.error);
      waiter.then(obj(m.result), error !== null ? str(error.message) : "");
      return;
    }
    const method = str(m.method);
    if (method.length === 0) return;
    const params = obj(m.params);
    if (method === "session/update") {
      if (params !== null) this.update(obj(params.update));
      return;
    }
    if (method === "session/request_permission" && params !== null) {
      this.permission(m, params);
      return;
    }
    // A run hears no user: its dialogs are answered cancelled and the rest of the UI is ignored.
    if (method === "_widecode/ui") {
      if (m.id !== undefined && m.id !== null && this.proc !== null) this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { cancelled: true } }));
      return;
    }
    if (m.id !== undefined && m.id !== null && this.proc !== null) {
      this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: method + " is not supported" } }));
    }
  }

  private update(u: Msg | null): void {
    if (u === null) return;
    if (crashOnUpdate) throw new Error("injected update failure");
    const what = str(u.sessionUpdate);
    if (what === "agent_message_chunk") this.chunk("text", u.content);
    else if (what === "agent_thought_chunk") this.chunk("thinking", u.content);
    else if (what === "tool_call") this.call(u);
    else if (what === "tool_call_update") this.call(u);
    else if (what === "plan") this.plan(u);
  }

  private chunk(kind: "text" | "thinking", content: unknown): void {
    const c = obj(content);
    const text = c !== null && c.type === "text" ? str(c.text) : "";
    if (text.length === 0) return;
    if (this.open.length > 0 && this.openKind === kind) {
      this.emit({ type: "text", key: this.open, delta: text });
    } else {
      this.open = this.key(kind + String(++this.blocks));
      this.openKind = kind;
      this.emit({ type: "block", key: this.open, kind, text });
    }
    if (kind === "text") this.reply += text;
  }

  private call(u: Msg): void {
    const id = str(u.toolCallId);
    if (id.length === 0) return;
    const known = this.calls.get(id);
    const key = known !== undefined ? known : this.key("call:" + id);
    if (known === undefined) this.calls.set(id, key);
    const kind = str(u.kind);
    const title = str(u.title);
    const input = obj(u.rawInput);
    const locations = list(u.locations).map((l) => str(obj(l)?.path)).filter((p) => p.length > 0);
    const summary = input !== null && kind === "execute" && str(input.command).length > 0 ? str(input.command).split("\n")[0] : title;
    const facts: widecode.CallFacts = { category: CATEGORY[kind] ?? "other", summary, ...(locations.length > 0 && kind !== "execute" ? { paths: locations } : {}), ...(input !== null && typeof input.command === "string" ? { command: input.command } : {}) };
    if (input !== null && typeof input.subagent_type === "string") {
      facts.category = "agent";
      facts.agentType = str(input.subagent_type);
      facts.agentTask = str(input.description);
      facts.agentPrompt = str(input.prompt);
      facts.summary = str(input.subagent_type) + ": " + str(input.description);
    }
    if (known === undefined) this.emit({ type: "block", key, kind: "tool", id: key, name: NAME[kind] ?? "Tool", text: "", ...facts });
    else this.emit({ type: "facts", id: key, ...facts });
    if (u.rawInput !== undefined) {
      const json = JSON.stringify(u.rawInput);
      if (this.inputs.get(id) !== json) {
        this.inputs.set(id, json);
        this.emit({ type: "input", key, input: u.rawInput });
      }
    }
    const status = str(u.status);
    if (status !== "completed" && status !== "failed") return;
    this.emit({ type: "result", id: key, ...resultOf(this.output(u), u.rawOutput), error: status === "failed" });
    this.emit({ type: "finish", key });
    this.inputs.delete(id);
  }

  /** A call's text from its content blocks, else from its raw output. */
  private output(u: Msg): string {
    const parts: string[] = [];
    for (const v of list(u.content)) {
      const c = obj(v);
      const inner = obj(c?.content);
      if (c !== null && c.type === "content" && inner !== null && inner.type === "text") parts.push(str(inner.text));
    }
    if (parts.length > 0) return parts.join("\n");
    const raw = obj(u.rawOutput);
    if (raw !== null) for (const k of ["output", "stdout", "result", "error"]) if (typeof raw[k] === "string") return raw[k] as string;
    return "";
  }

  private plan(u: Msg): void {
    const key = this.key("plan" + String(++this.blocks));
    const todos: { text: string; state: "done" | "doing" | "todo" }[] = [];
    for (const v of list(u.entries)) {
      const e = obj(v);
      const s = str(e?.status);
      todos.push({ text: str(e?.content), state: s === "completed" ? "done" : s === "in_progress" ? "doing" : "todo" });
    }
    this.emit({ type: "block", key, kind: "tool", id: key, name: "Plan", text: "", category: "todo", summary: String(todos.length) + " todos", todos });
    this.emit({ type: "result", id: key, text: "" });
    this.emit({ type: "finish", key });
  }

  private permission(m: Msg, params: Msg): void {
    const call = obj(params.toolCall);
    const title = call !== null && str(call.title).length > 0 ? str(call.title) : "The subagent";
    const kind = call !== null ? str(call.kind) : "";
    const locations = call !== null ? list(call.locations).map((l) => str(obj(l)?.path)).filter((p) => p.length > 0) : [];
    const options = list(params.options).map(obj).filter((o): o is Msg => o !== null).map((o) => ({ id: str(o.optionId), label: str(o.name).length > 0 ? str(o.name) : str(o.kind), detail: str(o.kind) }));
    const mode = this.api.agent.approval();
    const decision = approve(mode, kind, pathsOf(locations, call !== null ? obj(call.rawInput) : null), this.cwd);
    if (decision !== "ask") {
      const allowed = decision === "allow";
      const want = allowed ? (mode === "full" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : ["reject_once"];
      const chosen = options.find((o) => o.detail === want[0]) ?? options.find((o) => o.detail === want[1]);
      if (!allowed) this.refused = title;
      this.api.note("acp: subagent " + kind + " " + title + ": " + (allowed ? "allowed" : "rejected") + " by mode " + mode);
      const answer: unknown = chosen !== undefined ? { outcome: { outcome: "selected", optionId: chosen.id } } : { outcome: "cancelled" };
      if (this.proc !== null) this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }));
      return;
    }
    const question = title + " asks for permission";
    this.api.note("subagent " + this.callId + " asks: " + title);
    this.api.conversation
      .ask({ category: "question", name: "Task", permission: true, questions: [{ question, header: "Permission", options: options.map((o) => ({ label: o.label, description: o.detail })) }] }, this.callId)
      .then((reply) =>
        this.guard("its permission", () => {
          const label = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
          const chosen = options.find((o) => o.label === label);
          // The run's answer says a permission was refused, whether or not it went on after it.
          if (!this.closed && (chosen === undefined || chosen.detail.startsWith("reject"))) this.refused = title;
          this.api.note("subagent " + this.callId + " permission: " + (chosen !== undefined ? chosen.label : "cancelled"));
          const answer: unknown = chosen !== undefined ? { outcome: { outcome: "selected", optionId: chosen.id } } : { outcome: { outcome: "cancelled" } };
          if (this.proc !== null) this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }));
        }),
      );
  }

  private exited(code: number): void {
    this.releaseVm();
    this.proc = null;
    if (this.closed) return;
    this.flushStderr();
    if (this.reported) {
      // Its result already reached the parent: this exit only cleans up a process kept for SendMessage.
      this.closed = true;
      this.busy = false;
      this.timeoutGen++;
      this.idleGen++;
      this.onIdle(false);
      attempt(() => this.api.note("acp: task " + this.callId + ": " + this.entry.name + " ended (exit code " + String(code) + ") after its result"));
      attempt(() => this.onDone());
      return;
    }
    const text = this.entry.name + " ended (exit code " + String(code) + ")";
    if (this.busy) {
      this.promptDone(text, true);
      return;
    }
    this.closed = true;
    this.reported = true;
    this.idleGen++;
    this.onIdle(false);
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: text });
    attempt(() => this.flush());
    attempt(() => this.persist());
    attempt(() => this.onDone());
    if (this.background) {
      attempt(() => this.notify(text, true));
    } else this.reject(new Error(text));
  }
}

/** The box this plugin started, stopped when the plugin deactivates. */
let boxRunner: BoxRunner | null = null;
/** The live Task runs, by id, so deactivation stops every process they started. */
let liveRuns: Map<string, SubagentRun> = new Map();

widecode.plugin({
  id: "acp",
  defaults: () => ({ agents: DEFAULT_AGENTS }),
  activate(api) {
    crashOnUpdate = api.fs.env("WIDECODE_ACP_TEST_CRASH") === "update";
    const idleEnv = Number(api.fs.env("WIDECODE_ACP_TEST_IDLE_MS"));
    idleMs = idleEnv > 0 ? idleEnv : IDLE_MS;
    const section = api.settings.section();
    const agents = agentsOf(section);
    const tasks = tasksOf(section);
    for (const run of liveRuns.values()) run.stopQuietly("the acp plugin stopped");
    liveRuns = new Map();
    boxRunner = tasks.box !== null ? new BoxRunner(api, tasks.box) : null;
    const box = boxRunner;
    api.ui.segment({
      name: "box",
      draw: () => {
        if (tasks.targets.length === 0) return [];
        if (tasks.box === null || tasks.targets.some((t) => t.box.length === 0)) return [{ text: "unboxed", fg: widecode.theme.warn }];
        let bwrap = false;
        let vm = false;
        for (const t of tasks.targets) {
          if (t.box === "vm") vm = true;
          else bwrap = true;
        }
        return [{ text: bwrap && vm ? "boxed: mixed" : vm ? "boxed: vm" : "boxed: bwrap", fg: widecode.theme.ok }];
      },
    });
    /** The ACP main's calls of widecode's Task tool that are in flight, which the Task tool runs under. */
    const taskCalls = new TaskCalls();
    for (const id of Object.keys(agents)) api.agents.register(acpAgent(api, id, agents[id], taskCalls));
    // Sessions made and left by widecode processes gone (one quit without writing to its session).
    sweep(api, agents, "");
    if (tasks.targets.length === 0) return;
    /** The live runs by id: a background run can be messaged or stopped after its call answered. */
    const runs = liveRuns;
    /** The idle background runs, oldest first, so the pool stops its oldest past MAX_IDLE_RUNS. */
    const idleRuns: string[] = [];
    const idleChanged = (id: string, idle: boolean): void => {
      const at = idleRuns.indexOf(id);
      if (idle) {
        if (at < 0) idleRuns.push(id);
      } else if (at >= 0) idleRuns.splice(at, 1);
      while (idleRuns.length > MAX_IDLE_RUNS) {
        const oldest = idleRuns.shift();
        if (oldest === undefined) break;
        const run = runs.get(oldest);
        if (run !== undefined && run.idle()) run.retire();
      }
    };
    /** The parent session the runs belong to: a run of a session left since is stopped. */
    let parentSession = api.agent.sessionId();
    api.on("conversationChanged", () => {
      const now = api.agent.sessionId();
      if (now === parentSession) return;
      parentSession = now;
      for (const [id, run] of runs) {
        if (!run.elsewhere(now)) continue;
        run.stopQuietly("its session was left");
        runs.delete(id);
      }
    });
    /** Worktrees being made for a run not started yet. */
    let preparing = 0;
    /** The runs working now: an idle background run waits for a message and holds no place. */
    const working = (): number => {
      let n = preparing;
      for (const run of runs.values()) if (run.working()) n++;
      return n;
    };
    const names = tasks.targets.map((t) => t.name);
    api.tools.add({
      name: "Task",
      description: "Run a subagent in another agent and model, in this folder or the one `cwd` names (a boxed target only in a folder its box shares). Targets: " + tasks.targets.map((t) => t.name + " (" + t.agent + (t.model.length > 0 ? " " + t.model : "") + ")").join(", ") + ". The subagent is not Claude: it runs on the target's model, its steps show under the call, and its final answer is the result. With run_in_background it starts and answers at once; the call id is its id for TaskStop and SendMessage, and its end comes back as a message.",
      category: "agent",
      input: { type: "object", properties: { description: { type: "string", description: "A short label for the call." }, prompt: { type: "string", description: "The whole task for the subagent." }, subagent_type: { type: "string", enum: names, description: "Which target to run." }, model: { type: "string", description: "A model for this call, overriding the target's." }, cwd: { type: "string", description: "The folder it works in, absolute or relative to the session's; the session's folder when left out." }, name: { type: "string", description: "A display name." }, isolation: { type: "string", enum: ["worktree"], description: "Run it in a git worktree of its folder." }, run_in_background: { type: "boolean", description: "Start it and answer at once; it goes on after this turn." } }, required: ["description", "prompt"] },
      call: (args, ctx) => {
        const wanted = str(args.subagent_type).length > 0 ? str(args.subagent_type) : names[0] ?? "";
        const target = tasks.targets.find((t) => t.name === wanted);
        if (target === undefined) throw new Error("no subagent type " + wanted + "; it has " + names.join(", "));
        const entry = agents[target.agent];
        if (entry === undefined) throw new Error("no agent " + target.agent + " for " + wanted);
        const prompt = str(args.prompt);
        if (prompt.length === 0) throw new Error("a subagent needs a prompt");
        const folder = api.state.active().folder;
        const bare = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);
        const asked = bare(str(args.cwd));
        // A relative folder is the session's; a boxed run works only in a folder its box shares.
        const joined = asked.length === 0 ? bare(folder) : asked.startsWith("/") ? asked : bare(folder) + "/" + asked;
        const where = bare(joined.split("/").filter((s) => s !== ".").join("/")) || "/";
        if (where.split("/").includes("..")) throw new Error("a subagent's folder is a path without ..: " + asked);
        if (target.box.length > 0 && box !== null) {
          const shared = [bare(folder), ...box.config.projects.map(bare)];
          if (!shared.some((p) => where === p || where.startsWith(p + "/"))) throw new Error("a boxed subagent runs in a folder its box shares (" + shared.join(", ") + "), not " + where + "; add the folder to the box's projects in config.json");
        }
        const isolation = str(args.isolation);
        if (isolation.length > 0 && isolation !== "worktree") throw new Error("isolation is \"worktree\" or none");
        if (working() >= tasks.maxConcurrent) throw new Error("too many subagents run (" + String(tasks.maxConcurrent) + ")");
        const description = str(args.description).length > 0 ? str(args.description) : str(args.name);
        // An ACP main names no tool-use id, but it announces the call itself: the run goes under that
        // card when its input is this one. A card made here needs an id no earlier run took.
        const claimed = ctx.toolUseId.length === 0 ? taskCalls.claim(prompt, description) : "";
        const synthetic = ctx.toolUseId.length === 0 && claimed.length === 0;
        const id = ctx.toolUseId.length > 0 ? ctx.toolUseId : claimed.length > 0 ? claimed : "task-" + Date.now().toString(36) + "-" + ctx.callId;
        const startRun = (cwd: string, worktree: string, boxFolder: string, onClose?: () => void): Promise<string> => {
          const run = new SubagentRun(api, entry, target, box, boxFolder, cwd, worktree, str(args.model).length > 0 ? str(args.model) : target.model, id, description, synthetic, args.run_in_background === true, tasks.timeoutMs, () => {
            runs.delete(id);
            if (onClose !== undefined) onClose();
          }, (idle) => idleChanged(id, idle));
          if (!run.createCard()) throw new Error("the main agent cannot take a subagent card");
          runs.set(id, run);
          ctx.onCancel(() => run.cancel());
          return run.start(prompt);
        };
        if (isolation !== "worktree") return startRun(where, "", folder);
        const part = id.replace(/[^A-Za-z0-9_.-]/g, "_");
        const path = where + "/.worktrees/" + part;
        const branch = "widecode/task-" + part;
        preparing++;
        const made = (): void => {
          preparing--;
        };
        let cancelled = false;
        ctx.onCancel(() => {
          cancelled = true;
        });
        let baselineStatus = "";
        let baselineHead = "";
        let cleaned = false;
        const removeWorktree = (): Promise<void> => {
          if (cleaned) return Promise.resolve();
          cleaned = true;
          return api.process.run("git -C " + quote(where) + " worktree remove --force " + quote(path), "", 15000).then(() => api.process.run("git -C " + quote(where) + " branch -D " + quote(branch), "", 15000).then(() => {}));
        };
        const worktreeOver = (): Promise<boolean> =>
          api.process.run("git -C " + quote(path) + " status --porcelain", "", 15000).then((s) =>
            api.process.run("git -C " + quote(path) + " rev-list --count " + quote(baselineHead) + "..HEAD", "", 15000).then((h) => {
              if (s.code !== 0 || h.code !== 0 || s.out !== baselineStatus || h.out.trim() !== "0") return false;
              return removeWorktree().then(() => true);
            }),
          );
        const keptLine = "\n\n[worktree: " + path + " (branch " + branch + ")]";
        const goneLine = "\n\n[worktree removed: no changes]";
        const withLine = (text: string, removed: boolean): string => {
          if (text.endsWith(goneLine)) return removed ? text : text.slice(0, text.length - goneLine.length) + keptLine;
          if (text.endsWith(keptLine)) return removed ? text.slice(0, text.length - keptLine.length) + goneLine : text;
          return text + (removed ? goneLine : keptLine);
        };
        const background = args.run_in_background === true;
        const prepared = async (): Promise<string> => {
          try {
            const gitDir = await api.process.run("git -C " + quote(where) + " rev-parse --absolute-git-dir", "", 15000);
            if (gitDir.code !== 0) throw new Error("cannot make a worktree: " + (gitDir.err.trim().length > 0 ? gitDir.err.trim() : gitDir.out.trim()));
            const exclude = quote(gitDir.out.trim() + "/info/exclude");
            const ignoring = await api.process.run("mkdir -p " + quote(where + "/.worktrees") + " && mkdir -p " + quote(gitDir.out.trim() + "/info") + " && (grep -qxF .worktrees/ " + exclude + " || printf '%s\\n' .worktrees/ >> " + exclude + ")", "", 15000);
            if (ignoring.code !== 0) throw new Error("cannot ignore .worktrees/: " + (ignoring.err.trim().length > 0 ? ignoring.err.trim() : ignoring.out.trim()));
            const added = await api.process.run("git -C " + quote(where) + " worktree add -b " + quote(branch) + " " + quote(path), "", 15000);
            if (cancelled) return "The subagent was stopped before it started.";
            if (added.code !== 0) throw new Error("cannot make a worktree: " + (added.err.trim().length > 0 ? added.err.trim() : added.out.trim()));
            // The setup lines are the session folder's, so a worktree of another folder runs none.
            for (const setupLine of where === bare(folder) ? tasks.worktreeSetup : []) {
              // In the worktree: process.run runs where widecode was started.
              const command = "cd " + quote(path) + " && env WIDECODE_FOLDER=" + quote(folder) + " WIDECODE_WORKTREE=" + quote(path) + " sh -c " + quote(setupLine);
              const done = await api.process.run(command, "", tasks.worktreeSetupTimeoutMs);
              if (cancelled) return "The subagent was stopped before it started.";
              if (done.code !== 0) {
                await removeWorktree();
                throw new Error("worktree setup failed: " + setupLine + ": " + (done.err.trim().length > 0 ? done.err.trim() : done.out.trim()));
              }
            }
            const status = await api.process.run("git -C " + quote(path) + " status --porcelain", "", 15000);
            const head = await api.process.run("git -C " + quote(path) + " rev-parse HEAD", "", 15000);
            baselineStatus = status.out;
            baselineHead = head.out.trim();
            if (cancelled) return "The subagent was stopped before it started.";
            const started = startRun(path, path + " (branch " + branch + ")", folder, background ? () => {
              void worktreeOver().then((removed) => api.note(removed ? "worktree removed: no changes" : "worktree kept: " + path + " (branch " + branch + ")"));
            } : undefined);
            if (background) return started;
            return started.then(
              (text) => worktreeOver().then((removed) => withLine(text, removed)),
              (e: unknown) => worktreeOver().then((removed) => {
                throw new Error(withLine(e instanceof Error ? e.message : String(e), removed));
              }),
            );
          } finally {
            made();
          }
        };
        return prepared();
      },
    });
    api.tools.add({
      name: "TaskStop",
      description: "Stop a subagent started with Task, by its task_id.",
      input: { type: "object", properties: { task_id: { type: "string", description: "The id Task answered, or the call id." } }, required: ["task_id"] },
      call: (args) => {
        const id = str(args.task_id);
        const run = runs.get(id);
        if (run === undefined) throw new Error("no subagent " + id);
        run.cancel();
        return "stopped " + id;
      },
    });
    api.tools.add({
      name: "SendMessage",
      description: "Send a message to an idle background subagent started with Task, by its task_id.",
      input: { type: "object", properties: { task_id: { type: "string", description: "The id Task answered, or the call id." }, message: { type: "string", description: "What to tell the subagent." } }, required: ["task_id", "message"] },
      call: (args) => {
        const id = str(args.task_id);
        const run = runs.get(id);
        if (run === undefined) throw new Error("no subagent " + id);
        if (!run.working() && working() >= tasks.maxConcurrent) throw new Error("too many subagents run (" + String(tasks.maxConcurrent) + ")");
        const why = run.send(str(args.message));
        if (why.length > 0) throw new Error(why);
        return "sent to " + id;
      },
    });
  },
  deactivate() {
    for (const run of liveRuns.values()) run.stopQuietly("the acp plugin stopped");
    liveRuns.clear();
    if (boxRunner !== null) boxRunner.stop();
    boxRunner = null;
  },
});

export {};
