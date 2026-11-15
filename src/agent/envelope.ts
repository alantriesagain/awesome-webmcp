// Decodes one stream-json line from `claude -p --output-format stream-json --include-partial-messages`
// into a typed event. Shapes were captured from Claude Code 2.1.282 (test/fixtures/stream.ndjson).
// Every cast below is a *partial view*: scriptc validates only the declared fields and ignores
// extra keys, so new fields the CLI adds never break decoding.

export abstract class AgentEvent {
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}

/** `system/init`: the session is up. */
export class InitEvent extends AgentEvent {
  readonly sessionId: string;
  readonly model: string;
  readonly tools: string[];
  readonly version: string;
  constructor(sessionId: string, model: string, tools: string[], version: string) {
    super("init");
    this.sessionId = sessionId;
    this.model = model;
    this.tools = tools;
    this.version = version;
  }
}

/** `system/<other>` such as `status` ("requesting"), `api_retry`, `compact_boundary`. */
export class SystemEvent extends AgentEvent {
  readonly subtype: string;
  readonly status: string;
  constructor(subtype: string, status: string) {
    super("system");
    this.subtype = subtype;
    this.status = status;
  }
}

/** A new content block in the streaming assistant message (text, tool_use, thinking). */
export class BlockStartEvent extends AgentEvent {
  readonly index: number;
  readonly blockType: string;
  constructor(index: number, blockType: string) {
    super("block_start");
    this.index = index;
    this.blockType = blockType;
  }
}

/** A text delta for block `index`. */
export class TextDeltaEvent extends AgentEvent {
  readonly index: number;
  readonly text: string;
  constructor(index: number, text: string) {
    super("delta");
    this.index = index;
    this.text = text;
  }
}

/** A streamed block finished. */
export class BlockStopEvent extends AgentEvent {
  readonly index: number;
  constructor(index: number) {
    super("block_stop");
    this.index = index;
  }
}

/** The complete assistant message for the turn (only its text blocks are kept). */
export class AssistantEvent extends AgentEvent {
  readonly text: string;
  readonly blockTypes: string[];
  readonly messageId: string;
  constructor(text: string, blockTypes: string[], messageId: string) {
    super("assistant");
    this.text = text;
    this.blockTypes = blockTypes;
    this.messageId = messageId;
  }
}

/** The final `result` line of a turn. */
export class ResultEvent extends AgentEvent {
  readonly subtype: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly result: string;
  readonly sessionId: string;
  readonly errors: string[];
  constructor(subtype: string, isError: boolean, durationMs: number, numTurns: number, costUsd: number, result: string, sessionId: string, errors: string[]) {
    super("result");
    this.subtype = subtype;
    this.isError = isError;
    this.durationMs = durationMs;
    this.numTurns = numTurns;
    this.costUsd = costUsd;
    this.result = result;
    this.sessionId = sessionId;
    this.errors = errors;
  }
}

/** Any envelope or stream event we do not model (rate_limit_event, user echoes, message_delta, …). */
export class UnknownEvent extends AgentEvent {
  readonly type: string;
  readonly subtype: string;
  constructor(type: string, subtype: string) {
    super("unknown");
    this.type = type;
    this.subtype = subtype;
  }
}

/** A line that was not JSON or not an object; kept verbatim for the log. */
export class MalformedEvent extends AgentEvent {
  readonly line: string;
  constructor(line: string) {
    super("malformed");
    this.line = line;
  }
}

/** Text the subprocess wrote to stderr. */
export class StderrEvent extends AgentEvent {
  readonly text: string;
  constructor(text: string) {
    super("stderr");
    this.text = text;
  }
}

/** The subprocess exited. */
export class ExitEvent extends AgentEvent {
  readonly code: number;
  constructor(code: number) {
    super("exit");
    this.code = code;
  }
}

/** The subprocess could not be spawned or errored. */
export class ErrorEvent extends AgentEvent {
  readonly message: string;
  constructor(message: string) {
    super("error");
    this.message = message;
  }
}

function decodeStreamEvent(ev: unknown): AgentEvent {
  const head = ev as { type: string };
  switch (head.type) {
    case "content_block_start": {
      const b = ev as { index: number; content_block: { type: string } };
      return new BlockStartEvent(b.index, b.content_block.type);
    }
    case "content_block_delta": {
      const d = ev as { index: number; delta: { type: string; text?: string } };
      if (d.delta.type === "text_delta") return new TextDeltaEvent(d.index, d.delta.text ?? "");
      return new UnknownEvent("stream_event", d.delta.type);
    }
    case "content_block_stop": {
      const s = ev as { index: number };
      return new BlockStopEvent(s.index);
    }
    default:
      return new UnknownEvent("stream_event", head.type);
  }
}

export function decodeEnvelope(line: string): AgentEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return new MalformedEvent(line);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return new MalformedEvent(line);
  const head = raw as { type?: string };
  const type = head.type ?? "";
  switch (type) {
    case "system": {
      // `status` is null when the CLI reports only a mode change; natively a cast to `string` throws on null.
      const s = raw as { subtype?: string; session_id?: string; model?: string; tools?: string[]; claude_code_version?: string; status?: unknown };
      const subtype = s.subtype ?? "";
      if (subtype === "init") return new InitEvent(s.session_id ?? "", s.model ?? "", s.tools ?? [], s.claude_code_version ?? "");
      return new SystemEvent(subtype, typeof s.status === "string" ? s.status : "");
    }
    case "stream_event": {
      const ev = (raw as { event: unknown }).event;
      if (ev === null || typeof ev !== "object") return new MalformedEvent(line);
      return decodeStreamEvent(ev);
    }
    case "assistant": {
      const a = raw as { message: { id?: string; content: { type: string; text?: string }[] } };
      const texts: string[] = [];
      const types: string[] = [];
      for (const c of a.message.content) {
        types.push(c.type);
        if (c.type === "text") texts.push(c.text ?? "");
      }
      return new AssistantEvent(texts.join(""), types, a.message.id ?? "");
    }
    case "result": {
      const r = raw as {
        subtype?: string;
        is_error?: boolean;
        duration_ms?: number;
        num_turns?: number;
        total_cost_usd?: number;
        result?: string;
        session_id?: string;
        errors?: string[];
      };
      return new ResultEvent(r.subtype ?? "", r.is_error ?? false, r.duration_ms ?? 0, r.num_turns ?? 0, r.total_cost_usd ?? 0, r.result ?? "", r.session_id ?? "", r.errors ?? []);
    }
    default: {
      const u = raw as { subtype?: string };
      return new UnknownEvent(type, u.subtype ?? "");
    }
  }
}
