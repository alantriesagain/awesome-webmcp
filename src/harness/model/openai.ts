// The OpenAI-compatible chat completions API: the request as JSON text and the stream read into
// the listener. It covers the providers that speak it (OpenCode Zen's DeepSeek, GLM, Kimi and
// Qwen models, DeepSeek's own endpoint, OpenRouter, Groq, a local server): a system message, the
// user's and the assistant's, tool calls as `tool_calls` and their results as `tool` messages; a
// reasoning model's thinking arrives as `reasoning_content` (or `reasoning`) and goes back on the
// assistant's messages, which DeepSeek and Kimi require once tools are in the request. Thinking is
// asked for by the model's kind: `toggle` sends `thinking: {type: "enabled"}`, `effort` sends
// `reasoning_effort`, any other leaves the model's default. Usage comes in the last chunk
// (`stream_options.include_usage`), the cached share from `prompt_tokens_details.cached_tokens`
// or DeepSeek's `prompt_cache_hit_tokens`.
import { listOf, num, recordOf, str } from "@lightstart/lib/json.ts";
import { Abort, Stopper } from "../loop/abort.ts";
import { Auth } from "../auth.ts";
import { HttpRequest, HttpStream } from "../http/stream.ts";
import { ModelRequest, StreamEnd, StreamListener } from "./client.ts";
import { CANCELLED, END_TURN, FAILED, IMAGE, MAX_TOKENS, Message, TEXT, THINKING, TOOL_CALL, TOOL_RESULT, TOOL_USE } from "./message.ts";
import { EFFORT, ModelInfo, ModelRegistry, Provider, TOGGLE } from "./registry.ts";
import { SseEvent, SseSplitter } from "./sse.ts";

const RETRIES = 3;

/** A user message's parts as chat messages: its tool results first, one `tool` message each, then its text and images as one user message. */
const userMessages = (m: Message): string[] => {
  const out: string[] = [];
  for (const p of m.parts) if (p.kind === TOOL_RESULT) out.push('{"role":"tool","tool_call_id":' + JSON.stringify(p.callId) + ',"content":' + JSON.stringify(p.isError ? "Error: " + p.text : p.text) + "}");
  // A tool message holds text alone: the images results gave follow as a user message.
  const shown: string[] = [];
  for (const p of m.parts) if (p.kind === TOOL_RESULT && p.data.length > 0) shown.push('{"type":"text","text":' + JSON.stringify("The image from call " + p.callId + ":") + '},{"type":"image_url","image_url":{"url":' + JSON.stringify("data:" + p.mediaType + ";base64," + p.data) + "}}");
  if (shown.length > 0) out.push('{"role":"user","content":[' + shown.join(",") + "]}");
  const content: string[] = [];
  let images = false;
  for (const p of m.parts) {
    if (p.kind === TEXT && p.text.length > 0) content.push('{"type":"text","text":' + JSON.stringify(p.text) + "}");
    else if (p.kind === IMAGE) {
      images = true;
      content.push('{"type":"image_url","image_url":{"url":' + JSON.stringify("data:" + p.mediaType + ";base64," + p.data) + "}}");
    }
  }
  if (content.length === 0) return out;
  // Text alone goes as a string, which every server takes; images need the list.
  out.push('{"role":"user","content":' + (images ? "[" + content.join(",") + "]" : JSON.stringify(m.parts.filter((p) => p.kind === TEXT).map((p) => p.text).join("\n"))) + "}");
  return out;
};

/** An assistant message as one chat message: its text, its thinking under `reasoningField`, its tool calls. */
const assistantMessage = (m: Message, reasoningField: string): string => {
  const text = m.parts.filter((p) => p.kind === TEXT).map((p) => p.text).join("");
  const thinking = m.parts.filter((p) => p.kind === THINKING).map((p) => p.text).join("");
  const calls = m.parts.filter((p) => p.kind === TOOL_CALL);
  const fields = ['"role":"assistant"', '"content":' + (text.length > 0 ? JSON.stringify(text) : calls.length > 0 ? "null" : '""')];
  if (thinking.length > 0 && reasoningField.length > 0) fields.push(JSON.stringify(reasoningField) + ":" + JSON.stringify(thinking));
  if (calls.length > 0) fields.push('"tool_calls":[' + calls.map((c) => '{"id":' + JSON.stringify(c.callId) + ',"type":"function","function":{"name":' + JSON.stringify(c.name) + ',"arguments":' + JSON.stringify(c.inputJson.length > 0 ? c.inputJson : "{}") + "}}").join(",") + "]");
  return "{" + fields.join(",") + "}";
};

/** The conversation as chat messages, the system prompt's blocks joined in one system message first. */
export const chatMessagesJson = (system: string[], messages: Message[], reasoningField: string): string => {
  const out: string[] = [];
  if (system.length > 0) out.push('{"role":"system","content":' + JSON.stringify(system.join("\n\n")) + "}");
  for (const m of messages) {
    if (m.role === "assistant") out.push(assistantMessage(m, reasoningField));
    else for (const u of userMessages(m)) out.push(u);
  }
  return "[" + out.join(",") + "]";
};

/** The request's body for `model`. */
export const chatRequestBody = (req: ModelRequest, model: ModelInfo): string => {
  const parts: string[] = ['"model":' + JSON.stringify(model.id), '"stream":true', '"stream_options":{"include_usage":true}', '"max_tokens":' + String(model.maxOutput)];
  parts.push('"messages":' + chatMessagesJson(req.system, req.messages, model.reasoningField));
  if (req.toolsOpenAiJson.length > 0) parts.push('"tools":' + req.toolsOpenAiJson);
  const effort = model.efforts.includes(req.effort) ? req.effort : "";
  if (model.thinking === TOGGLE) parts.push('"thinking":{"type":' + (effort === "off" ? '"disabled"' : '"enabled"') + "}");
  else if (model.thinking === EFFORT && effort.length > 0) parts.push('"reasoning_effort":' + JSON.stringify(effort));
  return "{" + parts.join(",") + "}";
};

/** A tool call as it streams: its id and name, which may come after its first chunk. */
class ChatCall {
  id = "";
  name = "";
  started = false;
  /** Arguments that came before the id and name. */
  pending = "";
}

/** The chunks of one stream read into the listener and an end. */
export class ChatReader {
  readonly listener: StreamListener;
  readonly end = new StreamEnd(END_TURN);
  private readonly calls = new Map<number, ChatCall>();
  private order: number[] = [];
  private finish = "";
  delivered = false;
  done = false;

  constructor(listener: StreamListener) {
    this.listener = listener;
  }

  take(ev: SseEvent): void {
    const data = ev.data.trim();
    if (data.length === 0) return;
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    const d = recordOf(JSON.parse(data));
    if (d === null) return;
    const err = recordOf(d["error"]);
    if (err !== null) {
      this.end.stopReason = FAILED;
      this.end.error = (str(err["type"]).length > 0 ? str(err["type"]) + ": " : "") + (str(err["message"]).length > 0 ? str(err["message"]) : "the stream failed");
      return;
    }
    const usage = recordOf(d["usage"]);
    if (usage !== null) this.usage(usage);
    for (const c of listOf(d["choices"])) {
      const choice = recordOf(c);
      if (choice === null) continue;
      const delta = recordOf(choice["delta"]);
      if (delta !== null) this.delta(delta);
      const reason = str(choice["finish_reason"]);
      if (reason.length > 0) this.finish = reason;
    }
  }

  private delta(delta: Record<string, unknown>): void {
    const thought = str(delta["reasoning_content"]).length > 0 ? str(delta["reasoning_content"]) : str(delta["reasoning"]);
    if (thought.length > 0) {
      this.delivered = true;
      const fn = this.listener.onThinking;
      if (fn !== null) fn(thought);
    }
    const text = str(delta["content"]);
    if (text.length > 0) {
      this.delivered = true;
      const fn = this.listener.onText;
      if (fn !== null) fn(text);
    }
    for (const v of listOf(delta["tool_calls"])) {
      const t = recordOf(v);
      if (t === null) continue;
      const index = num(t["index"], this.order.length > 0 ? this.order[this.order.length - 1] : 0);
      let call = this.calls.get(index);
      if (call === undefined) {
        call = new ChatCall();
        this.calls.set(index, call);
        this.order.push(index);
      }
      const fnPart = recordOf(t["function"]);
      if (str(t["id"]).length > 0 && call.id.length === 0) call.id = str(t["id"]);
      if (fnPart !== null && str(fnPart["name"]).length > 0 && call.name.length === 0) call.name = str(fnPart["name"]);
      const args = fnPart !== null ? str(fnPart["arguments"]) : "";
      this.delivered = true;
      if (!call.started && call.name.length > 0) {
        if (call.id.length === 0) call.id = "call_" + String(index + 1);
        call.started = true;
        const start = this.listener.onToolCallStart;
        if (start !== null) start(call.id, call.name);
        if (call.pending.length > 0) {
          const fn = this.listener.onToolCallDelta;
          if (fn !== null) fn(call.id, call.pending);
          call.pending = "";
        }
      }
      if (args.length === 0) continue;
      if (!call.started) call.pending += args;
      else {
        const fn = this.listener.onToolCallDelta;
        if (fn !== null) fn(call.id, args);
      }
    }
  }

  private usage(u: Record<string, unknown>): void {
    const prompt = num(u["prompt_tokens"], -1);
    const details = recordOf(u["prompt_tokens_details"]);
    let cached = details !== null ? num(details["cached_tokens"], -1) : -1;
    if (cached < 0) cached = num(u["prompt_cache_hit_tokens"], 0);
    if (prompt >= 0) {
      this.end.usage.cacheRead = cached;
      this.end.usage.input = Math.max(0, prompt - cached);
    }
    const output = num(u["completion_tokens"], -1);
    if (output >= 0) this.end.usage.output = output;
    // A provider that bills the request says what it cost (OpenCode Zen's `cost`).
    const cost = num(u["cost"], -1);
    if (cost >= 0) this.end.usage.reportedCost = cost;
  }

  /** The stream is over: the calls ended, the stop reason from the finish reason. */
  close(): void {
    for (const index of this.order) {
      const call = this.calls.get(index);
      if (call === undefined || !call.started) continue;
      const fn = this.listener.onToolCallEnd;
      if (fn !== null) fn(call.id);
    }
    if (this.end.stopReason === FAILED) return;
    const anyCall = this.order.some((i) => this.calls.get(i)?.started === true);
    if (this.finish === "length") this.end.stopReason = MAX_TOKENS;
    else if (this.finish === "content_filter") {
      this.end.stopReason = FAILED;
      this.end.error = "the provider's content filter stopped the reply";
    } else if (this.finish === "tool_calls" || anyCall) this.end.stopReason = TOOL_USE;
    else this.end.stopReason = END_TURN;
  }
}

const wait = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

/** The error an API's body says (`{"error":{"message"}}`), else the status. */
const errorOf = (status: number, body: string): string => {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const e = recordOf(recordOf(parsed)?.["error"]);
  if (e !== null && str(e["message"]).length > 0) return (str(e["type"]).length > 0 ? str(e["type"]) + ": " : "") + str(e["message"]);
  return "HTTP " + String(status) + (body.trim().length > 0 ? ": " + body.trim().slice(0, 200) : "");
};

const failed = (why: string): StreamEnd => {
  const end = new StreamEnd(FAILED);
  end.error = why;
  return end;
};

export class OpenAiClient {
  readonly registry: ModelRegistry;
  readonly auth: Auth;
  httpKind: string;

  constructor(registry: ModelRegistry, auth: Auth, httpKind: string) {
    this.registry = registry;
    this.auth = auth;
    this.httpKind = httpKind;
  }

  async stream(req: ModelRequest, listener: StreamListener, abort: Abort): Promise<StreamEnd> {
    const model = this.registry.model(req.model);
    const provider: Provider | null = model !== null ? this.registry.provider(model.provider) : null;
    if (model === null || provider === null) return failed("no model " + req.model);
    const key = this.auth.keyFor(provider);
    if (key.length === 0) return failed("no key for " + provider.name + ": set " + provider.keyEnv + " or run widecode --harness-auth " + provider.id);
    const base = (model.baseUrl.length > 0 ? model.baseUrl : provider.baseUrl).replace(/\/+$/, "");
    const body = chatRequestBody(req, model);
    for (let attempt = 1; ; attempt++) {
      if (abort.aborted) return new StreamEnd(CANCELLED);
      const reader = new ChatReader(listener);
      const http = new HttpStream(this.httpKind);
      const stopper = new Stopper();
      stopper.stopNow = () => http.abort();
      abort.watch(stopper);
      const splitter = new SseSplitter();
      let status = 0;
      let errorBody = "";
      http.onStatus = (s: number) => {
        status = s;
      };
      http.onChunk = (text: string) => {
        if (status !== 200) {
          if (errorBody.length < 65536) errorBody += text;
          return;
        }
        for (const ev of splitter.push(text)) reader.take(ev);
      };
      const r = new HttpRequest(base + "/chat/completions");
      r.headers = [
        ["content-type", "application/json"],
        ["accept", "text/event-stream"],
        ["authorization", "Bearer " + key],
      ];
      r.body = body;
      const end = await http.start(r);
      abort.unwatch(stopper);
      if (status === 200) for (const ev of splitter.flush()) reader.take(ev);
      if (abort.aborted) return new StreamEnd(CANCELLED);
      if (status === 200 && end.error.length === 0) {
        reader.close();
        return reader.end;
      }
      const retryable = status === 429 || (status >= 500 && status < 600) || (status === 0 && !reader.delivered);
      if (retryable && attempt < RETRIES && !reader.delivered) {
        await wait(1000 * attempt * attempt);
        continue;
      }
      if (status === 200) {
        reader.close();
        reader.end.stopReason = FAILED;
        reader.end.error = end.error;
        return reader.end;
      }
      const why = status > 0 ? errorOf(status, errorBody) : end.error;
      return failed(why.includes("Model access is disabled") ? why + " (the model is not enabled for this key: widecode --harness-models marks the ones it has)" : why);
    }
  }
}
