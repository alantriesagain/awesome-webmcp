// The agent loop, in pi-agent-core's shape: a prompt appends the user's message, then the loop
// asks the model, streams its answer, records it, and asks again while there is more to do (a
// tool batch's results, a message steered in meanwhile) until the model stops; a steering message
// enters after the current request, a follow-up after the turn. A batch holding a mutating tool
// runs its calls one at a time in the model's order, a batch of read-only ones concurrently; the
// results go back in one user message in the model's order; a cancel mid-batch leaves synthetic
// results, since a tool call without its result is refused by the next request.
import { Abort } from "./abort.ts";
import { LoopListener } from "./listener.ts";
import { ModelClient, ModelRequest, StreamEnd, StreamListener } from "../model/client.ts";
import { CANCELLED, END_TURN, FAILED, MAX_TOKENS, Message, Part, TEXT, THINKING, TOOL_CALL, TOOL_RESULT, TOOL_USE, Usage, textPart } from "../model/message.ts";
import { ToolContext, ToolOutcome, ToolSet } from "../tools/tool.ts";

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
  messages: Message[] = [];
  system: string[] = [];
  model = "";
  effort = "";
  cwd = "";
  mode = "build";
  /** Messages sent while a turn ran, taken up after the current request. */
  steering: string[] = [];
  /** The files read in the session (absolute paths): what Edit and Write may change. */
  readonly reads = new Set<string>();
  private users = 0;
  private assistants = 0;

  /** The next user message's id ("u1", "u2", ...) or assistant message's ("m1", ...): what the chunks carry. */
  nextUserId(): string {
    this.users++;
    return "u" + String(this.users);
  }

  nextAssistantId(): string {
    this.assistants++;
    return "m" + String(this.assistants);
  }
}

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

  constructor(client: ModelClient, tools: ToolSet) {
    this.client = client;
    this.tools = tools;
  }

  /** One turn: the user's `text`, then requests until the model stops, the steering queue drained between them. */
  async run(s: LoopSession, text: string, listener: LoopListener, abort: Abort): Promise<TurnEnd> {
    const end = new TurnEnd();
    const user = new Message("user", s.nextUserId());
    user.parts.push(textPart(text));
    s.messages.push(user);
    const tools = this.tools.forMode(s.mode);
    for (;;) {
      const assistant = new Message("assistant", s.nextAssistantId());
      const got = await this.request(s, assistant, tools, listener, abort);
      if (assistant.parts.length > 0) s.messages.push(assistant);
      end.usage.add(got.usage);
      const onUsage = listener.onUsage;
      if (onUsage !== null) onUsage(got.usage);
      const calls = assistant.parts.filter((p) => p.kind === TOOL_CALL).map((p) => new Call(p));
      if (abort.aborted || got.stopReason === CANCELLED) {
        if (calls.length > 0) s.messages.push(this.results(s, calls, "interrupted"));
        end.stopReason = CANCELLED;
        return end;
      }
      if (got.stopReason === FAILED) {
        if (calls.length > 0) s.messages.push(this.results(s, calls, "the request failed: " + got.error));
        end.stopReason = FAILED;
        end.error = got.error;
        return end;
      }
      if (got.stopReason === MAX_TOKENS) {
        if (calls.length > 0) s.messages.push(this.results(s, calls, "the reply was cut off at the output limit; the call did not run"));
        end.stopReason = MAX_TOKENS;
        return end;
      }
      if (got.stopReason === TOOL_USE && calls.length > 0) {
        await this.batch(s, calls, tools, listener, abort);
        s.messages.push(this.results(s, calls, "interrupted"));
        if (abort.aborted) {
          end.stopReason = CANCELLED;
          return end;
        }
        this.steer(s);
        continue;
      }
      if (s.steering.length > 0) {
        this.steer(s);
        continue;
      }
      end.stopReason = got.stopReason;
      return end;
    }
  }

  /** The steering messages queued, as one user message. */
  private steer(s: LoopSession): void {
    if (s.steering.length === 0) return;
    const next = new Message("user", s.nextUserId());
    next.parts.push(textPart(s.steering.join("\n")));
    s.steering = [];
    s.messages.push(next);
  }

  /** One request: the stream into `assistant`'s parts and the listener. */
  private request(s: LoopSession, assistant: Message, tools: ToolSet, listener: LoopListener, abort: Abort): Promise<StreamEnd> {
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
    const req = new ModelRequest(s.model, s.system, s.messages);
    req.effort = s.effort;
    req.toolsJson = tools.json(this.extras);
    return this.client.stream(req, sl, abort);
  }

  /** Run the batch: one at a time when any call mutates, else together. */
  private async batch(s: LoopSession, calls: Call[], tools: ToolSet, listener: LoopListener, abort: Abort): Promise<void> {
    const ctx = new ToolContext(s.cwd, s.mode, s.reads);
    const sequential = calls.some((c) => {
      const t = tools.find(c.part.name);
      return t === null || t.mutating;
    });
    const one = async (c: Call): Promise<void> => {
      if (abort.aborted) return;
      const p = c.part;
      const why = tools.validate(p.name, p.inputJson);
      const onStart = listener.onToolStart;
      if (onStart !== null) onStart(p.callId, p.name, p.inputJson.length > 0 ? p.inputJson : "{}");
      let outcome: ToolOutcome;
      if (why.length > 0) outcome = ToolOutcome.failed(why);
      else {
        const onOutput = listener.onToolOutput;
        try {
          outcome = await tools.run(p.name, p.inputJson, ctx, abort, onOutput !== null ? (text: string) => onOutput(p.callId, text) : null);
        } catch (err) {
          outcome = ToolOutcome.failed(err instanceof Error ? err.message : "the tool failed");
        }
      }
      c.outcome = outcome;
      const onEnd = listener.onToolEnd;
      if (onEnd !== null) onEnd(p.callId, outcome);
    };
    if (sequential) for (const c of calls) await one(c);
    else await Promise.all(calls.map(one));
  }

  /** The batch's results as one user message, `missing` the text of a call that has none (cancelled, cut off). */
  private results(s: LoopSession, calls: Call[], missing: string): Message {
    const m = new Message("user", s.nextUserId());
    for (const c of calls) {
      const r = new Part(TOOL_RESULT);
      r.callId = c.part.callId;
      const o = c.outcome;
      if (o === null) {
        r.text = missing;
        r.isError = true;
      } else {
        r.text = o.text.length > RESULT_MAX ? o.text.slice(0, RESULT_MAX) + "\n[… cut at " + String(RESULT_MAX) + " characters]" : o.text;
        r.isError = o.isError;
      }
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
