// The conversation as the model sees it, in one neutral shape whichever provider speaks it: messages
// of parts (text, thinking with the provider's signature, a tool call with its input as JSON text,
// a tool result with the ACP facts of its call kept for replay, an image), and what a request used.
// One flat class per thing, told apart by `kind`: a native build keeps a flat class through
// `unknown`, a hierarchy would not.

export const TEXT = "text";
export const THINKING = "thinking";
export const TOOL_CALL = "tool_call";
export const TOOL_RESULT = "tool_result";
export const IMAGE = "image";

/** How a stream ended. */
export const END_TURN = "end_turn";
export const TOOL_USE = "tool_use";
export const MAX_TOKENS = "max_tokens";
export const CANCELLED = "cancelled";
export const FAILED = "error";

export class Part {
  readonly kind: string;
  /** Text, thinking's words, a tool result's text. */
  text = "";
  /** Thinking's provider signature, sent back unchanged. */
  signature = "";
  /** A tool call's id, and its result's. */
  callId = "";
  /** A tool call's tool. */
  name = "";
  /** A tool call's input, as JSON text. */
  inputJson = "";
  /** A tool result that is an error. */
  isError = false;
  /** An image's type and base64 data. */
  mediaType = "";
  data = "";
  /** A tool result's call as ACP saw it (kind, title, locations, content, rawOutput), for replay. */
  acpJson = "";

  constructor(kind: string) {
    this.kind = kind;
  }
}

export const textPart = (text: string): Part => {
  const p = new Part(TEXT);
  p.text = text;
  return p;
};

export class Message {
  /** "user" or "assistant". */
  readonly role: string;
  readonly id: string;
  readonly parts: Part[] = [];

  constructor(role: string, id: string) {
    this.role = role;
    this.id = id;
  }

  /** The text parts, joined. */
  text(): string {
    const out: string[] = [];
    for (const p of this.parts) if (p.kind === TEXT) out.push(p.text);
    return out.join("");
  }
}

/** What a request used, in tokens. */
export class Usage {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;

  add(other: Usage): void {
    this.input += other.input;
    this.output += other.output;
    this.cacheRead += other.cacheRead;
    this.cacheWrite += other.cacheWrite;
  }

  /** What the context held at this request: the input with what the cache served and wrote, plus the output. */
  context(): number {
    return this.input + this.cacheRead + this.cacheWrite + this.output;
  }
}

/** A part as JSON text, its empty fields left out. */
export const partJson = (p: Part): string => {
  const fields: string[] = ['"kind":' + JSON.stringify(p.kind)];
  if (p.text.length > 0) fields.push('"text":' + JSON.stringify(p.text));
  if (p.signature.length > 0) fields.push('"signature":' + JSON.stringify(p.signature));
  if (p.callId.length > 0) fields.push('"callId":' + JSON.stringify(p.callId));
  if (p.name.length > 0) fields.push('"name":' + JSON.stringify(p.name));
  if (p.inputJson.length > 0) fields.push('"inputJson":' + JSON.stringify(p.inputJson));
  if (p.isError) fields.push('"isError":true');
  if (p.mediaType.length > 0) fields.push('"mediaType":' + JSON.stringify(p.mediaType));
  if (p.data.length > 0) fields.push('"data":' + JSON.stringify(p.data));
  if (p.acpJson.length > 0) fields.push('"acpJson":' + JSON.stringify(p.acpJson));
  return "{" + fields.join(",") + "}";
};

const field = (r: Record<string, unknown>, name: string): string => (typeof r[name] === "string" ? (r[name] as string) : "");

/** A part from its parsed JSON, null when it is not one. */
export const partOf = (v: unknown): Part | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const kind = field(r, "kind");
  if (kind.length === 0) return null;
  const p = new Part(kind);
  p.text = field(r, "text");
  p.signature = field(r, "signature");
  p.callId = field(r, "callId");
  p.name = field(r, "name");
  p.inputJson = field(r, "inputJson");
  p.isError = r["isError"] === true;
  p.mediaType = field(r, "mediaType");
  p.data = field(r, "data");
  p.acpJson = field(r, "acpJson");
  return p;
};
