// A model behind one call: `stream(request, listener, abort)` answers how the stream ended once
// its text, thinking and tool calls have reached the listener. One client class dispatching by
// the model's provider (the fake for tests, else the Anthropic Messages API, which Anthropic and
// DeepSeek serve), since a method that is overridden cannot be async natively.
import { Abort } from "../loop/abort.ts";
import { Auth } from "../auth.ts";
import { Message, Usage } from "./message.ts";
import { AnthropicClient } from "./anthropic.ts";
import { FakeClient } from "./fake.ts";
import { ModelRegistry } from "./registry.ts";

export class ModelRequest {
  readonly model: string;
  /** The system prompt's blocks, the stable ones first. */
  readonly system: string[];
  readonly messages: Message[];
  effort = "";
  /** The tools as the API's JSON list ("" for none). */
  toolsJson = "";

  constructor(model: string, system: string[], messages: Message[]) {
    this.model = model;
    this.system = system;
    this.messages = messages;
  }
}

/** What a stream reports as it goes: deltas of text, thinking and its signature, and a tool call's id, name and input JSON. */
export class StreamListener {
  onText: ((delta: string) => void) | null = null;
  onThinking: ((delta: string) => void) | null = null;
  onSignature: ((delta: string) => void) | null = null;
  onToolCallStart: ((id: string, name: string) => void) | null = null;
  onToolCallDelta: ((id: string, json: string) => void) | null = null;
  onToolCallEnd: ((id: string) => void) | null = null;
}

/** How a stream ended: the stop reason, what it used, and the error when it failed. */
export class StreamEnd {
  stopReason: string;
  usage = new Usage();
  error = "";

  constructor(stopReason: string) {
    this.stopReason = stopReason;
  }
}

export class ModelClient {
  readonly registry: ModelRegistry;
  readonly anthropic: AnthropicClient;
  readonly fake: FakeClient | null;

  constructor(registry: ModelRegistry, auth: Auth, httpKind: string, fake: FakeClient | null) {
    this.registry = registry;
    this.anthropic = new AnthropicClient(registry, auth, httpKind);
    this.fake = fake;
  }

  stream(req: ModelRequest, listener: StreamListener, abort: Abort): Promise<StreamEnd> {
    const fake = this.fake;
    const m = this.registry.model(req.model);
    if (fake !== null && (m === null || m.provider === "fake")) return fake.play(req, listener, abort);
    return this.anthropic.stream(req, listener, abort);
  }
}
