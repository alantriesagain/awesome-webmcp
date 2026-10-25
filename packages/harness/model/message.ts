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
