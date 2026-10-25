// The daemon's agent: the ACP methods over one or more sessions. A session holds the loop's state
// (its messages, the system prompt's blocks, the model, effort and mode, the folder), the client's
// `_meta.widecode` (the project's prompt and trust), the MCP servers it was given, its config
// options (the models by provider, the current model's efforts, the modes), the usage and cost so
// far, and the turn in progress: the prompt ids waiting for its end (a prompt sent mid-turn is a
// steering message answered with the turn), and the abort a cancel fires. A tool call goes out as
// it starts and as it ends, titled with the tool's name.
import { listOf, recordOf, str } from "@light/lib/json.ts";
import { HarnessConfig } from "../config.ts";
import { Abort } from "../loop/abort.ts";
import { LoopListener } from "../loop/listener.ts";
import { AgentLoop, LoopSession, TurnEnd } from "../loop/loop.ts";
import { ModelClient } from "../model/client.ts";
import { CANCELLED, FAILED, Usage } from "../model/message.ts";
import { ModelInfo, ModelRegistry, costUsd } from "../model/registry.ts";
import { systemBlocks } from "../prompt/system.ts";
import { ToolOutcome, ToolSet } from "../tools/tool.ts";
import { Choice, ConfigOptions } from "./options.ts";
import { AcpServer, Incoming } from "./server.ts";
import { DiffBlock, chunkUpdate, commandsUpdate, modeUpdate, toolCallEnd, toolCallUpdate, usageUpdate } from "./updates.ts";

/** The context window the usage is reported against while no model says otherwise. */
const DEFAULT_WINDOW = 200000;
/** The commands a session answers in the composer. */
const COMMANDS = [
  ["compact", "summarize the conversation so far, freeing context"],
  ["title", "give the session a title"],
];

export class HarnessSession {
  readonly id: string;
  cwd = "";
  /** The MCP servers the client gave, as JSON text. */
  mcpServersText = "[]";
  /** The project's prompt text and trust, from `_meta.widecode`. */
  harnessText = "";
  trusted = false;
  readonly options: ConfigOptions;
  readonly loop = new LoopSession();
  running = false;
  /** The prompts of the turn in progress, their ids as JSON text, answered when it ends. */
  promptIds: string[] = [];
  abort = new Abort();
  /** What the context held after the last request, the window it is reported against, and the cost so far (below 0: unknown). */
  used = 0;
  window = DEFAULT_WINDOW;
  costUsd = -1;

  constructor(id: string, options: ConfigOptions) {
    this.id = id;
    this.options = options;
  }
}

/** The capabilities the daemon answers `initialize` with. */
const CAPABILITIES = '{"loadSession":true,"mcpCapabilities":{"http":true},"promptCapabilities":{"image":true},"sessionCapabilities":{"list":{},"fork":{}}}';

const newId = (): string => "h-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");

/** The text of a prompt's blocks: the text blocks joined (images come later). */
const promptText = (prompt: unknown): string => {
  const out: string[] = [];
  for (const v of listOf(prompt)) {
    const b = recordOf(v);
    if (b !== null && str(b["type"]) === "text") out.push(str(b["text"]));
  }
  return out.join("\n");
};

export class AcpAgent {
  readonly server: AcpServer;
  readonly loop: AgentLoop;
  readonly registry: ModelRegistry;
  readonly config: HarnessConfig;
  readonly build: string;
  readonly platform: string;
  private readonly sessions = new Map<string, HarnessSession>();

  constructor(server: AcpServer, client: ModelClient, tools: ToolSet, registry: ModelRegistry, config: HarnessConfig, build: string, platform: string) {
    this.server = server;
    this.loop = new AgentLoop(client, tools);
    this.registry = registry;
    this.config = config;
    this.build = build;
    this.platform = platform;
  }

  /** The options a new session starts with: every model by provider, the chosen model's efforts, the config's choices. */
  private defaults(): ConfigOptions {
    const o = new ConfigOptions();
    for (const m of this.registry.models) {
      const p = this.registry.provider(m.provider);
      o.models.push(new Choice(m.modelValue(), m.name, p !== null ? p.name : m.provider));
    }
    const wanted = this.registry.model(this.config.model);
    const model = wanted !== null ? wanted : this.registry.models.length > 0 ? this.registry.models[0] : null;
    o.model = model !== null ? model.modelValue() : "";
    this.effortsOf(o, model);
    return o;
  }

  /** The efforts of `model` into `o`, keeping the current one when the model takes it, else the config's, else the first. */
  private effortsOf(o: ConfigOptions, model: ModelInfo | null): void {
    const efforts = model !== null ? model.efforts : [];
    o.efforts = efforts.map((e) => new Choice(e, e, ""));
    if (efforts.includes(o.effort)) return;
    o.effort = efforts.includes(this.config.effort) ? this.config.effort : efforts.length > 0 ? efforts[efforts.length > 2 ? 2 : 0] : "";
  }

  /** A request or a notification from the client. */
  receive(m: Incoming): void {
    const p = recordOf(m.params);
    switch (m.method) {
      case "initialize":
        this.server.answer(m.idText, '{"protocolVersion":1,"agentCapabilities":' + CAPABILITIES + ',"authMethods":[],"agentInfo":{"name":"widecode-harness","version":' + JSON.stringify(this.build) + "}}");
        return;
      case "session/new":
        this.announce(m.idText, this.make(p));
        return;
      case "session/load":
      case "session/resume":
        this.reopen(m.idText, p);
        return;
      case "session/fork":
        this.fork(m.idText, p);
        return;
      case "session/prompt":
        this.prompt(m.idText, p);
        return;
      case "session/cancel": {
        const s = this.sessionOf(p);
        if (s !== null && s.running) s.abort.fire();
        return;
      }
      case "session/set_config_option":
        this.setOption(m.idText, p);
        return;
      case "session/list":
        this.server.answer(m.idText, '{"sessions":[]}');
        return;
      default:
        if (m.idText.length > 0) this.server.refuse(m.idText, -32601, "widecode's harness does not offer " + m.method);
    }
  }

  private sessionOf(p: Record<string, unknown> | null): HarnessSession | null {
    const id = p !== null ? str(p["sessionId"]) : "";
    const s = this.sessions.get(id);
    return s === undefined ? null : s;
  }

  /** What the client says in `_meta.widecode`: the project's prompt and trust, kept on the session. */
  private takeMeta(s: HarnessSession, p: Record<string, unknown> | null): void {
    const meta = p !== null ? recordOf(recordOf(p["_meta"])?.["widecode"]) : null;
    if (meta === null) return;
    if (typeof meta["systemPrompt"] === "string") s.harnessText = str(meta["systemPrompt"]);
    if (typeof meta["trusted"] === "boolean") s.trusted = meta["trusted"] === true;
  }

  private make(p: Record<string, unknown> | null): HarnessSession {
    const s = new HarnessSession(newId(), this.defaults());
    s.cwd = p !== null ? str(p["cwd"]) : "";
    const servers = p !== null ? p["mcpServers"] : null;
    s.mcpServersText = Array.isArray(servers) ? JSON.stringify(servers) : "[]";
    this.takeMeta(s, p);
    this.apply(s);
    this.sessions.set(s.id, s);
    return s;
  }

  /** The session's options onto its loop: the model, effort, mode, window, folder. */
  private apply(s: HarnessSession): void {
    s.loop.model = s.options.model;
    s.loop.effort = s.options.effort;
    s.loop.mode = s.options.mode;
    s.loop.cwd = s.cwd;
    const m = this.registry.model(s.options.model);
    s.window = m !== null ? m.window : DEFAULT_WINDOW;
    const p = m !== null ? this.registry.provider(m.provider) : null;
    this.loop.extras = p === null || p.anthropicExtras;
  }

  /** A session's answer to new, load, resume and fork: its id and options; then what it offers. */
  private announce(idText: string, s: HarnessSession): void {
    s.loop.system = systemBlocks(s.cwd, this.platform, s.harnessText);
    this.server.answer(idText, '{"sessionId":' + JSON.stringify(s.id) + ',"configOptions":' + s.options.text() + "}");
    this.server.notify("session/update", commandsUpdate(s.id, COMMANDS));
    this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
  }

  /** A session this process holds is reopened in place; one it does not know is refused, and the client starts a new one. */
  private reopen(idText: string, p: Record<string, unknown> | null): void {
    const s = this.sessionOf(p);
    if (s === null) {
      this.server.refuse(idText, -32602, "no such session here" + (p !== null ? ": " + str(p["sessionId"]) : ""));
      return;
    }
    this.takeMeta(s, p);
    const servers = p !== null ? p["mcpServers"] : null;
    if (Array.isArray(servers)) s.mcpServersText = JSON.stringify(servers);
    this.announce(idText, s);
  }

  /** A copy of the session's conversation as a session of its own (a side question's). */
  private fork(idText: string, p: Record<string, unknown> | null): void {
    const from = this.sessionOf(p);
    if (from === null) {
      this.server.refuse(idText, -32602, "no such session here");
      return;
    }
    const s = this.make(p);
    s.cwd = from.cwd;
    s.harnessText = from.harnessText;
    s.trusted = from.trusted;
    s.loop.messages = from.loop.messages.slice();
    s.options.model = from.options.model;
    s.options.effort = from.options.effort;
    s.options.mode = from.options.mode;
    this.effortsOf(s.options, this.registry.model(s.options.model));
    this.apply(s);
    this.announce(idText, s);
  }

  private setOption(idText: string, p: Record<string, unknown> | null): void {
    const s = this.sessionOf(p);
    if (s === null || p === null) {
      this.server.refuse(idText, -32602, "no such session here");
      return;
    }
    const id = str(p["configId"]);
    const value = str(p["value"]);
    const why = s.options.set(id, value);
    if (why.length > 0) {
      this.server.refuse(idText, -32602, why);
      return;
    }
    if (id === "model") this.effortsOf(s.options, this.registry.model(value));
    this.apply(s);
    this.server.answer(idText, '{"configOptions":' + s.options.text() + "}");
    if (id === "mode") this.server.notify("session/update", modeUpdate(s.id, value));
  }

  private prompt(idText: string, p: Record<string, unknown> | null): void {
    const s = this.sessionOf(p);
    if (s === null || p === null) {
      this.server.refuse(idText, -32602, "no such session here");
      return;
    }
    this.takeMeta(s, p);
    const text = promptText(p["prompt"]);
    if (s.running) {
      // A steering message: into the turn after its current request, answered with it.
      s.loop.steering.push(text);
      s.promptIds.push(idText);
      return;
    }
    s.running = true;
    s.promptIds = [idText];
    s.abort = new Abort();
    s.loop.system = systemBlocks(s.cwd, this.platform, s.harnessText);
    this.apply(s);
    const tools = this.loop.tools.forMode(s.loop.mode);
    const listener = new LoopListener();
    listener.onText = (messageId: string, delta: string) => this.server.notify("session/update", chunkUpdate(s.id, "agent_message_chunk", messageId, delta));
    listener.onThinking = (messageId: string, delta: string) => this.server.notify("session/update", chunkUpdate(s.id, "agent_thought_chunk", messageId, delta));
    listener.onUsage = (usage: Usage) => {
      s.used = usage.context();
      const m = this.registry.model(s.loop.model);
      if (m !== null) {
        const cost = costUsd(m, usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
        if (cost >= 0) s.costUsd = (s.costUsd < 0 ? 0 : s.costUsd) + cost;
      }
      this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
    };
    listener.onToolStart = (callId: string, name: string, inputJson: string) => {
      const t = tools.find(name);
      const kind = t !== null ? t.kind : "other";
      const input = recordOf(JSON.parse(inputJson));
      const path = input !== null ? str(input["file_path"]) : "";
      this.server.notify("session/update", toolCallUpdate(s.id, callId, name, kind, "in_progress", inputJson, path.length > 0 ? [path] : []));
    };
    listener.onToolEnd = (callId: string, outcome: ToolOutcome) => {
      const diff = outcome.diffPath.length > 0 && !outcome.isError ? new DiffBlock(outcome.diffPath, outcome.created, outcome.oldText, outcome.newText) : null;
      this.server.notify("session/update", toolCallEnd(s.id, callId, outcome.isError, outcome.text, diff, outcome.rawOutputJson));
    };
    this.loop.run(s.loop, text, listener, s.abort).then(
      (end: TurnEnd) => this.turnEnded(s, end),
      (err: unknown) => {
        const end = new TurnEnd();
        end.stopReason = FAILED;
        end.error = err instanceof Error ? err.message : "the turn failed";
        this.turnEnded(s, end);
      },
    );
  }

  /** The turn is over: every prompt of it is answered with how it ended. */
  private turnEnded(s: HarnessSession, end: TurnEnd): void {
    s.running = false;
    const ids = s.promptIds;
    s.promptIds = [];
    s.loop.steering = [];
    const stop = end.stopReason === CANCELLED ? "cancelled" : end.stopReason === FAILED ? "end_turn" : end.stopReason;
    const result = '{"stopReason":' + JSON.stringify(stop) + ',"usage":{"inputTokens":' + String(end.usage.input + end.usage.cacheRead + end.usage.cacheWrite) + ',"outputTokens":' + String(end.usage.output) + "}}";
    for (const id of ids) {
      if (end.stopReason === FAILED) this.server.refuse(id, -32603, end.error);
      else this.server.answer(id, result);
    }
  }

  /** How many sessions this process holds (tests). */
  count(): number {
    return this.sessions.size;
  }
}
