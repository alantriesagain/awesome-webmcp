// The conversation's changes as an agent's adapter plugin hands them over: a list of neutral events
// (`api.conversation.apply(events)`, one call per batch of its agent's messages), applied here to
// the model and the status. Each event names a call of the model (model.ts); widecode.d.ts types
// them for plugins. A block is named by the parent call it is under ("" for the turn) and its key
// (the adapter's own: a message and its index, a call's id).
import { ChatModel, Item, PatchHunk, ServerInfo, SkillInfo, TaskInfo, Todo, ToolInfo, ToolResult, TurnResult, AGENT, EDIT, READ, RUN, SEARCH, TEXT, THINKING, TOOL } from "./model.ts";
import { programsOf } from "./command.ts";
import { isRecord, listOf, num, str, strs, text } from "@light/lib/json.ts";
import { Choice, Question } from "./requests.ts";
import { StatusInfo } from "./status-info.ts";

/** An event or a nested object of one, every field `unknown`. */
interface Ev {
  type?: unknown;
  ms?: unknown;
  id?: unknown;
  model?: unknown;
  cwd?: unknown;
  mode?: unknown;
  effort?: unknown;
  status?: unknown;
  commands?: unknown;
  text?: unknown;
  parts?: unknown;
  images?: unknown;
  imagePaths?: unknown;
  prompt?: unknown;
  notice?: unknown;
  parent?: unknown;
  key?: unknown;
  kind?: unknown;
  name?: unknown;
  delta?: unknown;
  json?: unknown;
  input?: unknown;
  category?: unknown;
  summary?: unknown;
  paths?: unknown;
  command?: unknown;
  written?: unknown;
  todos?: unknown;
  tools?: unknown;
  skills?: unknown;
  source?: unknown;
  texts?: unknown;
  tool?: unknown;
  server?: unknown;
  access?: unknown;
  scope?: unknown;
  servers?: unknown;
  partial?: unknown;
  state?: unknown;
  agentType?: unknown;
  agentTask?: unknown;
  agentPrompt?: unknown;
  error?: unknown;
  patch?: unknown;
  oldStart?: unknown;
  newStart?: unknown;
  lines?: unknown;
  path?: unknown;
  tone?: unknown;
  detail?: unknown;
  once?: unknown;
  taskId?: unknown;
  description?: unknown;
  background?: unknown;
  lastTool?: unknown;
  done?: unknown;
  tokens?: unknown;
  callId?: unknown;
  questions?: unknown;
  question?: unknown;
  header?: unknown;
  multi?: unknown;
  options?: unknown;
  label?: unknown;
  plan?: unknown;
  durationMs?: unknown;
  costUsd?: unknown;
  reason?: unknown;
  version?: unknown;
  contextUsed?: unknown;
  contextSize?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  ifOpen?: unknown;
  earlier?: unknown;
  fields?: unknown;
}

/** The status fields an `info` event sets (conversation/status-info.ts), every one `unknown`. */
interface InfoFields {
  sessionId?: unknown;
  transcriptPath?: unknown;
  cwd?: unknown;
  version?: unknown;
  modelId?: unknown;
  knownWindow?: unknown;
  mode?: unknown;
  contextInput?: unknown;
  contextOutput?: unknown;
  contextCacheRead?: unknown;
  contextCacheWrite?: unknown;
  contextSize?: unknown;
  totalInput?: unknown;
  totalOutput?: unknown;
  fiveHourPct?: unknown;
  fiveHourResets?: unknown;
  weekPct?: unknown;
  weekResets?: unknown;
  requests?: unknown;
  misses?: unknown;
  cacheRead?: unknown;
  allInput?: unknown;
  cacheTtlMs?: unknown;
  lastRequestMs?: unknown;
  costUsd?: unknown;
  startMs?: unknown;
  apiMs?: unknown;
  linesAdded?: unknown;
  linesRemoved?: unknown;
  thinking?: unknown;
}


/** Set the status fields `f` names. */
const setInfo = (info: StatusInfo, v: unknown): void => {
  if (!isRecord(v)) return;
  const f = v as InfoFields;
  info.sessionId = text(f.sessionId, info.sessionId);
  info.transcriptPath = text(f.transcriptPath, info.transcriptPath);
  info.cwd = text(f.cwd, info.cwd);
  info.version = text(f.version, info.version);
  info.modelId = text(f.modelId, info.modelId);
  info.knownWindow = num(f.knownWindow, info.knownWindow);
  info.mode = text(f.mode, info.mode);
  info.contextInput = num(f.contextInput, info.contextInput);
  info.contextOutput = num(f.contextOutput, info.contextOutput);
  info.contextCacheRead = num(f.contextCacheRead, info.contextCacheRead);
  info.contextCacheWrite = num(f.contextCacheWrite, info.contextCacheWrite);
  info.contextSize = num(f.contextSize, info.contextSize);
  info.totalInput = num(f.totalInput, info.totalInput);
  info.totalOutput = num(f.totalOutput, info.totalOutput);
  info.fiveHourPct = num(f.fiveHourPct, info.fiveHourPct);
  info.fiveHourResets = num(f.fiveHourResets, info.fiveHourResets);
  info.weekPct = num(f.weekPct, info.weekPct);
  info.weekResets = num(f.weekResets, info.weekResets);
  info.requests = num(f.requests, info.requests);
  info.misses = num(f.misses, info.misses);
  info.cacheRead = num(f.cacheRead, info.cacheRead);
  info.allInput = num(f.allInput, info.allInput);
  info.cacheTtlMs = num(f.cacheTtlMs, info.cacheTtlMs);
  info.lastRequestMs = num(f.lastRequestMs, info.lastRequestMs);
  info.costUsd = num(f.costUsd, info.costUsd);
  info.startMs = num(f.startMs, info.startMs);
  info.apiMs = num(f.apiMs, info.apiMs);
  info.linesAdded = num(f.linesAdded, info.linesAdded);
  info.linesRemoved = num(f.linesRemoved, info.linesRemoved);
  info.thinking = num(f.thinking, info.thinking);
};

const ev = (v: unknown): Ev | null => (isRecord(v) ? (v as Ev) : null);
const kindOf = (kind: string): number => (kind === "tool" ? TOOL : kind === "thinking" ? THINKING : TEXT);

/** Count a call the status shows by kind (reads, writes, runs, subagents), once. */
const counted = (info: StatusInfo, item: Item, before: string): void => {
  if (item.category.length === 0 || before === item.category) return;
  // A call counted as another kind (Claude knows the tool, not what it does) moves to what its
  // facts say: the call count stays one, the kind's count moves with it.
  if (before.length === 0) info.calls++;
  if (item.category === READ || item.category === SEARCH) info.reads++;
  else if (item.category === EDIT) info.writes++;
  else if (item.category === RUN) info.execs++;
  else if (item.category === AGENT) info.agents++;
};

/** A call's facts from an event: what kind of call, its line, files, command, content, todos, subagent. */
const facts = (item: Item, e: Ev): void => {
  if (typeof e.category === "string") item.category = e.category;
  if (typeof e.summary === "string") item.summary = e.summary;
  if (e.paths !== undefined) item.paths = strs(e.paths);
  if (typeof e.command === "string") {
    item.command = e.command;
    item.programs = programsOf(e.command);
  }
  if (typeof e.written === "string") item.written = e.written;
  if (typeof e.tool === "string") item.tool = e.tool;
  if (e.todos !== undefined) {
    const todos: Todo[] = [];
    for (const t of listOf(e.todos)) {
      const todo = ev(t);
      if (todo !== null) todos.push(new Todo(str(todo.text), str(todo.state).length > 0 ? str(todo.state) : "todo"));
    }
    item.todos = todos;
  }
  if (typeof e.agentType === "string") item.agentType = e.agentType;
  if (typeof e.agentTask === "string") item.agentTask = e.agentTask;
  if (typeof e.agentPrompt === "string") item.agentPrompt = e.agentPrompt;
};

const patchOf = (v: unknown): PatchHunk[] => {
  const out: PatchHunk[] = [];
  for (const h of listOf(v)) {
    const hunk = ev(h);
    if (hunk !== null) out.push(new PatchHunk(num(hunk.oldStart, 0), num(hunk.newStart, 0), strs(hunk.lines)));
  }
  return out;
};

const questionsOf = (v: unknown): Question[] => {
  const out: Question[] = [];
  for (const q of listOf(v)) {
    const f = ev(q);
    if (f === null) continue;
    const question = new Question();
    question.question = str(f.question);
    question.header = str(f.header);
    question.multi = f.multi === true;
    for (const o of listOf(f.options)) {
      const option = ev(o);
      if (option !== null) question.options.push(new Choice(str(option.label), str(option.description)));
    }
    out.push(question);
  }
  return out;
};

/** Open request `id` as `e` (a request event's fields) has it: its category, name, the call it is for, questions, plan. */
const requestOf = (model: ChatModel, id: string, e: Ev, parent: string): Item => {
  const item = model.openRequest(id, str(e.name), str(e.callId), e.input !== undefined ? e.input : null, parent);
  item.category = str(e.category);
  item.questions = questionsOf(e.questions);
  item.text = str(e.plan);
  return item;
};

/** Open request `id` from `v`, a request event's fields without its type and id, under `parent` when it names a call; null when `v` is not an object. */
export const openRequest = (model: ChatModel, id: string, v: unknown, parent = ""): Item | null => {
  const e = ev(v);
  return e !== null ? requestOf(model, id, e, parent) : null;
};

/** Apply `events` (an array of event objects) to `model` and `info`; answers how many it applied. They happen now unless an `at` event says when. */
export const applyEvents = (model: ChatModel, info: StatusInfo, events: unknown): number => {
  model.now = Date.now();
  let applied = 0;
  for (const v of listOf(events)) {
    const e = ev(v);
    if (e === null) continue;
    if (applyEvent(model, info, e)) applied++;
  }
  return applied;
};

/** The event types the model knows; one not here is left out of the applied count. */
const EVENT_TYPES = [
  "at",
  "session",
  "mode",
  "status",
  "take",
  "takeCommand",
  "turn",
  "ensureTurn",
  "dropQueued",
  "startQueued",
  "closeChildren",
  "info",
  "close",
  "end",
  "block",
  "text",
  "partial",
  "input",
  "facts",
  "finish",
  "result",
  "edited",
  "prompt",
  "notice",
  "task",
  "taskUpdate",
  "thinkingTokens",
  "withdrawn",
  "aside",
  "tools",
  "skills",
  "request",
  "cancelRequest",
  "usage",
];

const applyEvent = (model: ChatModel, info: StatusInfo, e: Ev): boolean => {
  const type = str(e.type);
  if (!EVENT_TYPES.includes(type)) return false;
  const parent = str(e.parent);
  const key = str(e.key);
  if (type === "at") model.now = num(e.ms, 0);
  else if (type === "session") {
    if (str(e.id).length > 0) model.sessionId = str(e.id);
    if (str(e.model).length > 0) model.model = str(e.model);
    if (str(e.cwd).length > 0) model.cwd = str(e.cwd);
    if (str(e.mode).length > 0) model.permissionMode = str(e.mode);
    if (str(e.effort).length > 0) model.effort = str(e.effort);
    if (typeof e.earlier === "boolean") model.earlier = e.earlier;
    if (e.commands !== undefined) model.slashCommands = strs(e.commands);
    model.bump();
  } else if (type === "mode") {
    model.permissionMode = str(e.mode);
    info.mode = str(e.mode);
    model.bump();
  } else if (type === "status") {
    model.status = str(e.status);
    model.bump();
  } else if (type === "take") model.take(str(e.text), strs(e.parts));
  else if (type === "takeCommand") model.takeCommand();
  else if (type === "turn") {
    const turn = model.openTurn(str(e.text), num(e.images, 0), e.prompt !== false);
    if (turn.prompt !== null) {
      if (e.notice === true) turn.prompt.tone = "notice";
      turn.prompt.imagePaths = strs(e.imagePaths);
    }
  } else if (type === "ensureTurn") model.turn();
  // The messages queued are dropped (the agent's process ended with them unsent).
  else if (type === "dropQueued") {
    model.pending = [];
    model.bump();
  }
  // The oldest queued message is taken up now (a compaction answering /compact), when no turn is open.
  else if (type === "startQueued") {
    if (model.current === null && model.pending.length > 0) model.turn();
  } else if (type === "closeChildren") {
    // What ran under a call (a subagent's transcript, read) stops where it is.
    const tool = model.tool(str(e.id));
    if (tool === null) return true;
    model.closeItems(tool.children);
    model.touch(tool);
  } else if (type === "info") {
    setInfo(info, e.fields);
    model.bump();
  } else if (type === "close") model.closeTurn(null);
  else if (type === "end") {
    const result = new TurnResult();
    result.isError = e.error === true;
    result.reason = str(e.reason);
    result.subtype = str(e.status);
    result.durationMs = num(e.durationMs, 0);
    result.costUsd = num(e.costUsd, 0);
    result.text = str(e.text);
    model.finishTurn(result);
  } else if (type === "block") {
    const kind = kindOf(str(e.kind));
    const item = model.block(parent, key, kind, str(e.id), str(e.name), str(e.text));
    if (item === null) return true;
    if (kind === TOOL) {
      const before = item.category;
      facts(item, e);
      counted(info, item, before);
    }
  } else if (type === "text") {
    const item = model.findBlock(parent, key);
    if (item === null) return true;
    if (typeof e.delta === "string") item.text += e.delta;
    else item.text = str(e.text);
    model.touch(item);
  } else if (type === "partial") {
    const item = model.findBlock(parent, key);
    if (item === null) return true;
    item.partial += str(e.json);
    model.touch(item);
  } else if (type === "input") {
    const item = model.findBlock(parent, key);
    if (item === null) return true;
    if (e.input !== undefined) item.input = e.input;
    if (str(e.name).length > 0) item.name = str(e.name);
    model.touch(item);
  } else if (type === "facts") {
    const item = model.tool(str(e.id));
    if (item === null) return true;
    const before = item.category;
    facts(item, e);
    counted(info, item, before);
    model.touch(item);
  } else if (type === "finish") {
    const item = model.findBlock(parent, key);
    if (item !== null && !item.done) model.finish(item);
  } else if (type === "result") {
    const result = new ToolResult();
    result.text = str(e.text);
    result.images = num(e.images, 0);
    result.isError = e.error === true;
    if (e.patch !== undefined) {
      result.patch = patchOf(e.patch);
      result.hasPatch = result.patch.length > 0;
    }
    model.toolResult(str(e.id), result);
  } else if (type === "edited") model.editedFile(str(e.path));
  else if (type === "prompt") {
    const p = model.prompt(parent, str(e.text), num(e.images, 0));
    if (p === null) return true;
    if (e.notice === true) p.tone = "notice";
    p.imagePaths = strs(e.imagePaths);
  } else if (type === "notice") {
    if (e.once === true && model.lastNoticeIs(str(e.text))) return true;
    if (e.ifOpen === true && model.current === null) return true;
    model.notice(str(e.text), str(e.tone).length > 0 ? str(e.tone) : "info", str(e.detail), parent);
  } else if (type === "task") {
    const task = new TaskInfo();
    task.taskId = str(e.taskId);
    task.description = str(e.description);
    task.subagentType = str(e.agentType);
    task.background = e.background === true;
    model.startTask(str(e.id), task);
  } else if (type === "taskUpdate") {
    const tool = model.taskCall(str(e.id), str(e.taskId));
    if (tool === null || tool.task === null) return true;
    const task = tool.task;
    const status = str(e.status);
    if (status.length > 0) task.status = status;
    if (str(e.lastTool).length > 0) task.lastTool = str(e.lastTool);
    if (str(e.description).length > 0) task.description = str(e.description);
    if (typeof e.summary === "string") task.summary = e.summary;
    if (e.done === true) model.closeItems(tool.children);
    // The run itself ended or was stopped: a question it left open is answered cancelled.
    if (status === "done" || status === "stopped" || status === "failed") model.cancelRequestsUnder(tool);
    model.touch(tool);
  } else if (type === "thinkingTokens") {
    const item = model.findBlock(parent, key);
    if (item === null) return true;
    item.tokens = num(e.tokens, 0);
    model.touch(item);
  } else if (type === "withdrawn") model.withdraw(strs(e.texts));
  else if (type === "aside") model.aside(str(e.id), str(e.question), str(e.text), str(e.error), e.done === true);
  else if (type === "tools") {
    const tools: ToolInfo[] = [];
    for (const v of listOf(e.tools)) {
      const t = ev(v);
      if (t === null || str(t.name).length === 0) continue;
      const tool = new ToolInfo(str(t.name), str(t.server));
      if (str(t.id).length > 0) tool.id = str(t.id);
      tool.access = str(t.access);
      tool.scope = str(t.scope);
      tools.push(tool);
    }
    const servers: ServerInfo[] = [];
    for (const v of listOf(e.servers)) {
      const s = ev(v);
      if (s !== null && str(s.name).length > 0) servers.push(new ServerInfo(str(s.name), str(s.status)));
    }
    model.available = tools;
    model.servers = servers;
    model.availableKnown = true;
    model.ownKnown = e.partial !== true;
    model.bump();
  } else if (type === "skills") {
    const skills: SkillInfo[] = [];
    for (const v of listOf(e.skills)) {
      const t = ev(v);
      if (t === null || str(t.name).length === 0) continue;
      const skill = new SkillInfo(str(t.name));
      skill.description = str(t.description);
      skill.source = str(t.source);
      skill.path = str(t.path);
      skill.command = str(t.command);
      skills.push(skill);
    }
    model.skills = skills;
    model.skillsKnown = true;
    model.skillsPartial = e.partial === true;
    model.bump();
  } else if (type === "request") requestOf(model, str(e.id), e, str(e.parent));
  // Answered without the panel (an answer the user gave before covers it), else withdrawn by the agent.
  else if (type === "cancelRequest") {
    if (str(e.state) === "answered") model.settle(str(e.id), "answered");
    else model.cancelRequest(str(e.id));
  }
  else if (type === "usage") {
    if (str(e.model).length > 0) info.modelId = str(e.model);
    if (str(e.version).length > 0) info.version = str(e.version);
    if (typeof e.contextUsed === "number") {
      info.contextInput = e.contextUsed;
      info.contextCacheRead = 0;
      info.contextCacheWrite = 0;
    }
    if (typeof e.contextSize === "number") info.contextSize = e.contextSize;
    if (typeof e.costUsd === "number") info.costUsd = e.costUsd;
    if (typeof e.inputTokens === "number") info.totalInput = e.inputTokens;
    if (typeof e.outputTokens === "number") info.totalOutput = e.outputTokens;
    model.bump();
  }
  return true;
};

/** The events a subagent run may apply: the work under its call, never the turn's own life or the main status. */
const SUBAGENT_TYPES = ["block", "text", "partial", "input", "facts", "finish", "result", "edited", "prompt", "notice", "task", "taskUpdate", "thinkingTokens", "usage", "request", "cancelRequest"];

/**
 * Apply `events` from a subagent run under call `callId` of the open turn, into a status of their own
 * that is thrown away. The call's own facts go into `status` (the conversation's) instead, so the
 * call counts as the subagent it is; a historical read-back does not count it again, since the
 * history load already did. Answers how many it applied. A call whose turn has closed takes nothing,
 * and an event with no parent is the call's own.
 */
export const applySubagentEvents = (model: ChatModel, callId: string, events: unknown, historical = false, status: StatusInfo | null = null): number => {
  const call = model.tool(callId);
  if (call === null || call.turn === null) return 0;
  // A foreground run ends with its turn; a background one goes on after it, under its card.
  // `historical` is a transcript read back into a call whose turn has long closed.
  if (!historical && call.turn !== model.current && !(call.task !== null && call.task.background)) return 0;
  const info = new StatusInfo();
  model.now = Date.now();
  let applied = 0;
  for (const v of listOf(events)) {
    const e = ev(v);
    if (e === null || !SUBAGENT_TYPES.includes(str(e.type))) continue;
    if (e.parent === undefined || str(e.parent).length === 0) e.parent = callId;
    let target = info;
    if (!historical && status !== null && str(e.type) === "facts" && str(e.id) === callId) target = status;
    if (applyEvent(model, target, e)) applied++;
  }
  return applied;
};
