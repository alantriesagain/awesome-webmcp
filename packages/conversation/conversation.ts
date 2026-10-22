// The conversation, whichever agent it is with: the model the views draw (model.ts), the status the
// band shows (status-info.ts), the session's title, the commit it started on and its record in
// widecode's store, and the agent (conversation/agent.ts) that does what the user asks: it starts its
// process, writes what the user sends, reads its messages into the model, and keeps its sessions.
// A conversation is new (the agent starts on the first message) or resumes a session, which the
// agent shows and resumes on the next message. widecode's own tools put requests to the user here
// too (asks): their replies go to the tool, not the agent.
import { Agent, ImageBlock } from "./agent.ts";
import { openRequest } from "./events.ts";
import { AGENT, ChatModel, Item, NOTICE, PROMPT, TEXT, THINKING, TOOL } from "./model.ts";
import { Ask, Reply, replyText } from "./requests.ts";
import { StatusInfo } from "./status-info.ts";
import { SessionStore } from "./session-store.ts";


export class Exchange {
  prompt = "";
  reply = "";
}

export class Conversation {
  model = new ChatModel();
  /** The folder it works in. */
  readonly folder: string;
  /** The agent it talks to (Claude Code unless another was chosen). */
  agent: Agent;
  /** The command that runs the agent ("" for its own default), and flags added to it (tests: a fake's fixture, `--no-session-persistence`). */
  executable = "claude";
  extraArgs: string[] = [];
  /** The model alias for the agent's next start ("opus[1m]"); "" for its default. */
  modelName = "";
  effort = "";
  /** The session the next start resumes ("" for a new one). */
  resumeId = "";
  title = "";
  /** The commit HEAD was on when this new session's first message went (kept as its record's baseCommit). */
  headAtStart = "";
  /** Called when the model changed (the view redraws on the next frame). */
  onChange: (() => void) | null = null;
  /** Called with lines worth logging and showing: process events, errors. */
  onNote: ((text: string) => void) | null = null;
  /** Called with every line written to the agent (tests read the exact text here). */
  onWrite: ((line: string) => void) | null = null;
  /** The app's session records (null: nothing is kept, as with --ephemeral). */
  store: SessionStore | null = null;
  /** What the status bar shows about this session. */
  info = new StatusInfo();
  /** The requests widecode's own tools put to the user, by request id. */
  private asks = new Map<string, Ask>();
  private askSeq = 0;

  constructor(folder: string) {
    this.folder = folder;
    // None until a plugin's is chosen (Claude Code's comes with the built-in claude plugin).
    this.agent = new Agent();
  }

  get started(): boolean {
    return this.agent.started();
  }

  /** The agent was started and has said nothing yet (it loads the session it resumes). */
  get starting(): boolean {
    return this.agent.starting();
  }

  get running(): boolean {
    return this.model.running || this.model.pending.length > 0;
  }

  /** The model `name` as the status names it before the agent reports one: for an agent that takes any (Claude Code's aliases), or one it offers; "" else. */
  modelHintFor(name: string): string {
    const choices = this.agent.choices();
    if (choices.anyModel) return name;
    for (const o of choices.models) if (o.value === name) return name;
    return "";
  }

  /** Tell the view the model changed. */
  changed(): void {
    const fn = this.onChange;
    if (fn !== null) fn();
  }

  note(text: string): void {
    const fn = this.onNote;
    if (fn !== null) fn(text);
  }

  /** A fresh status, with the last rate limits widecode saw and the session's stored cost. */
  freshInfo(): StatusInfo {
    const info = new StatusInfo();
    info.effort = this.effort;
    info.modelHint = this.modelHintFor(this.modelName);
    info.cwd = this.folder;
    const store = this.store;
    if (store !== null) {
      const l = store.limits();
      info.fiveHourPct = l.fiveHour.usedPercent;
      info.fiveHourResets = l.fiveHour.resetsAt;
      info.weekPct = l.sevenDay.usedPercent;
      info.weekResets = l.sevenDay.resetsAt;
    }
    return info;
  }

  /** Start the agent's process and session now when the agent does that before any message (its choices come with its session); a failure is noted. */
  prepare(): void {
    const error = this.agent.prepare();
    if (error.length > 0) this.note("cannot start " + this.agent.name() + ": " + error);
  }

  /** Stop the agent and start over with an empty chat. */
  reset(): void {
    this.agent.reset();
    this.settleAsks(true);
    this.info = this.freshInfo();
    this.model = new ChatModel();
    this.resumeId = "";
    this.title = "";
    this.headAtStart = "";
    this.changed();
  }

  /** Show session `id`; the next message resumes it. */
  resume(id: string, title: string): void {
    this.reset();
    this.resumeId = id;
    this.title = title;
    // The model the session ran on, as widecode last started or switched it.
    const store = this.store;
    const meta = store !== null ? store.session(id, this.folder) : null;
    if (meta !== null && meta.model.length > 0) this.modelName = meta.model;
    // Named by that model until the agent reports one, its window the one stored.
    this.info.modelHint = this.modelHintFor(this.modelName);
    if (meta !== null && meta.contextWindow > 0) this.info.knownWindow = meta.contextWindow;
    this.agent.resume(id);
    this.changed();
  }

  /** Read the part of the session before the part shown; false when there is none. */
  loadEarlier(): boolean {
    const model = this.model;
    const info = this.info;
    this.model = new ChatModel();
    this.info = this.freshInfo();
    try {
      if (this.agent.loadEarlier()) return true;
    } catch {
      // Fall through: put back what was there.
    }
    this.model = model;
    this.info = info;
    return false;
  }

  /** A line from the agent's process, as if it had written it (tests, replays). */
  receive(line: string): void {
    this.agent.receive(line);
  }

  /** The session's id: the agent's once it reported one, else the one being resumed. */
  get sessionId(): string {
    const id = this.agent.sessionId();
    return id.length > 0 ? id : this.resumeId;
  }

  /** The session's first prompt and the start of the agent's first answer, for a title. */
  firstExchange(): Exchange {
    const e = new Exchange();
    for (const t of this.model.turns) {
      const p = t.prompt;
      if (p === null || p.kind !== PROMPT || p.text.trim().length === 0) continue;
      e.prompt = p.text;
      for (const item of t.body.children)
        if (item.kind === TEXT && item.text.trim().length > 0) {
          e.reply = item.text;
          break;
        }
      break;
    }
    return e;
  }

  /** Send a message (queued by the agent while a turn runs). Answers "" or why it could not. */
  send(text: string, images: ImageBlock[]): string {
    return this.agent.send(text, images);
  }

  /** Switch the agent's mode (plan mode and back); starts the agent when it is not running. Answers "" or why not. */
  setMode(mode: string): string {
    return this.agent.setMode(mode);
  }

  /** The model for this session: live when the agent runs, else for its start; kept in the session's record. */
  setModel(name: string): void {
    this.modelName = name;
    // Named by the alias until the agent answers with the new model; its window is the alias's.
    this.info.modelHint = name;
    this.info.modelId = "";
    this.info.contextSize = 0;
    this.info.knownWindow = 0;
    this.agent.setModel(name);
    const store = this.store;
    const id = this.sessionId;
    if (store !== null && id.length > 0) {
      const meta = store.sessionOrNew(id, this.folder);
      meta.model = name;
      meta.contextWindow = 0;
      meta.agent = this.agent.id();
      store.saveSession(meta);
    }
    this.changed();
  }

  setEffort(level: string): void {
    this.effort = level;
    this.info.effort = level;
    this.agent.setEffort(level);
    this.changed();
  }

  /** Read what the subagent that call `item` ran did into its card. Answers whether it was found. */
  loadSubagent(item: Item): boolean {
    return this.agent.loadSubagent(item);
  }

  /** A press on `item` in a pane: a tool call, a thought or a notice opens or closes; a subagent's card opening with nothing in it yet loads its transcript. Answers a notice for the user, "" for none. */
  toggle(item: Item): string {
    if (item.kind !== TOOL && item.kind !== THINKING && item.kind !== NOTICE) return "";
    item.expanded = !item.expanded;
    const missing = item.expanded && item.kind === TOOL && item.category === AGENT && item.children.length === 0 && !this.loadSubagent(item);
    this.model.touch(item);
    return missing ? "no transcript for this subagent" : "";
  }

  interrupt(): void {
    this.agent.interrupt();
  }

  /** Take back the messages queued and not yet taken up; "" or why not (their texts come in the model's `withdrawn`). */
  withdraw(): string {
    return this.agent.withdraw();
  }

  /** Ask the agent a side question, answered in the chat apart from the conversation; "" or why not. */
  sideQuestion(question: string): string {
    return this.agent.sideQuestion(question);
  }

  /** Answer request `item` with the user's reply: the tool's that asked, else the agent's. */
  respond(item: Item, reply: Reply): void {
    const ask = this.asks.get(item.requestId);
    if (ask === undefined) {
      this.agent.respond(item, reply);
      return;
    }
    this.asks.delete(item.requestId);
    this.model.settle(item.requestId, reply.state);
    const fn = ask.onReplied;
    if (fn !== null) fn(replyText(reply));
    this.changed();
  }

  /** Put `request` (a request event's fields) to the user for one of widecode's own tools; `ask` hears the reply. */
  ask(ask: Ask, request: unknown): void {
    const id = "ask" + String(++this.askSeq);
    if (openRequest(this.model, id, request) === null) {
      const fn = ask.onReplied;
      if (fn !== null) fn(replyText(new Reply("cancelled")));
      return;
    }
    this.asks.set(id, ask);
    this.changed();
  }

  /** Asks whose request went away (its turn ended) are answered "cancelled"; with `all`, every one, its request withdrawn. */
  settleAsks(all: boolean): void {
    if (this.asks.size === 0) return;
    const open = new Set<string>();
    if (!all) for (const item of this.model.openRequests()) open.add(item.requestId);
    for (const id of Array.from(this.asks.keys())) {
      if (open.has(id)) continue;
      const ask = this.asks.get(id);
      this.asks.delete(id);
      this.model.cancelRequest(id);
      const fn = ask !== undefined ? ask.onReplied : null;
      if (fn !== null) fn(replyText(new Reply("cancelled")));
    }
  }

  write(line: string): void {
    this.agent.write(line);
  }

  /** Let the agent end after its turn, killing it after a grace period. */
  stop(): void {
    this.agent.stop();
  }

  kill(): void {
    this.agent.kill();
  }
}
