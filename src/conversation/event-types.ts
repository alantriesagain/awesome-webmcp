// The conversation's events as classes: each name the adapter plugins emit (conversation/events.ts)
// read once, here, into the fields the model and the status are given. A field a reader would fall
// back on is null when it was absent or of another type; one a reader tests for presence carries a
// `has` flag. decodeEvent answers null for a value that is not an event object.
import { isRecord, listOf, num, str, strs } from "@lightstart/lib/json.ts";
import { Choice, Question } from "./requests.ts";
import { PatchHunk, ServerInfo, SkillInfo, Todo, ToolInfo } from "./model.ts";

/** Base of every event: its name, its parent call ("" for the turn) and its id. */
export class ConversationEvent {
  type = "";
  parent = "";
  id = "";
}

/** The status fields an `info` event sets; null for one the event did not set as that type. */
export class InfoFields {
  sessionId: string | null = null;
  transcriptPath: string | null = null;
  cwd: string | null = null;
  version: string | null = null;
  modelId: string | null = null;
  knownWindow: number | null = null;
  mode: string | null = null;
  contextInput: number | null = null;
  contextOutput: number | null = null;
  contextCacheRead: number | null = null;
  contextCacheWrite: number | null = null;
  contextSize: number | null = null;
  totalInput: number | null = null;
  totalOutput: number | null = null;
  fiveHourPct: number | null = null;
  fiveHourResets: number | null = null;
  weekPct: number | null = null;
  weekResets: number | null = null;
  requests: number | null = null;
  misses: number | null = null;
  cacheRead: number | null = null;
  allInput: number | null = null;
  cacheTtlMs: number | null = null;
  lastRequestMs: number | null = null;
  costUsd: number | null = null;
  startMs: number | null = null;
  apiMs: number | null = null;
  linesAdded: number | null = null;
  linesRemoved: number | null = null;
  thinking: number | null = null;
}

/** A call's facts: what kind of call, its line, files, command, content, todos, subagent. */
export class CallFacts {
  category: string | null = null;
  summary: string | null = null;
  paths: string[] | null = null;
  command: string | null = null;
  written: string | null = null;
  tool: string | null = null;
  todos: Todo[] | null = null;
  agentType: string | null = null;
  agentTask: string | null = null;
  agentPrompt: string | null = null;
}

/** A request's fields: its category, name, the call it is for, questions, plan. */
export class RequestFields {
  name = "";
  callId = "";
  hasInput = false;
  input: unknown = null;
  category = "";
  questions: Question[] = [];
  permission = false;
  plan = "";
}

/** The event's time (ms since the epoch). */
export class AtEvent extends ConversationEvent {
  ms = 0;
}

/** The session the agent talks in, its model, folder, mode, effort and slash commands. */
export class SessionEvent extends ConversationEvent {
  model = "";
  cwd = "";
  mode = "";
  effort = "";
  earlier = false;
  hasEarlier = false;
  commands: string[] | null = null;
}

/** The permission mode. */
export class ModeEvent extends ConversationEvent {
  mode = "";
}

/** The conversation's state ("idle", "running"). */
export class StatusEvent extends ConversationEvent {
  status = "";
}

/** A message the agent took from the queue. */
export class TakeEvent extends ConversationEvent {
  text = "";
  parts: string[] = [];
}

/** The oldest queued message is taken up now. */
export class TakeCommandEvent extends ConversationEvent {}

/** A turn opens on the user's message. */
export class TurnEvent extends ConversationEvent {
  text = "";
  images = 0;
  prompt = true;
  notice = false;
  imagePaths: string[] = [];
}

/** A turn is opened unless one is open. */
export class EnsureTurnEvent extends ConversationEvent {}

/** The queued messages are dropped. */
export class DropQueuedEvent extends ConversationEvent {}

/** The oldest queued message starts a turn. */
export class StartQueuedEvent extends ConversationEvent {}

/** What ran under a call stops where it is. */
export class CloseChildrenEvent extends ConversationEvent {}

/** The status fields. */
export class InfoEvent extends ConversationEvent {
  fields: InfoFields | null = null;
}

/** The turn closes. */
export class CloseEvent extends ConversationEvent {}

/** The turn ends with a result. */
export class EndEvent extends ConversationEvent {
  error = false;
  reason = "";
  status = "";
  durationMs = 0;
  costUsd = 0;
  text = "";
}

/** An event of a tool call: its facts. */
export class CallEvent extends ConversationEvent {
  facts: CallFacts = new CallFacts();
}

/** A block of text, thinking or a tool call. */
export class BlockEvent extends CallEvent {
  key = "";
  kind = "";
  name = "";
  text = "";
}

/** Text appended to a block. */
export class TextEvent extends ConversationEvent {
  key = "";
  delta = "";
  hasDelta = false;
  text = "";
}

/** A call's streaming input JSON. */
export class PartialEvent extends ConversationEvent {
  key = "";
  json = "";
}

/** A call's input or name. */
export class InputEvent extends ConversationEvent {
  key = "";
  hasInput = false;
  input: unknown = null;
  name = "";
}

/** A call's facts, after its block. */
export class FactsEvent extends CallEvent {}

/** A block is finished. */
export class FinishEvent extends ConversationEvent {
  key = "";
}

/** A call's result. */
export class ResultEvent extends ConversationEvent {
  text = "";
  images = 0;
  error = false;
  size: number | null = null;
  hasSize = false;
  truncated = "";
  patch: PatchHunk[] | null = null;
}

/** A file the agent edited. */
export class EditedEvent extends ConversationEvent {
  path = "";
}

/** A prompt within a turn. */
export class PromptEvent extends ConversationEvent {
  text = "";
  images = 0;
  notice = false;
  imagePaths: string[] = [];
}

/** A notice. */
export class NoticeEvent extends ConversationEvent {
  text = "";
  once = false;
  ifOpen = false;
  tone = "";
  detail = "";
}

/** A subagent call that runs as a task. */
export class TaskEvent extends ConversationEvent {
  taskId = "";
  description = "";
  agentType = "";
  background = false;
}

/** A task's state. */
export class TaskUpdateEvent extends ConversationEvent {
  taskId = "";
  status = "";
  lastTool = "";
  description = "";
  summary: string | null = null;
  done = false;
}

/** A thinking block's token count. */
export class ThinkingTokensEvent extends ConversationEvent {
  key = "";
  tokens = 0;
}

/** The messages withdrawn from the queue. */
export class WithdrawnEvent extends ConversationEvent {
  texts: string[] = [];
}

/** A side question and its answer. */
export class AsideEvent extends ConversationEvent {
  question = "";
  text = "";
  error = "";
  done = false;
}

/** The agent's tools and MCP servers. */
export class ToolsEvent extends ConversationEvent {
  tools: ToolInfo[] = [];
  servers: ServerInfo[] = [];
  partial = false;
}

/** The agent's skills. */
export class SkillsEvent extends ConversationEvent {
  skills: SkillInfo[] = [];
  partial = false;
}

/** A request for the user. */
export class RequestEvent extends ConversationEvent {
  request: RequestFields = new RequestFields();
}

/** A request is answered or withdrawn. */
export class CancelRequestEvent extends ConversationEvent {
  state = "";
}

/** The model, context and cost as the agent reports them. */
export class UsageEvent extends ConversationEvent {
  model = "";
  version = "";
  contextUsed: number | null = null;
  contextSize: number | null = null;
  costUsd: number | null = null;
  inputTokens: number | null = null;
  outputTokens: number | null = null;
}

const stringOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

const fill = (e: ConversationEvent, r: Record<string, unknown>, type: string): void => {
  e.type = type;
  e.parent = str(r.parent);
  e.id = str(r.id);
};

const infoFieldsOf = (v: unknown): InfoFields | null => {
  if (!isRecord(v)) return null;
  const r = v as Record<string, unknown>;
  const f = new InfoFields();
  f.sessionId = stringOrNull(r.sessionId);
  f.transcriptPath = stringOrNull(r.transcriptPath);
  f.cwd = stringOrNull(r.cwd);
  f.version = stringOrNull(r.version);
  f.modelId = stringOrNull(r.modelId);
  f.knownWindow = numberOrNull(r.knownWindow);
  f.mode = stringOrNull(r.mode);
  f.contextInput = numberOrNull(r.contextInput);
  f.contextOutput = numberOrNull(r.contextOutput);
  f.contextCacheRead = numberOrNull(r.contextCacheRead);
  f.contextCacheWrite = numberOrNull(r.contextCacheWrite);
  f.contextSize = numberOrNull(r.contextSize);
  f.totalInput = numberOrNull(r.totalInput);
  f.totalOutput = numberOrNull(r.totalOutput);
  f.fiveHourPct = numberOrNull(r.fiveHourPct);
  f.fiveHourResets = numberOrNull(r.fiveHourResets);
  f.weekPct = numberOrNull(r.weekPct);
  f.weekResets = numberOrNull(r.weekResets);
  f.requests = numberOrNull(r.requests);
  f.misses = numberOrNull(r.misses);
  f.cacheRead = numberOrNull(r.cacheRead);
  f.allInput = numberOrNull(r.allInput);
  f.cacheTtlMs = numberOrNull(r.cacheTtlMs);
  f.lastRequestMs = numberOrNull(r.lastRequestMs);
  f.costUsd = numberOrNull(r.costUsd);
  f.startMs = numberOrNull(r.startMs);
  f.apiMs = numberOrNull(r.apiMs);
  f.linesAdded = numberOrNull(r.linesAdded);
  f.linesRemoved = numberOrNull(r.linesRemoved);
  f.thinking = numberOrNull(r.thinking);
  return f;
};

const todosOf = (v: unknown): Todo[] => {
  const out: Todo[] = [];
  for (const t of listOf(v)) {
    if (!isRecord(t)) continue;
    const r = t as Record<string, unknown>;
    out.push(new Todo(str(r.text), str(r.state).length > 0 ? str(r.state) : "todo"));
  }
  return out;
};

const patchOf = (v: unknown): PatchHunk[] => {
  const out: PatchHunk[] = [];
  for (const h of listOf(v)) {
    if (!isRecord(h)) continue;
    const r = h as Record<string, unknown>;
    out.push(new PatchHunk(num(r.oldStart, 0), num(r.newStart, 0), strs(r.lines)));
  }
  return out;
};

const questionsOf = (v: unknown): Question[] => {
  const out: Question[] = [];
  for (const q of listOf(v)) {
    if (!isRecord(q)) continue;
    const r = q as Record<string, unknown>;
    const question = new Question();
    question.question = str(r.question);
    question.header = str(r.header);
    question.multi = r.multi === true;
    for (const o of listOf(r.options)) {
      if (!isRecord(o)) continue;
      const option = o as Record<string, unknown>;
      question.options.push(new Choice(str(option.label), str(option.description)));
    }
    out.push(question);
  }
  return out;
};

const toolsOf = (v: unknown): ToolInfo[] => {
  const out: ToolInfo[] = [];
  for (const t of listOf(v)) {
    if (!isRecord(t)) continue;
    const r = t as Record<string, unknown>;
    if (str(r.name).length === 0) continue;
    const tool = new ToolInfo(str(r.name), str(r.server));
    if (str(r.id).length > 0) tool.id = str(r.id);
    tool.access = str(r.access);
    tool.scope = str(r.scope);
    out.push(tool);
  }
  return out;
};

const serversOf = (v: unknown): ServerInfo[] => {
  const out: ServerInfo[] = [];
  for (const s of listOf(v)) {
    if (!isRecord(s)) continue;
    const r = s as Record<string, unknown>;
    if (str(r.name).length > 0) out.push(new ServerInfo(str(r.name), str(r.status)));
  }
  return out;
};

const skillsOf = (v: unknown): SkillInfo[] => {
  const out: SkillInfo[] = [];
  for (const t of listOf(v)) {
    if (!isRecord(t)) continue;
    const r = t as Record<string, unknown>;
    if (str(r.name).length === 0) continue;
    const skill = new SkillInfo(str(r.name));
    skill.description = str(r.description);
    skill.source = str(r.source);
    skill.path = str(r.path);
    skill.command = str(r.command);
    out.push(skill);
  }
  return out;
};

const callFactsOf = (r: Record<string, unknown>): CallFacts => {
  const f = new CallFacts();
  f.category = stringOrNull(r.category);
  f.summary = stringOrNull(r.summary);
  f.paths = r.paths !== undefined ? strs(r.paths) : null;
  f.command = stringOrNull(r.command);
  f.written = stringOrNull(r.written);
  f.tool = stringOrNull(r.tool);
  f.todos = r.todos !== undefined ? todosOf(r.todos) : null;
  f.agentType = stringOrNull(r.agentType);
  f.agentTask = stringOrNull(r.agentTask);
  f.agentPrompt = stringOrNull(r.agentPrompt);
  return f;
};

/** A request event's fields from `v`; null when `v` is not an object. */
export const decodeRequest = (v: unknown): RequestFields | null => {
  if (!isRecord(v)) return null;
  const r = v as Record<string, unknown>;
  const f = new RequestFields();
  f.name = str(r.name);
  f.callId = str(r.callId);
  f.hasInput = r.input !== undefined;
  f.input = r.input;
  f.category = str(r.category);
  f.questions = questionsOf(r.questions);
  f.permission = r.permission === true;
  f.plan = str(r.plan);
  return f;
};

/** Read `v` as one event; null for a non-object or a type the model does not know. */
export const decodeEvent = (v: unknown): ConversationEvent | null => {
  if (!isRecord(v)) return null;
  const r = v as Record<string, unknown>;
  const type = str(r.type);
  if (type === "at") {
    const e = new AtEvent();
    fill(e, r, type);
    e.ms = num(r.ms, 0);
    return e;
  }
  if (type === "session") {
    const e = new SessionEvent();
    fill(e, r, type);
    e.id = str(r.id);
    e.model = str(r.model);
    e.cwd = str(r.cwd);
    e.mode = str(r.mode);
    e.effort = str(r.effort);
    e.hasEarlier = typeof r.earlier === "boolean";
    e.earlier = r.earlier === true;
    e.commands = r.commands !== undefined ? strs(r.commands) : null;
    return e;
  }
  if (type === "mode") {
    const e = new ModeEvent();
    fill(e, r, type);
    e.mode = str(r.mode);
    return e;
  }
  if (type === "status") {
    const e = new StatusEvent();
    fill(e, r, type);
    e.status = str(r.status);
    return e;
  }
  if (type === "take") {
    const e = new TakeEvent();
    fill(e, r, type);
    e.text = str(r.text);
    e.parts = strs(r.parts);
    return e;
  }
  if (type === "takeCommand") {
    const e = new TakeCommandEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "turn") {
    const e = new TurnEvent();
    fill(e, r, type);
    e.text = str(r.text);
    e.images = num(r.images, 0);
    e.prompt = r.prompt !== false;
    e.notice = r.notice === true;
    e.imagePaths = strs(r.imagePaths);
    return e;
  }
  if (type === "ensureTurn") {
    const e = new EnsureTurnEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "dropQueued") {
    const e = new DropQueuedEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "startQueued") {
    const e = new StartQueuedEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "closeChildren") {
    const e = new CloseChildrenEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "info") {
    const e = new InfoEvent();
    fill(e, r, type);
    e.fields = infoFieldsOf(r.fields);
    return e;
  }
  if (type === "close") {
    const e = new CloseEvent();
    fill(e, r, type);
    return e;
  }
  if (type === "end") {
    const e = new EndEvent();
    fill(e, r, type);
    e.error = r.error === true;
    e.reason = str(r.reason);
    e.status = str(r.status);
    e.durationMs = num(r.durationMs, 0);
    e.costUsd = num(r.costUsd, 0);
    e.text = str(r.text);
    return e;
  }
  if (type === "block") {
    const e = new BlockEvent();
    fill(e, r, type);
    e.key = str(r.key);
    e.kind = str(r.kind);
    e.name = str(r.name);
    e.text = str(r.text);
    e.facts = callFactsOf(r);
    return e;
  }
  if (type === "text") {
    const e = new TextEvent();
    fill(e, r, type);
    e.key = str(r.key);
    e.hasDelta = typeof r.delta === "string";
    e.delta = str(r.delta);
    e.text = str(r.text);
    return e;
  }
  if (type === "partial") {
    const e = new PartialEvent();
    fill(e, r, type);
    e.key = str(r.key);
    e.json = str(r.json);
    return e;
  }
  if (type === "input") {
    const e = new InputEvent();
    fill(e, r, type);
    e.key = str(r.key);
    e.hasInput = r.input !== undefined;
    e.input = r.input;
    e.name = str(r.name);
    return e;
  }
  if (type === "facts") {
    const e = new FactsEvent();
    fill(e, r, type);
    e.facts = callFactsOf(r);
    return e;
  }
  if (type === "finish") {
    const e = new FinishEvent();
    fill(e, r, type);
    e.key = str(r.key);
    return e;
  }
  if (type === "result") {
    const e = new ResultEvent();
    fill(e, r, type);
    e.text = str(r.text);
    e.images = num(r.images, 0);
    e.error = r.error === true;
    e.size = numberOrNull(r.size);
    e.hasSize = r.size !== undefined;
    e.truncated = str(r.truncated);
    e.patch = r.patch !== undefined ? patchOf(r.patch) : null;
    return e;
  }
  if (type === "edited") {
    const e = new EditedEvent();
    fill(e, r, type);
    e.path = str(r.path);
    return e;
  }
  if (type === "prompt") {
    const e = new PromptEvent();
    fill(e, r, type);
    e.text = str(r.text);
    e.images = num(r.images, 0);
    e.notice = r.notice === true;
    e.imagePaths = strs(r.imagePaths);
    return e;
  }
  if (type === "notice") {
    const e = new NoticeEvent();
    fill(e, r, type);
    e.text = str(r.text);
    e.once = r.once === true;
    e.ifOpen = r.ifOpen === true;
    e.tone = str(r.tone);
    e.detail = str(r.detail);
    return e;
  }
  if (type === "task") {
    const e = new TaskEvent();
    fill(e, r, type);
    e.taskId = str(r.taskId);
    e.description = str(r.description);
    e.agentType = str(r.agentType);
    e.background = r.background === true;
    return e;
  }
  if (type === "taskUpdate") {
    const e = new TaskUpdateEvent();
    fill(e, r, type);
    e.taskId = str(r.taskId);
    e.status = str(r.status);
    e.lastTool = str(r.lastTool);
    e.description = str(r.description);
    e.summary = stringOrNull(r.summary);
    e.done = r.done === true;
    return e;
  }
  if (type === "thinkingTokens") {
    const e = new ThinkingTokensEvent();
    fill(e, r, type);
    e.key = str(r.key);
    e.tokens = num(r.tokens, 0);
    return e;
  }
  if (type === "withdrawn") {
    const e = new WithdrawnEvent();
    fill(e, r, type);
    e.texts = strs(r.texts);
    return e;
  }
  if (type === "aside") {
    const e = new AsideEvent();
    fill(e, r, type);
    e.question = str(r.question);
    e.text = str(r.text);
    e.error = str(r.error);
    e.done = r.done === true;
    return e;
  }
  if (type === "tools") {
    const e = new ToolsEvent();
    fill(e, r, type);
    e.tools = toolsOf(r.tools);
    e.servers = serversOf(r.servers);
    e.partial = r.partial === true;
    return e;
  }
  if (type === "skills") {
    const e = new SkillsEvent();
    fill(e, r, type);
    e.skills = skillsOf(r.skills);
    e.partial = r.partial === true;
    return e;
  }
  if (type === "request") {
    const e = new RequestEvent();
    fill(e, r, type);
    const request = decodeRequest(r);
    if (request !== null) e.request = request;
    return e;
  }
  if (type === "cancelRequest") {
    const e = new CancelRequestEvent();
    fill(e, r, type);
    e.state = str(r.state);
    return e;
  }
  if (type === "usage") {
    const e = new UsageEvent();
    fill(e, r, type);
    e.model = str(r.model);
    e.version = str(r.version);
    e.contextUsed = numberOrNull(r.contextUsed);
    e.contextSize = numberOrNull(r.contextSize);
    e.costUsd = numberOrNull(r.costUsd);
    e.inputTokens = numberOrNull(r.inputTokens);
    e.outputTokens = numberOrNull(r.outputTokens);
    return e;
  }
  return null;
};
