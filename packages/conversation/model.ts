// The conversation as data, whichever agent it is with. A turn holds a prompt and a body of items
// (text, thinking, tool calls, notices, prompts sent while the agent worked, requests for the
// user); a tool call that ran a subagent holds the subagent's items as its children. Messages the
// user sent wait in a queue until the agent takes them up. An agent's adapter turns its messages
// into the calls below (apps/widecode/plugins/claude/index.ts for Claude Code); the views read the result.
//
// Natively every item is one `Item` class told apart by `kind`, since a subclass would lose its
// identity through base-typed collections.
import { Line } from "@lightstart/light/native/tui/lines.ts";
import { signal } from "@lightstart/light/signals";
import { Question } from "./requests.ts";

export const TEXT = 0;
export const THINKING = 1;
export const TOOL = 2;
export const PROMPT = 3;
export const NOTICE = 4;
export const REQUEST = 5;
export const GROUP = 6;

/** One hunk of a change a call made: lines prefixed with " ", "-" or "+". */
export class PatchHunk {
  oldStart: number;
  newStart: number;
  lines: string[];

  constructor(oldStart: number, newStart: number, lines: string[]) {
    this.oldStart = oldStart;
    this.newStart = newStart;
    this.lines = lines;
  }
}

export class ToolResult {
  text = "";
  isError = false;
  images = 0;
  /** The full result's length in characters, the note's count when the agent only saw a cut one. */
  size = 0;
  /** Who cut the result: "agent", "widecode", or "" for none. */
  truncated = "";
  /** The change the call made (an edit's hunks); empty for other calls. */
  patch: PatchHunk[] = [];
  hasPatch = false;
}

/**
 * A tool the agent has: its name, the MCP server it comes from ("" for the agent's own), the name
 * its calls carry (`id`), and what the mode lets it do: `access` "" (anything), "asks" (each call
 * asks the user), "limited" (only what `scope` names), "denied" (the agent does not offer it).
 */
export class ToolInfo {
  readonly name: string;
  readonly server: string;
  id: string;
  access = "";
  scope = "";

  constructor(name: string, server: string) {
    this.name = name;
    this.server = server;
    this.id = name;
  }
}

/**
 * A skill the agent has: its name, what it is for, where it comes from ("project", "user", a
 * plugin's name, "built-in"), its file ("" for one built into the agent) and the text that calls it
 * from the composer ("/name" for Claude Code; "" for an agent whose skills are asked for in words).
 */
export class SkillInfo {
  readonly name: string;
  description = "";
  source = "";
  path = "";
  command = "";

  constructor(name: string) {
    this.name = name;
  }
}

/** An MCP server the agent was given, and where it stands ("connected", "pending", "failed", "" when unknown). */
export class ServerInfo {
  readonly name: string;
  readonly status: string;

  constructor(name: string, status: string) {
    this.name = name;
    this.status = status;
  }
}

/** A call that runs on as a task of its own (a subagent in the background). */
export class TaskInfo {
  taskId = "";
  description = "";
  subagentType = "";
  background = false;
  status = "running";
  lastTool = "";
  summary = "";
}

/** One entry of a todo call's list: its words, and "done", "doing" or "todo". */
export class Todo {
  text: string;
  state: string;

  constructor(text: string, state: string) {
    this.text = text;
    this.state = state;
  }
}

/** What a call does, as the views tell calls apart (an adapter maps its tools to these). */
export const READ = "read";
export const EDIT = "edit";
export const RUN = "run";
export const SEARCH = "search";
export const FETCH = "fetch";
export const AGENT = "agent";
export const TODO = "todo";
export const QUESTION = "question";
export const PLAN = "plan";
/** A call that loads a skill (Claude Code's Skill tool, opencode's skill tool): its summary is the skill's name. */
export const SKILL = "skill";
export const OTHER = "other";

export class Item {
  kind: number;
  id: string;
  turn: Turn | null = null;
  /** The tool (or turn body) this item is under; a change to it invalidates that card's lines too. */
  parent: Item | null = null;
  rev = 0;
  /** Text, thinking, a prompt's or notice's words. */
  text = "";
  done = false;
  /** Thinking's size (redacted thinking has no text). */
  tokens = 0;
  /** A tool's name; a request's tool. */
  name = "";
  /** The tool a call is of, as the agent's list of tools names it, when its name is another (an ACP call's is its kind). */
  tool = "";
  input: unknown = null;
  /** A tool's input JSON while it streams. */
  partial = "";
  result: ToolResult | null = null;
  task: TaskInfo | null = null;
  /** A group's (turn body) or a tool's (subagent) items, and their blocks by key. */
  children: Item[] = [];
  blocks = new Map<string, Item>();
  images = 0;
  /** A user message's images' files, in the order of its "[Image #N]" chips. */
  imagePaths: string[] = [];
  /** A notice's tone ("info", "error", "command") and longer text; a prompt's tone is "notice" when the agent itself sent it (a background task's end). */
  tone = "";
  detail = "";
  requestId = "";
  toolUseId = "";
  /** A request's state: "open", "answered", "cancelled". */
  state = "";
  /** View state: a tool card shown with its details. */
  expanded = false;
  /** A call's facts, as its adapter reads them from the agent's tool: what kind of call it is (a
   * request's: question or plan), its one line, the files it reads or changes, a command whole,
   * what it wrote when it shows no change, a todo list, and a subagent's kind, task and prompt. */
  category = "";
  summary = "";
  paths: string[] = [];
  command = "";
  /** The programs the command runs (`command.ts`), for its line and the counts. */
  programs: string[] = [];
  written = "";
  todos: Todo[] = [];
  agentType = "";
  agentTask = "";
  agentPrompt = "";
  /** A request's questions. */
  questions: Question[] = [];
  /** The request is a permission's: its options are the answers, with no words of the user's own. */
  permission = false;
  /** When a tool or thinking started and ended (ms since the epoch; 0 for not yet): the time the
   * adapter gives (a transcript's record time), else the moment it arrived. */
  startedAt = 0;
  endedAt = 0;
  /** The rendering cache (conversation/render.ts), by revision, width and indent (the chat nests a subagent's items; the code column shows them flat). */
  cacheRev = -1;
  cacheWidth = -1;
  cacheIndent = "";
  cache: Line[] = [];

  constructor(kind: number, id: string) {
    this.kind = kind;
    this.id = id;
  }
}

export class TurnResult {
  subtype = "";
  isError = false;
  reason = "";
  durationMs = 0;
  costUsd = 0;
  text = "";
}

export class Turn {
  id: string;
  prompt: Item | null = null;
  /** When the turn opened (the user's message) and when the agent's first words arrived (ms; 0 before). */
  at = 0;
  replyAt = 0;
  /** It holds only the app's notices, said before any message (no prompt, and the agent did not start it). */
  notes = false;
  body: Item;
  result: TurnResult | null = null;
  rev = 0;
  cacheRev = -1;
  cacheWidth = -1;
  cache: Line[] = [];

  /** The app's notices said after the turn ended, drawn after its footer. */
  after: Item;

  constructor(id: string) {
    this.id = id;
    this.body = new Item(GROUP, id + ":body");
    this.body.turn = this;
    this.after = new Item(GROUP, id + ":after");
    this.after.turn = this;
  }
}

export class Pending {
  text: string;
  images: number;

  constructor(text: string, images: number) {
    this.text = text;
    this.images = images;
  }
}

/** A tool's input from the JSON streamed so far; null while it does not parse. */
const parsePartial = (partial: string): unknown => {
  if (partial.length === 0) return null;
  try {
    return JSON.parse(partial);
  } catch {
    return null;
  }
};

/** Bounds on what a long session keeps: turns, then the maps a tool or request lookup uses. */
const MAX_TURNS = 1000;
const MAX_TOOLS = 2000;
const MAX_TASKS = 200;
const MAX_REQUESTS = 500;
const MAX_ASIDES = 200;

export class ChatModel {
  turns: Turn[] = [];
  sessionId = "";
  model = "";
  permissionMode = "";
  /** The session holds records before the ones loaded ("load earlier" reads them). */
  earlier = false;
  /** The effort the agent reports ("" when it reports none: the one widecode asked for stands). */
  effort = "";
  cwd = "";
  /** The agent's latest status ("requesting", "compacting", …). */
  status = "";
  slashCommands: string[] = [];
  /** The tools the agent has, once it says (`availableKnown`), and its MCP servers; `ownKnown` false when it lists none of its own (widecode's may be there). */
  available: ToolInfo[] = [];
  servers: ServerInfo[] = [];
  availableKnown = false;
  ownKnown = false;
  /** The skills the agent has, once it says (`skillsKnown`); `skillsPartial` while the list is what its plugin found on disk before the agent said. */
  skills: SkillInfo[] = [];
  skillsKnown = false;
  skillsPartial = false;
  /** The queued messages the agent last gave back (↑ in the composer takes them), and a counter that moves each time. */
  withdrawn: string[] = [];
  withdrawnRev = 0;
  /** Side questions (/btw) and their answers, by id. */
  private asides = new Map<string, Item>();
  /** From a turn's start to its result. */
  running = false;
  /** Messages sent to the agent that it has not taken up yet, oldest first. */
  pending: Pending[] = [];
  current: Turn | null = null;
  /** Moves on every change: a view reading it in its render draws again when it moved. */
  readonly version = signal(0);
  /** Moves each time a turn closes (an adapter forgets what it was streaming then). */
  closings = 0;
  /** The file the latest finished edit changed (as the agent named it), and a counter that moves
   * with each one, for the code column to follow. */
  lastEdit = "";
  editSeq = 0;
  /** Every file the agent edited in the turns loaded (absolute paths, as the calls were given them). */
  edited = new Set<string>();
  /** When what is being applied happened (ms since the epoch); the adapter sets it. */
  now = 0;
  private tools = new Map<string, Item>();
  private tasks = new Map<string, Item>();
  private requests = new Map<string, Item>();
  private nextId = 1;

  /** A fresh id with `prefix`. */
  newId(prefix: string): string {
    return prefix + String(this.nextId++);
  }

  /** Keep the newest turns; the rest are what "load earlier" reads again (the store may have them). */
  private trimTurns(): void {
    while (this.turns.length > MAX_TURNS) {
      this.turns.splice(0, 1);
      this.earlier = true;
    }
  }

  /** The model changed. */
  bump(): void {
    this.version.value = this.version.peek() + 1;
  }

  touch(item: Item): void {
    item.rev++;
    // A card drawn from its children (a subagent's call) is cached by its own revision too.
    let parent = item.parent;
    while (parent !== null) {
      parent.rev++;
      parent = parent.parent;
    }
    const t = item.turn;
    if (t !== null) t.rev++;
    this.bump();
  }

  /** A message the user sent: shown as queued until the agent takes it up. */
  send(text: string, images: number): void {
    this.pending.push(new Pending(text, images));
    this.bump();
  }

  /** Open a turn; `hasPrompt` false for one the agent started. */
  openTurn(text: string, images: number, hasPrompt: boolean): Turn {
    this.closeTurn(null);
    const turn = new Turn(this.newId("t"));
    turn.at = this.now > 0 ? this.now : Date.now();
    if (hasPrompt) {
      const p = new Item(PROMPT, this.newId("u"));
      p.text = text;
      p.images = images;
      p.turn = turn;
      turn.prompt = p;
    }
    this.turns.push(turn);
    this.trimTurns();
    this.current = turn;
    this.running = true;
    this.bump();
    return turn;
  }

  /** Close the open turn: unfinished blocks stop where they are. */
  closeTurn(result: TurnResult | null): void {
    const turn = this.current;
    if (turn === null) return;
    this.closeItems(turn.body.children);
    // A question or plan still waiting when its turn ends was withdrawn (an interrupt ends the
    // turn without a cancel request for it), unless its card runs a background subagent that is
    // still going: that run's question is the user's to answer whichever turn the card is in.
    for (const req of this.requests.values())
      if (req.state === "open" && req.turn === turn && !this.liveSubagentRequest(req)) {
        req.state = "cancelled";
        this.touch(req);
      }
    // A closed turn's requests are no longer open; the ones before it go for good (the turn's own
    // stay, so a repeated request event still finds the item it opened), except one still open
    // there, the app's own asked after a turn, which waits for its answer.
    for (const id of Array.from(this.requests.keys())) {
      const req = this.requests.get(id);
      if (req !== undefined && req.turn !== turn && req.state !== "open") this.requests.delete(id);
    }
    if (result !== null) turn.result = result;
    turn.rev++;
    this.current = null;
    this.running = false;
    this.closings++;
    this.bump();
  }

  /** A turn's result: it closes the open turn, or, with none open, goes to the last one. */
  finishTurn(result: TurnResult): void {
    if (this.current === null && this.turns.length > 0) {
      const last = this.turns[this.turns.length - 1];
      if (last.result === null) last.result = result;
      last.rev++;
      this.running = false;
      this.bump();
      return;
    }
    this.closeTurn(result);
  }

  /** Items whose blocks stop where they are; a call with no result was stopped there. */
  closeItems(items: Item[]): void {
    for (const item of items) {
      if ((item.kind === TEXT || item.kind === THINKING || item.kind === TOOL) && !item.done) {
        item.done = true;
        if (item.kind === TOOL && item.input === null) item.input = parsePartial(item.partial);
        this.touch(item);
      }
      if (item.kind === THINKING || (item.kind === TOOL && item.result === null)) this.ended(item);
      if (item.kind === TOOL) this.closeItems(item.children);
    }
  }

  /** The turn new output belongs to: the open one, else one for the oldest queued message, else one the agent started. */
  turn(): Turn {
    const open = this.current;
    if (open !== null) return open;
    const next = this.pending.shift();
    return next !== undefined ? this.openTurn(next.text, next.images, true) : this.openTurn("", 0, false);
  }

  /** The items output with this parent call goes into, null for an unknown parent (its event is dropped). */
  container(parent: string): Item | null {
    if (parent.length === 0) return this.turn().body;
    const tool = this.tools.get(parent);
    return tool !== undefined ? tool : null;
  }

  /** The call with this id, null for none. */
  tool(id: string): Item | null {
    return this.tools.get(id) ?? null;
  }

  /** How many calls of each tool the session holds, by the name the agent's list of tools gives it. */
  /** The commands the session's calls ran, in order. */
  commands(): string[] {
    const out: string[] = [];
    for (const item of this.tools.values()) if (item.command.length > 0) out.push(item.command);
    return out;
  }

  callCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const item of this.tools.values()) {
      const name = item.tool.length > 0 ? item.tool : item.name;
      out.set(name, (out.get(name) ?? 0) + 1);
    }
    return out;
  }

  private add(container: Item, item: Item, key: string): void {
    item.turn = container.turn;
    item.parent = container;
    // The agent's first words: the time its reply is stamped with.
    if (item.kind === TEXT && item.turn !== null && item.turn.replyAt === 0) item.turn.replyAt = this.now > 0 ? this.now : Date.now();
    container.children.push(item);
    if (key.length > 0) container.blocks.set(key, item);
    if (item.kind === TOOL) {
      if (this.tools.size >= MAX_TOOLS) for (const old of this.tools.keys()) { this.tools.delete(old); break; }
      this.tools.set(item.id, item);
    }
    this.touch(container);
  }

  /** The block `key` under `parent`, made (text, thinking or a call with `toolId` and `name`) when it is new; null for an unknown parent. */
  block(parent: string, key: string, kind: number, toolId: string, name: string, text: string): Item | null {
    const container = this.container(parent);
    if (container === null) return null;
    const found = container.blocks.get(key);
    if (found !== undefined) return found;
    const item = new Item(kind, kind === TOOL ? toolId : key);
    item.name = name;
    item.text = text;
    item.startedAt = this.now;
    this.add(container, item, key);
    return item;
  }

  /** The block `key` under `parent` when there is one. */
  findBlock(parent: string, key: string): Item | null {
    const container = this.container(parent);
    return container !== null ? (container.blocks.get(key) ?? null) : null;
  }

  /** A block is complete: thinking ends, a call's streamed input is read. */
  finish(item: Item): void {
    item.done = true;
    if (item.kind === THINKING) this.ended(item);
    if (item.kind === TOOL && item.input === null) item.input = parsePartial(item.partial);
    this.touch(item);
  }

  /** A block's end time, the first time only. */
  ended(item: Item): void {
    if (item.endedAt === 0) item.endedAt = this.now;
  }

  /** Call `id` returned: its result, its end, and the request it answered. */
  toolResult(id: string, result: ToolResult): Item | null {
    const tool = this.tools.get(id);
    if (tool === undefined) return null;
    tool.result = result;
    tool.done = true;
    this.ended(tool);
    for (const req of this.requests.values())
      if (req.toolUseId === tool.id && req.state === "open") {
        req.state = "answered";
        this.touch(req);
      }
    if (tool.input === null) tool.input = parsePartial(tool.partial);
    this.touch(tool);
    return tool;
  }

  /** The agent changed file `path` (the code column follows it). */
  editedFile(path: string): void {
    this.lastEdit = path;
    this.editSeq++;
    this.edited.add(path);
  }

  /** A prompt within a turn: a message sent while the agent worked, or a subagent's under its call; null for an unknown parent. */
  prompt(parent: string, text: string, images: number): Item | null {
    const container = this.container(parent);
    if (container === null) return null;
    const p = new Item(PROMPT, this.newId("u"));
    p.text = text;
    p.images = images;
    this.add(container, p, "");
    return p;
  }

  /** Whether the last notice said `text` (the open turn's; while the agent is idle, the one after the last turn): an agent may report an interrupt twice. */
  lastNoticeIs(text: string): boolean {
    const turn = this.current !== null ? this.current : this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
    if (turn === null) return false;
    const items = this.current === null && turn.after.children.length > 0 ? turn.after.children : turn.body.children;
    const last = items.length > 0 ? items[items.length - 1] : null;
    return last !== null && last.kind === NOTICE && last.text === text;
  }

  notice(text: string, tone: string, detail: string, parent: string): void {
    const n = new Item(NOTICE, this.newId("n"));
    n.text = text;
    n.tone = tone;
    n.detail = detail;
    this.place(n, parent);
  }

  /** An item said by the app or the agent aside: while the agent is idle, after the last turn, no turn opened for it. */
  private place(item: Item, parent: string): void {
    const idle = parent.length === 0 && this.current === null;
    const container = idle ? this.idleTurn().after : this.container(parent);
    // An item naming a parent the model does not hold is dropped, as its event is.
    if (container === null) return;
    this.add(container, item, "");
  }

  /** Side question `id`: shown with its question when it is new, then its answer so far, whole once `done`, or why it failed. */
  aside(id: string, question: string, answer: string, error: string, done: boolean): void {
    let item = this.asides.get(id);
    if (item === undefined) {
      item = new Item(NOTICE, this.newId("b"));
      item.tone = "aside";
      if (this.asides.size >= MAX_ASIDES) for (const old of this.asides.keys()) { this.asides.delete(old); break; }
      this.asides.set(id, item);
      this.place(item, "");
    }
    if (question.length > 0) item.text = question;
    if (answer.length > 0) item.detail = answer;
    if (error.length > 0) {
      item.detail = error;
      item.state = "failed";
    }
    if (done || error.length > 0) item.done = true;
    this.touch(item);
  }

  /** The agent gave back queued messages `texts`: off the queue, for the composer. */
  withdraw(texts: string[]): void {
    for (const t of texts) this.unqueue(t);
    this.withdrawn = texts;
    this.withdrawnRev++;
    this.bump();
  }

  /** The turn notices go after while the agent is idle: the last one, else one of their own, closed. */
  private idleTurn(): Turn {
    if (this.turns.length > 0) return this.turns[this.turns.length - 1];
    const t = new Turn(this.newId("t"));
    t.notes = true;
    this.turns.push(t);
    this.trimTurns();
    return t;
  }

  /** Call `toolId` runs on as task `info` (a subagent in the background). */
  startTask(toolId: string, info: TaskInfo): void {
    const tool = this.tools.get(toolId);
    if (tool === undefined) return;
    tool.task = info;
    if (info.taskId.length > 0) {
      if (this.tasks.size >= MAX_TASKS) for (const old of this.tasks.keys()) { this.tasks.delete(old); break; }
      this.tasks.set(info.taskId, tool);
    }
    this.touch(tool);
  }

  /** The call running task `taskId` (or call `toolId`), null for none. */
  taskCall(toolId: string, taskId: string): Item | null {
    return this.tools.get(toolId) ?? this.tasks.get(taskId) ?? null;
  }

  /**
   * A request for the user (a question, a plan to approve) under the open turn; a repeated id in that
   * turn is the same request. With no turn open and no message queued it is the app's own (the
   * onboarding's questions): it goes after the last turn, as a notice does, and opens no turn, which
   * nothing would close.
   */
  openRequest(requestId: string, name: string, toolUseId: string, input: unknown, parent = ""): Item {
    let container = this.current === null && this.pending.length === 0 ? this.idleTurn().after : this.turn().body;
    if (parent.length > 0) {
      const under = this.container(parent);
      if (under !== null) container = under;
    }
    const found = this.requests.get(requestId);
    if (found !== undefined && found.turn === container.turn) return found;
    const item = new Item(REQUEST, "r:" + requestId);
    item.requestId = requestId;
    item.name = name;
    item.toolUseId = toolUseId;
    item.input = input;
    item.state = "open";
    if (this.requests.size >= MAX_REQUESTS) for (const old of this.requests.keys()) { this.requests.delete(old); break; }
    this.requests.set(requestId, item);
    this.add(container, item, "");
    return item;
  }

  /** The agent withdrew request `requestId`. */
  cancelRequest(requestId: string): void {
    const item = this.requests.get(requestId);
    if (item === undefined || item.state !== "open") return;
    item.state = "cancelled";
    this.touch(item);
  }

  /** The user answered a request (or it went away). */
  settle(requestId: string, state: string): void {
    const item = this.requests.get(requestId);
    if (item === undefined) return;
    item.state = state;
    this.touch(item);
  }

  /** The open requests, oldest first. */
  openRequests(): Item[] {
    const out: Item[] = [];
    for (const item of this.requests.values()) if (item.state === "open") out.push(item);
    return out;
  }

  /** Every request the model holds, in the order they opened, open or settled: whatever turn its card is in. */
  allRequests(): Item[] {
    return Array.from(this.requests.values());
  }

  /** Whether `req` waits under a background subagent that is still running, so its turn closing does not withdraw it. */
  private liveSubagentRequest(req: Item): boolean {
    let parent = req.parent;
    while (parent !== null) {
      if (parent.task !== null && parent.task.background) return parent.task.status === "running";
      parent = parent.parent;
    }
    return false;
  }

  /** Withdraw the open requests under `call`: the background run they belong to ended or was stopped. */
  cancelRequestsUnder(call: Item): void {
    for (const req of Array.from(this.requests.values())) {
      if (req.state !== "open") continue;
      let parent = req.parent;
      while (parent !== null && parent !== call) parent = parent.parent;
      if (parent === call) this.cancelRequest(req.requestId);
    }
  }

  /** The agent took up a queued message: the one with text `whole`, or those it took together (`parts`); else the oldest. */
  take(whole: string, parts: string[]): void {
    if (this.unqueue(whole)) {
      this.bump();
      return;
    }
    let found = false;
    for (const part of parts) if (this.unqueue(part)) found = true;
    if (!found && this.pending.length > 0) this.pending.shift();
    this.bump();
  }

  /** The agent ran a command the user queued: the oldest queued one starting with "/". */
  takeCommand(): void {
    for (let i = 0; i < this.pending.length; i++)
      if (this.pending[i].text.startsWith("/")) {
        this.pending.splice(i, 1);
        this.bump();
        return;
      }
  }

  /** Take the oldest queued message with this text off the queue; false when none has it. */
  private unqueue(text: string): boolean {
    for (let i = 0; i < this.pending.length; i++)
      if (this.pending[i].text === text) {
        this.pending.splice(i, 1);
        return true;
      }
    return false;
  }
}
