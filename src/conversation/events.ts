// The conversation's changes as an agent's adapter plugin hands them over: a list of neutral events
// (`api.conversation.apply(events)`, one call per batch of its agent's messages), applied here to
// the model and the status. Each event names a call of the model (model.ts); widecode.d.ts types
// them for plugins. A block is named by the parent call it is under ("" for the turn) and its key
// (the adapter's own: a message and its index, a call's id).
import { ChatModel, Item, TaskInfo, ToolResult, TurnResult, AGENT, EDIT, READ, RUN, SEARCH, TEXT, THINKING, TOOL } from "./model.ts";
import { programsOf } from "./command.ts";
import { listOf } from "@lightstart/lib/json.ts";
import { StatusInfo } from "./status-info.ts";
import {
  AsideEvent,
  AtEvent,
  BlockEvent,
  CallFacts,
  CancelRequestEvent,
  CloseChildrenEvent,
  CloseEvent,
  ConversationEvent,
  decodeEvent,
  decodeRequest,
  DropQueuedEvent,
  EditedEvent,
  EndEvent,
  EnsureTurnEvent,
  FactsEvent,
  FinishEvent,
  InfoEvent,
  InfoFields,
  InputEvent,
  ModeEvent,
  NoticeEvent,
  PartialEvent,
  PromptEvent,
  RequestEvent,
  RequestFields,
  ResultEvent,
  SessionEvent,
  SkillsEvent,
  StartQueuedEvent,
  StatusEvent,
  TakeCommandEvent,
  TakeEvent,
  TaskEvent,
  TaskUpdateEvent,
  TextEvent,
  ThinkingTokensEvent,
  ToolsEvent,
  TurnEvent,
  UsageEvent,
  WithdrawnEvent,
} from "./event-types.ts";

/** Set the status fields `f` names. */
const setInfo = (info: StatusInfo, f: InfoFields): void => {
  if (f.sessionId !== null) info.sessionId = f.sessionId;
  if (f.transcriptPath !== null) info.transcriptPath = f.transcriptPath;
  if (f.cwd !== null) info.cwd = f.cwd;
  if (f.version !== null) info.version = f.version;
  if (f.modelId !== null) info.modelId = f.modelId;
  if (f.knownWindow !== null) info.knownWindow = f.knownWindow;
  if (f.mode !== null) info.mode = f.mode;
  if (f.contextInput !== null) info.contextInput = f.contextInput;
  if (f.contextOutput !== null) info.contextOutput = f.contextOutput;
  if (f.contextCacheRead !== null) info.contextCacheRead = f.contextCacheRead;
  if (f.contextCacheWrite !== null) info.contextCacheWrite = f.contextCacheWrite;
  if (f.contextSize !== null) info.contextSize = f.contextSize;
  if (f.totalInput !== null) info.totalInput = f.totalInput;
  if (f.totalOutput !== null) info.totalOutput = f.totalOutput;
  if (f.fiveHourPct !== null) info.fiveHourPct = f.fiveHourPct;
  if (f.fiveHourResets !== null) info.fiveHourResets = f.fiveHourResets;
  if (f.weekPct !== null) info.weekPct = f.weekPct;
  if (f.weekResets !== null) info.weekResets = f.weekResets;
  if (f.requests !== null) info.requests = f.requests;
  if (f.misses !== null) info.misses = f.misses;
  if (f.cacheRead !== null) info.cacheRead = f.cacheRead;
  if (f.allInput !== null) info.allInput = f.allInput;
  if (f.cacheTtlMs !== null) info.cacheTtlMs = f.cacheTtlMs;
  if (f.lastRequestMs !== null) info.lastRequestMs = f.lastRequestMs;
  if (f.costUsd !== null) info.costUsd = f.costUsd;
  if (f.startMs !== null) info.startMs = f.startMs;
  if (f.apiMs !== null) info.apiMs = f.apiMs;
  if (f.linesAdded !== null) info.linesAdded = f.linesAdded;
  if (f.linesRemoved !== null) info.linesRemoved = f.linesRemoved;
  if (f.thinking !== null) info.thinking = f.thinking;
};

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
const facts = (item: Item, f: CallFacts): void => {
  if (f.category !== null) item.category = f.category;
  if (f.summary !== null) item.summary = f.summary;
  if (f.paths !== null) item.paths = f.paths;
  if (f.command !== null) {
    item.command = f.command;
    item.programs = programsOf(f.command);
  }
  if (f.written !== null) item.written = f.written;
  if (f.tool !== null) item.tool = f.tool;
  if (f.todos !== null) item.todos = f.todos;
  if (f.agentType !== null) item.agentType = f.agentType;
  if (f.agentTask !== null) item.agentTask = f.agentTask;
  if (f.agentPrompt !== null) item.agentPrompt = f.agentPrompt;
};

/** Open request `id` as `f` has it: its category, name, the call it is for, questions, plan. */
const requestOf = (model: ChatModel, id: string, f: RequestFields, parent: string): Item => {
  const item = model.openRequest(id, f.name, f.callId, f.hasInput ? f.input : null, parent);
  item.category = f.category;
  item.questions = f.questions;
  item.permission = f.permission;
  item.text = f.plan;
  return item;
};

/** Open request `id` from `v`, a request event's fields without its type and id, under `parent` when it names a call; null when `v` is not an object. */
export const openRequest = (model: ChatModel, id: string, v: unknown, parent = ""): Item | null => {
  const f = decodeRequest(v);
  return f !== null ? requestOf(model, id, f, parent) : null;
};

/** Apply `events` (an array of event objects) to `model` and `info`; answers how many it applied. They happen now unless an `at` event says when. */
export const applyEvents = (model: ChatModel, info: StatusInfo, events: unknown): number => {
  model.now = Date.now();
  let applied = 0;
  for (const v of listOf(events)) {
    const e = decodeEvent(v);
    if (e === null) continue;
    if (applyEvent(model, info, e)) applied++;
  }
  return applied;
};

const applyEvent = (model: ChatModel, info: StatusInfo, e: ConversationEvent): boolean => {
  if (e instanceof AtEvent) model.now = e.ms;
  else if (e instanceof SessionEvent) {
    if (e.id.length > 0) model.sessionId = e.id;
    if (e.model.length > 0) model.model = e.model;
    if (e.cwd.length > 0) model.cwd = e.cwd;
    if (e.mode.length > 0) model.permissionMode = e.mode;
    if (e.effort.length > 0) model.effort = e.effort;
    if (e.hasEarlier) model.earlier = e.earlier;
    if (e.commands !== null) model.slashCommands = e.commands;
    model.bump();
  } else if (e instanceof ModeEvent) {
    model.permissionMode = e.mode;
    info.mode = e.mode;
    model.bump();
  } else if (e instanceof StatusEvent) {
    model.status = e.status;
    model.bump();
  } else if (e instanceof TakeEvent) model.take(e.text, e.parts);
  else if (e instanceof TakeCommandEvent) model.takeCommand();
  else if (e instanceof TurnEvent) {
    const turn = model.openTurn(e.text, e.images, e.prompt);
    if (turn.prompt !== null) {
      if (e.notice) turn.prompt.tone = "notice";
      turn.prompt.imagePaths = e.imagePaths;
    }
  } else if (e instanceof EnsureTurnEvent) model.turn();
  // The messages queued are dropped (the agent's process ended with them unsent).
  else if (e instanceof DropQueuedEvent) {
    model.pending = [];
    model.bump();
  }
  // The oldest queued message is taken up now (a compaction answering /compact), when no turn is open.
  else if (e instanceof StartQueuedEvent) {
    if (model.current === null && model.pending.length > 0) model.turn();
  } else if (e instanceof CloseChildrenEvent) {
    // What ran under a call (a subagent's transcript, read) stops where it is.
    const tool = model.tool(e.id);
    if (tool === null) return true;
    model.closeItems(tool.children);
    model.touch(tool);
  } else if (e instanceof InfoEvent) {
    if (e.fields !== null) setInfo(info, e.fields);
    model.bump();
  } else if (e instanceof CloseEvent) model.closeTurn(null);
  else if (e instanceof EndEvent) {
    const result = new TurnResult();
    result.isError = e.error;
    result.reason = e.reason;
    result.subtype = e.status;
    result.durationMs = e.durationMs;
    result.costUsd = e.costUsd;
    result.text = e.text;
    model.finishTurn(result);
  } else if (e instanceof BlockEvent) {
    const kind = kindOf(e.kind);
    const item = model.block(e.parent, e.key, kind, e.id, e.name, e.text);
    if (item === null) return true;
    if (kind === TOOL) {
      const before = item.category;
      facts(item, e.facts);
      counted(info, item, before);
    }
  } else if (e instanceof TextEvent) {
    const item = model.findBlock(e.parent, e.key);
    if (item === null) return true;
    if (e.hasDelta) item.text += e.delta;
    else item.text = e.text;
    model.touch(item);
  } else if (e instanceof PartialEvent) {
    const item = model.findBlock(e.parent, e.key);
    if (item === null) return true;
    item.partial += e.json;
    model.touch(item);
  } else if (e instanceof InputEvent) {
    const item = model.findBlock(e.parent, e.key);
    if (item === null) return true;
    if (e.hasInput) item.input = e.input;
    if (e.name.length > 0) item.name = e.name;
    model.touch(item);
  } else if (e instanceof FactsEvent) {
    const item = model.tool(e.id);
    if (item === null) return true;
    const before = item.category;
    facts(item, e.facts);
    counted(info, item, before);
    model.touch(item);
  } else if (e instanceof FinishEvent) {
    const item = model.findBlock(e.parent, e.key);
    if (item !== null && !item.done) model.finish(item);
  } else if (e instanceof ResultEvent) {
    const result = new ToolResult();
    result.text = e.text;
    result.images = e.images;
    result.isError = e.error;
    result.size = e.size !== null ? e.size : result.text.length;
    result.truncated = e.truncated;
    // A result widecode's MCP server cut says so in its text, with the full size: read it back when
    // the agent's event does not.
    if (result.truncated.length === 0) {
      const note = result.text.indexOf("[widecode cut this result:");
      if (note >= 0) {
        result.truncated = "widecode";
        const found = /it was (\d+) characters/.exec(result.text);
        if (found !== null && !e.hasSize) result.size = Number(found[1]);
      }
    }
    if (e.patch !== null) {
      result.patch = e.patch;
      result.hasPatch = result.patch.length > 0;
    }
    model.toolResult(e.id, result);
  } else if (e instanceof EditedEvent) model.editedFile(e.path);
  else if (e instanceof PromptEvent) {
    const p = model.prompt(e.parent, e.text, e.images);
    if (p === null) return true;
    if (e.notice) p.tone = "notice";
    p.imagePaths = e.imagePaths;
  } else if (e instanceof NoticeEvent) {
    if (e.once && model.lastNoticeIs(e.text)) return true;
    if (e.ifOpen && model.current === null) return true;
    model.notice(e.text, e.tone.length > 0 ? e.tone : "info", e.detail, e.parent);
  } else if (e instanceof TaskEvent) {
    const task = new TaskInfo();
    task.taskId = e.taskId;
    task.description = e.description;
    task.subagentType = e.agentType;
    task.background = e.background;
    model.startTask(e.id, task);
  } else if (e instanceof TaskUpdateEvent) {
    const tool = model.taskCall(e.id, e.taskId);
    if (tool === null || tool.task === null) return true;
    const task = tool.task;
    const status = e.status;
    if (status.length > 0) task.status = status;
    if (e.lastTool.length > 0) task.lastTool = e.lastTool;
    if (e.description.length > 0) task.description = e.description;
    if (e.summary !== null) task.summary = e.summary;
    if (e.done) model.closeItems(tool.children);
    // The run itself ended or was stopped: a question it left open is answered cancelled.
    if (status === "done" || status === "stopped" || status === "failed") model.cancelRequestsUnder(tool);
    model.touch(tool);
  } else if (e instanceof ThinkingTokensEvent) {
    const item = model.findBlock(e.parent, e.key);
    if (item === null) return true;
    item.tokens = e.tokens;
    model.touch(item);
  } else if (e instanceof WithdrawnEvent) model.withdraw(e.texts);
  else if (e instanceof AsideEvent) model.aside(e.id, e.question, e.text, e.error, e.done);
  else if (e instanceof ToolsEvent) {
    model.available = e.tools;
    model.servers = e.servers;
    model.availableKnown = true;
    model.ownKnown = !e.partial;
    model.bump();
  } else if (e instanceof SkillsEvent) {
    model.skills = e.skills;
    model.skillsKnown = true;
    model.skillsPartial = e.partial;
    model.bump();
  } else if (e instanceof RequestEvent) requestOf(model, e.id, e.request, e.parent);
  // Answered without the panel (an answer the user gave before covers it), else withdrawn by the agent.
  else if (e instanceof CancelRequestEvent) {
    if (e.state === "answered") model.settle(e.id, "answered");
    else model.cancelRequest(e.id);
  }
  else if (e instanceof UsageEvent) {
    if (e.model.length > 0) info.modelId = e.model;
    if (e.version.length > 0) info.version = e.version;
    if (e.contextUsed !== null) {
      info.contextInput = e.contextUsed;
      info.contextCacheRead = 0;
      info.contextCacheWrite = 0;
    }
    if (e.contextSize !== null) info.contextSize = e.contextSize;
    if (e.costUsd !== null) info.costUsd = e.costUsd;
    if (e.inputTokens !== null) info.totalInput = e.inputTokens;
    if (e.outputTokens !== null) info.totalOutput = e.outputTokens;
    model.bump();
  }
  return true;
};

/** Whether `e` is an event a subagent run may apply: the work under its call, never the turn's own life or the main status. */
const isSubagentEvent = (e: ConversationEvent): boolean =>
  e instanceof BlockEvent ||
  e instanceof TextEvent ||
  e instanceof PartialEvent ||
  e instanceof InputEvent ||
  e instanceof FactsEvent ||
  e instanceof FinishEvent ||
  e instanceof ResultEvent ||
  e instanceof EditedEvent ||
  e instanceof PromptEvent ||
  e instanceof NoticeEvent ||
  e instanceof TaskEvent ||
  e instanceof TaskUpdateEvent ||
  e instanceof ThinkingTokensEvent ||
  e instanceof UsageEvent ||
  e instanceof RequestEvent ||
  e instanceof CancelRequestEvent;

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
    const e = decodeEvent(v);
    if (e === null || !isSubagentEvent(e)) continue;
    if (e.parent.length === 0) e.parent = callId;
    let target = info;
    if (!historical && status !== null && e instanceof FactsEvent && e.id === callId) target = status;
    if (applyEvent(model, target, e)) applied++;
  }
  return applied;
};
