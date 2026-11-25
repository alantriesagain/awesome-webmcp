// The Anthropic Messages API, streamed, as Anthropic and DeepSeek (through its Anthropic-format
// endpoint) serve it: the request as JSON text with the system blocks, the messages, the tools,
// thinking by the model's kind and the effort; the server-sent events read into the listener
// (text and thinking deltas, a tool call's id, name and input JSON as it streams, the usage, the
// stop reason). Anthropic's own extras (cache breakpoints on the last tool, the last system block
// and the last user block; eager input streaming; the effort) go to providers that take them. A
// request refused with 429, 529 or a server error before anything streamed is tried again, three
// times, with a pause between.
import { num, recordOf, str } from "@lightstart/lib/json.ts";
import { Auth } from "../auth.ts";
import { Abort, Stopper } from "../loop/abort.ts";
import { HttpRequest, HttpStream } from "../http/stream.ts";
import { ModelRequest, StreamEnd, StreamListener } from "./client.ts";
import { CANCELLED, END_TURN, FAILED, IMAGE, MAX_TOKENS, Message, Part, TEXT, THINKING, TOOL_CALL, TOOL_RESULT, TOOL_USE } from "./message.ts";
import { ADAPTIVE, BUDGET, ModelInfo, ModelRegistry, Provider, budgetFor } from "./registry.ts";
import { SseEvent, SseSplitter } from "./sse.ts";

const VERSION = "2023-06-01";
const RETRIES = 3;
const CACHE = '"cache_control":{"type":"ephemeral"}';

/** `text` as a JSON text block, with a cache breakpoint when `cached`. */
const textBlock = (text: string, cached: boolean): string => '{"type":"text","text":' + JSON.stringify(text) + (cached ? "," + CACHE : "") + "}";

/** A part as a content block ("" for one the API does not take back). */
const partBlock = (p: Part, cached: boolean): string => {
  if (p.kind === TEXT) return p.text.length > 0 ? textBlock(p.text, cached) : "";
  if (p.kind === IMAGE) return '{"type":"image","source":{"type":"base64","media_type":' + JSON.stringify(p.mediaType) + ',"data":' + JSON.stringify(p.data) + "}" + (cached ? "," + CACHE : "") + "}";
  if (p.kind === TOOL_RESULT) {
    // A result with an image: its text and the image as the content's blocks.
    const content = p.data.length > 0 ? '[{"type":"text","text":' + JSON.stringify(p.text) + '},{"type":"image","source":{"type":"base64","media_type":' + JSON.stringify(p.mediaType) + ',"data":' + JSON.stringify(p.data) + "}}]" : JSON.stringify(p.text);
    return '{"type":"tool_result","tool_use_id":' + JSON.stringify(p.callId) + ',"content":' + content + (p.isError ? ',"is_error":true' : "") + (cached ? "," + CACHE : "") + "}";
  }
  if (p.kind === TOOL_CALL) return '{"type":"tool_use","id":' + JSON.stringify(p.callId) + ',"name":' + JSON.stringify(p.name) + ',"input":' + (p.inputJson.length > 0 ? p.inputJson : "{}") + "}";
  if (p.kind === THINKING) return p.signature.length > 0 ? '{"type":"thinking","thinking":' + JSON.stringify(p.text) + ',"signature":' + JSON.stringify(p.signature) + "}" : "";
  return "";
};

/** The messages as the API takes them; the last user message's last block cached when `extras`. */
export const messagesJson = (messages: Message[], extras: boolean): string => {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // The parts the API takes; the breakpoint goes on the last of them in the last user message.
    const kept = m.parts.filter((p) => partBlock(p, false).length > 0);
    if (kept.length === 0) continue;
    const blocks = kept.map((p, j) => partBlock(p, extras && i === lastUser && j === kept.length - 1));
    out.push('{"role":' + JSON.stringify(m.role) + ',"content":[' + blocks.join(",") + "]}");
  }
  return "[" + out.join(",") + "]";
};

/** The request's body for `model` at `provider`. */
export const requestBody = (req: ModelRequest, model: ModelInfo, provider: Provider): string => {
  const extras = model.extras === "on" || (model.extras !== "off" && provider.anthropicExtras);
  const parts: string[] = ['"model":' + JSON.stringify(model.id), '"max_tokens":' + String(model.maxOutput), '"stream":true'];
  const cachedAt = (req.systemCached > 0 ? req.systemCached : req.system.length) - 1;
  if (req.system.length > 0) parts.push('"system":[' + req.system.map((s, i) => textBlock(s, extras && i === cachedAt)).join(",") + "]");
  if (req.toolsJson.length > 0) parts.push('"tools":' + req.toolsJson);
  parts.push('"messages":' + messagesJson(req.messages, extras));
  const effort = model.efforts.includes(req.effort) ? req.effort : "";
  if (model.thinking === ADAPTIVE) {
    parts.push('"thinking":{"type":"adaptive","display":"summarized"}');
    if (extras && effort.length > 0) parts.push('"output_config":{"effort":' + JSON.stringify(effort) + "}");
  } else if (model.thinking === BUDGET) {
    const budget = budgetFor(effort.length > 0 ? effort : "medium");
    if (budget > 0) parts.push('"thinking":{"type":"enabled","budget_tokens":' + String(budget) + "}");
  }
  return "{" + parts.join(",") + "}";
};

/** A content block of the stream in progress. */
class Block {
  readonly type: string;
  readonly id: string;
  readonly name: string;

  constructor(type: string, id: string, name: string) {
    this.type = type;
    this.id = id;
    this.name = name;
  }
}

/** The events of one stream read into the listener and an end. */
export class AnthropicReader {
  readonly listener: StreamListener;
  readonly end = new StreamEnd(END_TURN);
  private readonly blocks = new Map<number, Block>();
  /** Whether anything reached the listener (a retry is possible before). */
  delivered = false;
  stopped = false;

  constructor(listener: StreamListener) {
    this.listener = listener;
  }

  take(ev: SseEvent): void {
    const d = recordOf(JSON.parse(ev.data.length > 0 ? ev.data : "null"));
    if (d === null) return;
    const type = str(d["type"]);
    if (type === "message_start") {
      const usage = recordOf(recordOf(d["message"])?.["usage"]);
      if (usage !== null) this.usage(usage);
    } else if (type === "content_block_start") {
      const b = recordOf(d["content_block"]);
      const index = num(d["index"], -1);
      if (b === null || index < 0) return;
      const block = new Block(str(b["type"]), str(b["id"]), str(b["name"]));
      this.blocks.set(index, block);
      if (block.type === "tool_use") {
        this.delivered = true;
        const fn = this.listener.onToolCallStart;
        if (fn !== null) fn(block.id, block.name);
      }
    } else if (type === "content_block_delta") {
      const delta = recordOf(d["delta"]);
      const block = this.blocks.get(num(d["index"], -1));
      if (delta === null) return;
      const kind = str(delta["type"]);
      this.delivered = true;
      if (kind === "text_delta") {
        const fn = this.listener.onText;
        if (fn !== null) fn(str(delta["text"]));
      } else if (kind === "thinking_delta") {
        const fn = this.listener.onThinking;
        if (fn !== null) fn(str(delta["thinking"]));
      } else if (kind === "signature_delta") {
        const fn = this.listener.onSignature;
        if (fn !== null) fn(str(delta["signature"]));
      } else if (kind === "input_json_delta" && block !== undefined) {
        const fn = this.listener.onToolCallDelta;
        if (fn !== null) fn(block.id, str(delta["partial_json"]));
      }
    } else if (type === "content_block_stop") {
      const block = this.blocks.get(num(d["index"], -1));
      if (block !== undefined && block.type === "tool_use") {
        const fn = this.listener.onToolCallEnd;
        if (fn !== null) fn(block.id);
      }
    } else if (type === "message_delta") {
      const delta = recordOf(d["delta"]);
      const reason = delta !== null ? str(delta["stop_reason"]) : "";
      if (reason === "tool_use") this.end.stopReason = TOOL_USE;
      else if (reason === "max_tokens") this.end.stopReason = MAX_TOKENS;
      else if (reason === "refusal") {
        this.end.stopReason = FAILED;
        const details = recordOf(delta !== null ? delta["stop_details"] : null);
        this.end.error = "the model refused" + (details !== null && str(details["category"]).length > 0 ? " (" + str(details["category"]) + ")" : "");
      } else if (reason.length > 0) this.end.stopReason = END_TURN;
      const usage = recordOf(d["usage"]);
      if (usage !== null) this.usage(usage);
    } else if (type === "message_stop") this.stopped = true;
    else if (type === "error") {
      const e = recordOf(d["error"]);
      this.end.stopReason = FAILED;
      this.end.error = e !== null ? str(e["type"]) + ": " + str(e["message"]) : "the stream failed";
    }
  }

  private usage(u: Record<string, unknown>): void {
    const input = num(u["input_tokens"], -1);
    if (input >= 0) this.end.usage.input = input;
    const output = num(u["output_tokens"], -1);
    if (output >= 0) this.end.usage.output = output;
    const read = num(u["cache_read_input_tokens"], -1);
    if (read >= 0) this.end.usage.cacheRead = read;
    const write = num(u["cache_creation_input_tokens"], -1);
    if (write >= 0) this.end.usage.cacheWrite = write;
    // A provider that bills the request says what it cost (OpenCode Zen's `cost`).
    const cost = num(u["cost"], -1);
    if (cost >= 0) this.end.usage.reportedCost = cost;
  }
}

const wait = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

/** The error an API's body says (`{"error":{"type","message"}}`), else the status. */
const errorOf = (status: number, body: string): string => {
  const e = recordOf(recordOf(JSON.parse(body.trim().startsWith("{") ? body : "null"))?.["error"]);
  return e !== null ? str(e["type"]) + ": " + str(e["message"]) : "HTTP " + String(status) + (body.trim().length > 0 ? ": " + body.trim().slice(0, 200) : "");
};

export class AnthropicClient {
  readonly registry: ModelRegistry;
  readonly auth: Auth;
  /** "node" or "curl". */
  httpKind: string;

  constructor(registry: ModelRegistry, auth: Auth, httpKind: string) {
    this.registry = registry;
    this.auth = auth;
    this.httpKind = httpKind;
  }

  async stream(req: ModelRequest, listener: StreamListener, abort: Abort): Promise<StreamEnd> {
    const model = this.registry.model(req.model);
    const provider = model !== null ? this.registry.provider(model.provider) : null;
    if (model === null || provider === null) return failed("no model " + req.model);
    const base = model.baseUrl.length > 0 ? model.baseUrl : provider.baseUrl;
    const key = this.auth.keyFor(provider);
    if (key.length === 0) return failed("no key for " + provider.name + ": set " + provider.keyEnv + " or run lightcode --harness-auth " + provider.id);
    const body = requestBody(req, model, provider);
    for (let attempt = 1; ; attempt++) {
      if (abort.aborted) return new StreamEnd(CANCELLED);
      const reader = new AnthropicReader(listener);
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
      const r = new HttpRequest(base.replace(/\/+$/, "") + "/v1/messages");
      r.headers = [
        ["content-type", "application/json"],
        ["accept", "text/event-stream"],
        ["x-api-key", key],
        ["anthropic-version", VERSION],
      ];
      r.body = body;
      const end = await http.start(r);
      abort.unwatch(stopper);
      if (status === 200) for (const ev of splitter.flush()) reader.take(ev);
      if (abort.aborted) return new StreamEnd(CANCELLED);
      if (status === 200 && end.error.length === 0) return reader.end;
      const retryable = status === 429 || status === 529 || (status >= 500 && status < 600) || (status === 0 && !reader.delivered);
      if (retryable && attempt < RETRIES && !reader.delivered) {
        await wait(1000 * attempt * attempt);
        continue;
      }
      if (status === 200) {
        reader.end.stopReason = FAILED;
        reader.end.error = end.error;
        return reader.end;
      }
      const why = status > 0 ? errorOf(status, errorBody) : end.error;
      return failed(why.includes("Model access is disabled") ? why + " (the model is not enabled for this key: lightcode --harness-models marks the ones it has)" : why);
    }
  }
}

const failed = (why: string): StreamEnd => {
  const end = new StreamEnd(FAILED);
  end.error = why;
  return end;
};
