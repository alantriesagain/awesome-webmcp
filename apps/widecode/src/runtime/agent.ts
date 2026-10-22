// An agent a plugin brings (api.agents.register): the conversation's agent role (@widecode/conversation/agent.ts)
// played by the plugin's functions. What the user does reaches them as JSON; the plugin writes to
// its agent's process (api.process.spawn) and hands its agent's messages to the conversation as
// neutral events (api.conversation.apply, conversation/events.ts). A `process` event says when the
// agent's process ran and ended, so the screen knows whether it runs, and whether it has said
// anything since it started.
import type { Conversation } from "@widecode/conversation/conversation.ts";
import { Agent, Choices, ImageBlock, Option } from "@widecode/conversation/agent.ts";
import { Item } from "@widecode/conversation/model.ts";
import { Reply, replyText } from "@widecode/conversation/requests.ts";
import { Bridge, OK } from "@light/plugins/engine.ts";
import { AGENT_SLOTS, slotOf } from "./slots.ts";

/** The plugin's functions, by their place in what ui.agents.register passes. */
const START = slotOf(AGENT_SLOTS, "start");
const SEND = slotOf(AGENT_SLOTS, "send");
const INTERRUPT = slotOf(AGENT_SLOTS, "interrupt");
const SET_MODE = slotOf(AGENT_SLOTS, "setMode");
const SET_MODEL = slotOf(AGENT_SLOTS, "setModel");
const SET_EFFORT = slotOf(AGENT_SLOTS, "setEffort");
const RESPOND = slotOf(AGENT_SLOTS, "respond");
const RESUME = slotOf(AGENT_SLOTS, "resume");
const RESET = slotOf(AGENT_SLOTS, "reset");
const STOP = slotOf(AGENT_SLOTS, "stop");
const KILL = slotOf(AGENT_SLOTS, "kill");
const LOAD_EARLIER = slotOf(AGENT_SLOTS, "loadEarlier");
const RECEIVE = slotOf(AGENT_SLOTS, "receive");
const SESSIONS = slotOf(AGENT_SLOTS, "sessions");
const LOAD_SUBAGENT = slotOf(AGENT_SLOTS, "loadSubagent");
const WITHDRAW = slotOf(AGENT_SLOTS, "withdraw");
const SIDE_QUESTION = slotOf(AGENT_SLOTS, "sideQuestion");
export const FNS = AGENT_SLOTS.length;

/** A session's history read into the conversation (a resume, the part before, a subagent's) may take this long. */
const HISTORY_BUDGET_MS = 2000;

const json = (v: string): string => JSON.stringify(v);

/** An event or a field of one, read for the process state and the agent's choices. */
interface ProcessEvent {
  type?: unknown;
  state?: unknown;
  models?: unknown;
  efforts?: unknown;
  modes?: unknown;
  anyModel?: unknown;
  value?: unknown;
  name?: unknown;
}

/** A `choices` event's list ({ value, name }), null when the event leaves it out. */
const optionsOf = (v: unknown): Option[] | null => {
  if (!Array.isArray(v)) return null;
  const out: Option[] = [];
  for (const x of v as unknown[]) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as ProcessEvent;
    if (typeof o.value !== "string") continue;
    out.push(new Option(o.value, typeof o.name === "string" && o.name.length > 0 ? o.name : o.value));
  }
  return out;
};

export class JsAgent extends Agent {
  readonly runtime: Bridge;
  readonly agentId: string;
  readonly agentName: string;
  readonly fns: number[];
  /** The conversation it plays the agent for (set when it is chosen). */
  conversation: Conversation | null = null;
  /** Its process runs (between the plugin's `process` events), and has said something since it started. */
  private running = false;
  private heard = false;
  /** Moves each time the plugin says its sessions changed (a `sessions` event). */
  sessionsRev = 0;
  /** What the agent's system prompt gets appended at its start (the harness), null for nothing. */
  onSystemPrompt: (() => string) | null = null;
  /** The tool permission rules the agent starts with, as `{"allow":[],"ask":[],"deny":[]}` text. */
  onPermissions: (() => string) | null = null;
  /** The models, efforts and modes the plugin said its agent offers (a `choices` event). */
  readonly offered = new Choices();
  /** Starts at launch, after /new and in a folder opened, not on the first message: its session brings its choices (the adapter said so). */
  eager = false;

  constructor(runtime: Bridge, owner: string, id: string, name: string, fns: number[]) {
    super();
    this.runtime = runtime;
    this.owner = owner;
    this.agentId = id;
    this.agentName = name.length > 0 ? name : id;
    this.fns = fns;
  }

  /** The plugins load again: this instance's functions are gone (the new load registers the agent again). */
  retire(): void {
    for (let i = 0; i < this.fns.length; i++) this.fns[i] = -1;
    this.running = false;
  }

  /** Play the agent for `conversation`; its process, if any, belongs to the one before. */
  override attach(conversation: Conversation): void {
    this.conversation = conversation;
    this.running = false;
    this.heard = false;
  }

  override id(): string {
    return this.agentId;
  }

  override name(): string {
    return this.agentName;
  }

  override started(): boolean {
    return this.running;
  }

  override choices(): Choices {
    return this.offered;
  }

  override starting(): boolean {
    return this.running && !this.heard;
  }

  override prepare(): string {
    return this.eager ? this.ensureStarted() : "";
  }

  /** Call the plugin's function `which` with `args` (a JSON array's text); its answer's JSON text, "" when it has none or failed. A history read has a longer budget. */
  private call(which: number, args: string): string {
    const fn = this.fns[which];
    if (fn < 0) return "";
    const long = which === RESUME || which === LOAD_EARLIER || which === LOAD_SUBAGENT || which === SESSIONS;
    const r = long ? this.runtime.invokeLong(this.owner, fn, args, HISTORY_BUDGET_MS) : this.runtime.invoke(this.owner, fn, args);
    return r.status === OK ? r.text : "";
  }

  /** An answer that is a string ("" or an error), "" for anything else. */
  private text(answer: string): string {
    if (answer.length === 0) return "";
    try {
      const v = JSON.parse(answer) as unknown;
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  }

  /** The events a plugin applied: the process's state, and that the agent said something. */
  sawEvents(events: unknown): void {
    if (!Array.isArray(events)) return;
    for (const v of events as unknown[]) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as ProcessEvent;
      // Anything but its process's state is the agent saying something.
      if (e.type !== "process") this.heard = true;
      if (e.type === "sessions") this.sessionsRev++;
      if (e.type === "choices") this.offer(e);
      if (e.type !== "process") continue;
      if (e.state === "running") this.running = true;
      else if (e.state === "ended") this.running = false;
    }
  }

  /** What the agent offers, as a `choices` event or its registration names it (a list left out stays). */
  offer(v: unknown): void {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return;
    const e = v as ProcessEvent;
    const models = optionsOf(e.models);
    const efforts = optionsOf(e.efforts);
    const modes = optionsOf(e.modes);
    if (models !== null) this.offered.models = models;
    if (efforts !== null) this.offered.efforts = efforts;
    if (modes !== null) this.offered.modes = modes;
    if (typeof e.anyModel === "boolean") this.offered.anyModel = e.anyModel;
  }

  /** Start the plugin's agent when it does not run: "" or why it could not. */
  private ensureStarted(): string {
    const c = this.conversation;
    if (c === null) return "no conversation";
    if (this.running) return "";
    const args: string[] = [];
    for (const a of c.extraArgs) args.push(json(a));
    const fn = this.onSystemPrompt;
    const pfn = this.onPermissions;
    const options = '{"cwd":' + json(c.folder) + ',"model":' + json(c.modelName) + ',"effort":' + json(c.effort) + ',"resume":' + json(c.resumeId) + ',"executable":' + json(c.executable) + ',"systemPrompt":' + json(fn !== null ? fn() : "") + ',"permissions":' + (pfn !== null ? pfn() : '{"allow":[],"ask":[],"deny":[]}') + ',"args":[' + args.join(",") + "]}";
    this.heard = false;
    const error = this.text(this.call(START, "[" + options + "]"));
    if (error.length === 0) this.running = true;
    return error;
  }

  override reset(): void {
    this.call(RESET, "[]");
    this.running = false;
  }

  override resume(id: string): void {
    this.call(RESUME, "[" + json(id) + "]");
  }

  /** The plugin reads the part before and applies everything again; the conversation put a fresh model in place first. */
  override loadEarlier(): boolean {
    if (this.conversation === null || this.fns[LOAD_EARLIER] < 0) return false;
    return this.call(LOAD_EARLIER, "[]") === "true";
  }

  override loadSubagent(item: Item): boolean {
    return this.call(LOAD_SUBAGENT, "[" + json(item.id) + "]") === "true";
  }

  override sessionId(): string {
    const c = this.conversation;
    return c !== null ? c.model.sessionId : "";
  }

  override receive(line: string): void {
    this.call(RECEIVE, "[" + json(line) + "]");
  }

  override send(text: string, images: ImageBlock[]): string {
    const c = this.conversation;
    if (c === null) return "no conversation";
    const error = this.ensureStarted();
    if (error.length > 0) return error;
    c.model.send(text, images.length);
    const imgs: string[] = [];
    for (const i of images) imgs.push('{"mediaType":' + json(i.mediaType) + ',"data":' + json(i.data) + ',"path":' + json(i.path) + "}");
    const sent = this.text(this.call(SEND, "[" + json(text) + ",[" + imgs.join(",") + "]]"));
    c.changed();
    return sent;
  }

  override interrupt(): void {
    if (this.running) this.call(INTERRUPT, "[]");
  }

  override setMode(mode: string): string {
    const error = this.ensureStarted();
    if (error.length > 0) return error;
    return this.text(this.call(SET_MODE, "[" + json(mode) + "]"));
  }

  override setModel(name: string): void {
    this.call(SET_MODEL, "[" + json(name) + "]");
  }

  override withdraw(): string {
    if (this.fns[WITHDRAW] < 0) return this.name() + " cannot take back a queued message";
    return this.text(this.call(WITHDRAW, "[]"));
  }

  override sideQuestion(question: string): string {
    if (this.fns[SIDE_QUESTION] < 0) return this.name() + " has no side questions";
    const error = this.ensureStarted();
    if (error.length > 0) return error;
    return this.text(this.call(SIDE_QUESTION, "[" + json(question) + "]"));
  }

  override setEffort(level: string): void {
    this.call(SET_EFFORT, "[" + json(level) + "]");
  }

  override respond(item: Item, reply: Reply): void {
    const c = this.conversation;
    if (c === null) return;
    const request = '{"id":' + json(item.requestId) + ',"category":' + json(item.category) + ',"name":' + json(item.name) + ',"callId":' + json(item.toolUseId) + "}";
    this.call(RESPOND, "[" + request + "," + replyText(reply) + "]");
    c.model.settle(item.requestId, reply.state);
    c.changed();
  }

  override stop(): void {
    this.call(STOP, "[]");
    this.running = false;
  }

  override kill(): void {
    this.call(KILL, "[]");
    this.running = false;
  }

  /** The plugin's sessions in `folder` as it lists them now (JSON text of an array), "[]" for none. */
  sessions(folder: string): string {
    const answer = this.call(SESSIONS, "[" + json(folder) + "]");
    return answer.startsWith("[") ? answer : "[]";
  }
}
