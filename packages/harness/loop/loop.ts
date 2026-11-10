// The agent loop, in pi-agent-core's shape: a prompt appends the user's message, then the loop
// asks the model, streams its answer, records it, and asks again while there is more to do (a
// tool batch's results, a message steered in meanwhile) until the model stops; a steering message
// enters after the current request, a follow-up after the turn. A batch holding a mutating tool
// runs its calls one at a time in the model's order, a batch of read-only ones concurrently; the
// results go back in one user message in the model's order; a cancel mid-batch leaves synthetic
// results, since a tool call without its result is refused by the next request. Before a request
// the context's size is estimated (the last real count plus what came since) and compacted past
// the threshold: the earlier messages summarized, the summary sent first from then on.
import { Abort } from "./abort.ts";
import { CompactionResult, KEEP_TOKENS, compactThreshold, contextAfter, cutPoint, summarize, withSummary } from "./compact.ts";
import { LoopListener } from "./listener.ts";
import { messagesTokens } from "./tokens.ts";
import { ModelClient, ModelRequest, StreamEnd, StreamListener } from "../model/client.ts";
import { CANCELLED, END_TURN, FAILED, MAX_TOKENS, Message, Part, TEXT, THINKING, TOOL_CALL, TOOL_RESULT, TOOL_USE, Usage, textPart } from "../model/message.ts";
import { McpLink } from "../tools/mcp.ts";
import { WebSettings } from "../tools/web.ts";
import { DenyRule, deniedBy } from "../tools/permissions.ts";
import { parseJson, recordOf } from "@light/lib/json.ts";
import { Tool, ToolContext, ToolOutcome, ToolSet } from "../tools/tool.ts";
import { turnNote } from "../prompt/system.ts";
import { ExtSession } from "../ext/extensions.ts";
import { ExtContext } from "../ext/context.ts";

const two = (n: number): string => (n < 10 ? "0" : "") + String(n);

/** What a subagent is told after the parent's system prompt. */
const SUBAGENT_NOTE =
  "You are a subagent: the main agent gave you the task in the first message and sees nothing of your work but your last reply. Work on the task with your tools, then end with a short report of what you found or did: the facts, file paths and lines the main agent needs, and anything you could not do.";

/** Today's date, the local one. */
const today = (): string => {
  const d = new Date();
  return String(d.getFullYear()) + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
};

/** What a tool result keeps for the model: the text, within this. */
const RESULT_MAX = 40000;

/** How a turn ended: the stop reason, what its requests used in all, the error when it failed. */
export class TurnEnd {
  stopReason = END_TURN;
  usage = new Usage();
  error = "";
}

/** What the loop keeps for one session: the messages, the system prompt's blocks, the model and effort, the folder and mode, ids, the queues. */
export class LoopSession {
  /** The session's id, what its extension dialogs go out with ("" for a subagent's). */
  id = "";
  /** Whether the client takes `_widecode/ui` (a session's extensions may ask it). */
  hasUI = false;
  /** The context: the messages since the last compaction. */
  messages: Message[] = [];
  /** The last compaction's summary, standing for what came before `messages` ("" for none). */
  summary = "";
  system: string[] = [];
  model = "";
  effort = "";
  cwd = "";
  mode = "build";
  /** Messages sent while a turn ran, taken up after the current request. */
  steering: string[] = [];
  /** The files read in the session (absolute paths): what Edit and Write may change. */
  readonly reads = new Set<string>();
  /** The model's window, what the compaction threshold is cut from. */
  window = 200000;
  /** The session's MCP servers and their tools, offered beside the mode's. */
  servers: McpLink[] = [];
  extraTools: Tool[] = [];
  /** What the Skill tool reads: the folder's skills when trusted, the user's home, the harness's folder. */
  trusted = false;
  home = "";
  harnessRoot = "";
  /** What the web tools have. */
  web = new WebSettings();
  /** The calls refused (permissions.deny). */
  deny: DenyRule[] = [];
  /** Whether the model reads images, and the images the next prompt carries (taken by `run`). */
  vision = false;
  pendingImages: Part[] = [];
  /** The session's extension instance (null for none). */
  ext: ExtSession | null = null;
  /** A `before_agent_start` handler's custom user messages, added after the prompt. */
  pendingNotes: string[] = [];
  /** The context's size after the last request (its real count), and how many messages there were then. */
  contextTokens = 0;
  sinceIndex = 0;
  private users = 0;
  private assistants = 0;

  /** The context's size now: the last real count, plus what came since, estimated. */
  contextEstimate(): number {
    return this.contextTokens + messagesTokens(this.messages.slice(this.sinceIndex));
  }

  /** The context's size as a request reported it. */
  noteContext(tokens: number): void {
    this.contextTokens = tokens;
    this.sinceIndex = this.messages.length;
  }

  /** The next user message's id ("u1", "u2", ...) or assistant message's ("m1", ...): what the chunks carry. */
  nextUserId(): string {
    this.users++;
    return "u" + String(this.users);
  }

  nextAssistantId(): string {
    this.assistants++;
    return "m" + String(this.assistants);
  }

  /** The conversation so far, from a session file: the ids given from here on come after those loaded. */
  takeMessages(messages: Message[]): void {
    this.messages = messages;
    for (const m of messages) {
      const n = /^([um])(\d+)$/.exec(m.id);
      if (n === null) continue;
      if (n[1] === "u" && Number(n[2]) > this.users) this.users = Number(n[2]);
      if (n[1] === "m" && Number(n[2]) > this.assistants) this.assistants = Number(n[2]);
    }
  }
}

/** The results a loaded conversation's last message lacks (its process ended mid-batch): one error result per call, "interrupted"; null when it ends well. */
export const danglingResults = (s: LoopSession): Message | null => {
  const last = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;
  if (last === null || last.role !== "assistant" || !last.parts.some((p) => p.kind === TOOL_CALL)) return null;
  const m = new Message("user", s.nextUserId());
  for (const p of last.parts) {
    if (p.kind !== TOOL_CALL) continue;
    const r = new Part(TOOL_RESULT);
    r.callId = p.callId;
    r.text = "interrupted";
    r.isError = true;
    r.acpJson = ToolOutcome.failed("interrupted").json("other", p.name);
    m.parts.push(r);
  }
  return m;
};

/** A tool call of a batch and its result. */
class Call {
  readonly part: Part;
  outcome: ToolOutcome | null = null;

  constructor(part: Part) {
    this.part = part;
  }
}

export class AgentLoop {
  readonly client: ModelClient;
  /** The tools every session has; a mode takes its share. */
  tools: ToolSet;
  /** Whether the provider takes Anthropic's extras in the tools list. */
  extras = true;
  /** The context size past which a session is compacted (the config's), and the tail an automatic compaction keeps. */
  compactAt = 200000;
  keepTokens = KEEP_TOKENS;

  constructor(client: ModelClient, tools: ToolSet) {
    this.client = client;
    this.tools = tools;
  }

  /** One turn: the user's `text`, then requests until the model stops, the steering queue drained between them. */
  async run(s: LoopSession, text: string, listener: LoopListener, abort: Abort): Promise<TurnEnd> {
    const end = new TurnEnd();
    const user = new Message("user", s.nextUserId());
    user.parts.push(textPart(text));
    for (const img of s.pendingImages) user.parts.push(img);
    s.pendingImages = [];
    this.add(s, user, listener);
    for (const note of s.pendingNotes) {
      const m = new Message("user", s.nextUserId());
      m.parts.push(textPart(note));
      this.add(s, m, listener);
    }
    s.pendingNotes = [];
    for (;;) {
      // The mode's tools as it stands now (a plan approved mid-turn leaves plan mode).
      const tools = this.tools.forMode(s.mode).plus(s.extraTools);
      if (s.contextEstimate() > compactThreshold(s.window, this.compactAt)) {
        const c = await this.compactContext(s, this.keepTokens, "", abort);
        if (c !== null && c.error.length === 0) {
          const fn = listener.onCompaction;
          if (fn !== null) fn(c);
        }
        if (abort.aborted) {
          end.stopReason = CANCELLED;
          return end;
        }
      }
      const assistant = new Message("assistant", s.nextAssistantId());
      const got = await this.request(s, assistant, tools, listener, abort);
      if (assistant.parts.length > 0) this.add(s, assistant, listener);
      if (got.usage.input > 0) s.noteContext(got.usage.context());
      end.usage.add(got.usage);
      const onUsage = listener.onUsage;
      if (onUsage !== null) onUsage(got.usage);
      const calls = assistant.parts.filter((p) => p.kind === TOOL_CALL).map((p) => new Call(p));
      if (abort.aborted || got.stopReason === CANCELLED) {
        if (calls.length > 0) this.add(s, this.results(s, calls, tools, "interrupted"), listener);
        end.stopReason = CANCELLED;
        return end;
      }
      if (got.stopReason === FAILED) {
        if (calls.length > 0) this.add(s, this.results(s, calls, tools, "the request failed: " + got.error), listener);
        end.stopReason = FAILED;
        end.error = got.error;
        return end;
      }
      if (got.stopReason === MAX_TOKENS) {
        if (calls.length > 0) this.add(s, this.results(s, calls, tools, "the reply was cut off at the output limit; the call did not run"), listener);
        end.stopReason = MAX_TOKENS;
        return end;
      }
      if (got.stopReason === TOOL_USE && calls.length > 0) {
        await this.batch(s, calls, tools, listener, abort);
        this.add(s, this.results(s, calls, tools, "interrupted"), listener);
        if (abort.aborted) {
          end.stopReason = CANCELLED;
          return end;
        }
        this.steer(s, listener);
        continue;
      }
      if (s.steering.length > 0) {
        this.steer(s, listener);
        continue;
      }
      end.stopReason = got.stopReason;
      return end;
    }
  }

  /** `m` joins the conversation; the listener hears it (a session file keeps it). */
  private add(s: LoopSession, m: Message, listener: LoopListener): void {
    s.messages.push(m);
    const fn = listener.onMessage;
    if (fn !== null) fn(m);
  }

  /** Compact the context: the messages before the last `keep` tokens summarized (everything, with `keep` 0), the summary standing for them from now on. Null when there is nothing before the kept tail; `error` set when the model gave no summary. */
  async compactContext(s: LoopSession, keep: number, hint: string, abort: Abort): Promise<CompactionResult | null> {
    const cut = cutPoint(s.messages, keep);
    if (cut === 0) return null;
    const c = new CompactionResult();
    c.tokensBefore = s.contextEstimate();
    const got = await summarize(this.client, s.model, s.summary, s.messages.slice(0, cut), hint, abort);
    if (got[0].length === 0) {
      c.error = got[1].length > 0 ? got[1] : "the model gave no summary";
      return c;
    }
    c.summary = got[0];
    c.firstKeptId = cut < s.messages.length ? s.messages[cut].id : "";
    s.summary = c.summary;
    s.messages = s.messages.slice(cut);
    c.tokensAfter = contextAfter(s.summary, s.messages);
    s.noteContext(c.tokensAfter);
    return c;
  }

  /** A Task call: its prompt run as a session of its own on the same model, folder and mode, with the tools but Task; its last reply is the call's text, its requests' usage the parent's cost. */
  private async subagent(s: LoopSession, inputJson: string, listener: LoopListener, abort: Abort): Promise<ToolOutcome> {
    const input = recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {};
    const prompt = typeof input["prompt"] === "string" ? (input["prompt"] as string) : "";
    if (prompt.trim().length === 0) return ToolOutcome.failed("Task needs a prompt");
    const sub = new LoopSession();
    sub.system = s.system.concat([SUBAGENT_NOTE]);
    sub.model = s.model;
    sub.effort = s.effort;
    sub.cwd = s.cwd;
    sub.mode = s.mode;
    sub.window = s.window;
    sub.servers = s.servers;
    sub.extraTools = s.extraTools;
    sub.trusted = s.trusted;
    sub.home = s.home;
    sub.harnessRoot = s.harnessRoot;
    sub.web = s.web;
    sub.deny = s.deny;
    sub.vision = s.vision;
    sub.ext = s.ext;
    const loop = new AgentLoop(this.client, this.tools.without("Task"));
    loop.extras = this.extras;
    loop.compactAt = this.compactAt;
    loop.keepTokens = this.keepTokens;
    const inner = new LoopListener();
    let last = "";
    let calls = 0;
    inner.onUsage = (u: Usage) => {
      const fn = listener.onSubUsage;
      if (fn !== null) fn(u);
    };
    inner.onSubUsage = inner.onUsage;
    inner.onMessage = (m: Message) => {
      if (m.role === "assistant" && m.text().trim().length > 0) last = m.text().trim();
    };
    inner.onToolStart = (_callId: string, _name: string, _input: string) => {
      calls++;
    };
    const end = await loop.run(sub, prompt, inner, abort);
    if (end.stopReason === CANCELLED || abort.aborted) return ToolOutcome.failed("interrupted");
    if (end.stopReason === FAILED) return ToolOutcome.failed("the subagent failed: " + end.error + (last.length > 0 ? "\n\nIts last words: " + last : ""));
    const o = new ToolOutcome();
    o.text = last.length > 0 ? last : "The subagent ended without a reply.";
    o.rawOutputJson = '{"calls":' + String(calls) + ',"stopReason":' + JSON.stringify(end.stopReason) + "}";
    return o;
  }

  /** The steering messages queued, as one user message. */
  private steer(s: LoopSession, listener: LoopListener): void {
    if (s.steering.length === 0) return;
    const next = new Message("user", s.nextUserId());
    next.parts.push(textPart(s.steering.join("\n")));
    s.steering = [];
    this.add(s, next, listener);
  }

  /** The context a session's extension callbacks get. */
  private extContext(s: LoopSession, abort: Abort, systemPrompt: string): ExtContext {
    const c = new ExtContext();
    c.sessionId = s.id;
    c.cwd = s.cwd;
    c.modelValue = s.model;
    c.systemPrompt = systemPrompt;
    c.tokens = s.contextEstimate();
    c.window = s.window;
    c.aborted = abort.aborted;
    c.idle = false;
    c.hasUI = s.hasUI && s.id.length > 0;
    c.abort = () => abort.fire();
    return c;
  }

  /** One request: the stream into `assistant`'s parts and the listener. */
  private async request(s: LoopSession, assistant: Message, tools: ToolSet, listener: LoopListener, abort: Abort): Promise<StreamEnd> {
    let textAt: Part | null = null;
    let thoughtAt: Part | null = null;
    const calls = new Map<string, Part>();
    const sl = new StreamListener();
    sl.onText = (delta: string) => {
      if (textAt === null) {
        textAt = textPart("");
        assistant.parts.push(textAt);
      }
      textAt.text += delta;
      const fn = listener.onText;
      if (fn !== null) fn(assistant.id, delta);
    };
    sl.onThinking = (delta: string) => {
      if (thoughtAt === null) {
        thoughtAt = new Part(THINKING);
        assistant.parts.push(thoughtAt);
      }
      thoughtAt.text += delta;
      const fn = listener.onThinking;
      if (fn !== null) fn(assistant.id, delta);
    };
    sl.onSignature = (delta: string) => {
      if (thoughtAt !== null) thoughtAt.signature += delta;
    };
    sl.onToolCallStart = (id: string, name: string) => {
      const p = new Part(TOOL_CALL);
      p.callId = id;
      p.name = name;
      calls.set(id, p);
      assistant.parts.push(p);
      // A later text or thought is another block.
      textAt = null;
      thoughtAt = null;
    };
    sl.onToolCallDelta = (id: string, json: string) => {
      const p = calls.get(id);
      if (p !== undefined) p.inputJson += json;
    };
    const planTool = s.extraTools.find((t) => t.name.endsWith("__PresentPlan")) ?? null;
    const system = s.system.slice();
    system.push(turnNote(today(), s.mode, planTool !== null ? planTool.name : ""));
    let messages = withSummary(s.summary, s.messages);
    const ext = s.ext;
    if (ext !== null) {
      const replaced = await ext.context(messages, this.extContext(s, abort, system.join("\n\n")));
      if (replaced !== null) messages = replaced;
    }
    const req = new ModelRequest(s.model, system, messages);
    req.systemCached = s.system.length;
    req.effort = s.effort;
    req.toolsJson = tools.json(this.extras);
    req.toolsOpenAiJson = tools.openAiJson();
    return this.client.stream(req, sl, abort);
  }

  /** Run the batch: one at a time when any call mutates, else together. */
  private async batch(s: LoopSession, calls: Call[], tools: ToolSet, listener: LoopListener, abort: Abort): Promise<void> {
    const ctx = new ToolContext(s.cwd, s.mode, s.reads);
    ctx.servers = s.servers;
    ctx.trusted = s.trusted;
    ctx.home = s.home;
    ctx.harnessRoot = s.harnessRoot;
    ctx.web = s.web;
    ctx.vision = s.vision;
    ctx.modelValue = s.model;
    ctx.systemPrompt = s.system.join("\n\n");
    ctx.tokens = s.contextEstimate();
    ctx.window = s.window;
    ctx.sessionId = s.id;
    ctx.hasUI = s.hasUI && s.id.length > 0;
    const sequential = calls.some((c) => {
      const t = tools.find(c.part.name);
      return t === null || t.mutating;
    });
    const one = async (c: Call): Promise<void> => {
      if (abort.aborted) return;
      const p = c.part;
      const why = tools.checkInput(p.name, p.inputJson);
      const onStart = listener.onToolStart;
      if (onStart !== null) onStart(p.callId, p.name, p.inputJson.length > 0 ? p.inputJson : "{}");
      let inputJson = p.inputJson.length > 0 ? p.inputJson : "{}";
      let blocked = "";
      let ran = false;
      const ext = s.ext;
      const extCtx = ext !== null ? this.extContext(s, abort, s.system.join("\n\n")) : null;
      if (why.length === 0 && ext !== null && extCtx !== null) {
        const decision = await ext.toolCall(p.callId, p.name, inputJson, extCtx);
        if (decision.block) blocked = decision.reason;
        else inputJson = decision.inputJson;
      }
      let outcome: ToolOutcome;
      const refused = why.length > 0 || blocked.length > 0 ? "" : deniedBy(s.deny, p.name, recordOf(parseJson(inputJson)) ?? {}, s.cwd, s.home);
      if (why.length > 0) outcome = ToolOutcome.failed(why);
      else if (blocked.length > 0) outcome = ToolOutcome.failed(blocked);
      else if (refused.length > 0) outcome = ToolOutcome.failed("refused by the rule " + refused + " in permissions.deny: take another way, or ask the user");
      else {
        const onOutput = listener.onToolOutput;
        ran = true;
        try {
          outcome = p.name === "Task" ? await this.subagent(s, inputJson, listener, abort) : await tools.run(p.name, inputJson, ctx, abort, onOutput !== null ? (text: string) => onOutput(p.callId, text) : null);
        } catch (err) {
          outcome = ToolOutcome.failed(err instanceof Error ? err.message : "the tool failed");
        }
      }
      if (ran && ext !== null && extCtx !== null) await ext.toolResult(p.callId, p.name, inputJson, outcome, extCtx);
      c.outcome = outcome;
      const onEnd = listener.onToolEnd;
      if (onEnd !== null) onEnd(p.callId, outcome);
    };
    if (sequential) for (const c of calls) await one(c);
    else await Promise.all(calls.map(one));
  }

  /** The batch's results as one user message, `missing` the text of a call that has none (cancelled, cut off); each keeps its outcome, for a later load. */
  private results(s: LoopSession, calls: Call[], tools: ToolSet, missing: string): Message {
    const m = new Message("user", s.nextUserId());
    for (const c of calls) {
      const r = new Part(TOOL_RESULT);
      r.callId = c.part.callId;
      const o = c.outcome !== null ? c.outcome : ToolOutcome.failed(missing);
      r.text = o.text.length > RESULT_MAX ? o.text.slice(0, RESULT_MAX) + "\n[… cut at " + String(RESULT_MAX) + " characters]" : o.text;
      r.isError = o.isError;
      // An image the call gives goes with its result.
      r.mediaType = o.imageType;
      r.data = o.imageData;
      const t = tools.find(c.part.name);
      r.acpJson = o.json(t !== null ? t.kind : "other", t !== null ? t.title : c.part.name);
      m.parts.push(r);
    }
    return m;
  }
}

/** The last text the user sent in `messages` ("" for none). */
export const lastUserText = (messages: Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].text();
  return "";
};

export { TEXT };
