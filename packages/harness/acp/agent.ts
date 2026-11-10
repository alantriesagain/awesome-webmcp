// The daemon's agent: the ACP methods over one or more sessions. A session holds the loop's state
// (its messages, the system prompt's blocks, the model, effort and mode, the folder), the client's
// `_meta.widecode` (the project's prompt and trust), the MCP servers it was given, its config
// options (the models by provider, the current model's efforts, the modes), the usage and cost so
// far, its file under the store (every message, a model or mode change, its title, appended as
// they happen; made on the first message, so a session never written leaves nothing), and the
// turn in progress: the prompt ids waiting for its end (a prompt sent mid-turn is a steering
// message answered with the turn), and the abort a cancel fires. A tool call goes out as it starts
// and as it ends, titled with the tool's name. A load of a session this process does not hold
// reads its file and shows its turns again before answering; a resume shows nothing; a fork copies
// the branch into a file of its own; the list is the folder's files. After the first turn a cheap
// model names the session; `/title` asks again, or takes the words after it. `/compact [hint]`
// summarizes the conversation so far into the loop's context, as the loop does on its own past the
// threshold; the file keeps the compaction, and a load starts the context from it. A prompt
// template of the session's, `/name words`, is expanded as the user's message (the built-in
// commands win).
import { errorMessage, listOf, parseJson, recordOf, str } from "@light/lib/json.ts";
import { log } from "@light/lib/log.ts";
import { existsSync } from "node:fs";
import { HarnessConfig } from "../config.ts";
import { Abort } from "../loop/abort.ts";
import { LoopListener } from "../loop/listener.ts";
import { CompactionResult } from "../loop/compact.ts";
import { AgentLoop, LoopSession, TurnEnd, danglingResults } from "../loop/loop.ts";
import { ModelClient } from "../model/client.ts";
import { CANCELLED, FAILED, IMAGE, Message, Part, TOOL_RESULT, Usage, textPart } from "../model/message.ts";
import { ModelInfo, ModelRegistry, costUsd } from "../model/registry.ts";
import { HarnessPaths } from "../paths.ts";
import { SystemFacts, systemBlocks } from "../prompt/system.ts";
import { scanTemplates, expandTemplate, TemplateInfo } from "../prompt/templates.ts";
import { COMPACTION, CUSTOM, Entry, MESSAGE, MODE, MODEL, TITLE } from "../session/entries.ts";
import { replayPaced, replayUpdates } from "../session/replay.ts";
import { SessionFile, SessionStore, sessionsJson } from "../session/store.ts";
import { titleFor } from "../session/title.ts";
import { McpLink, McpListing } from "../tools/mcp.ts";
import { Tool, ToolOutcome, ToolSet } from "../tools/tool.ts";
import { WebSettings } from "../tools/web.ts";
import { parseRules, rulesIn } from "../tools/permissions.ts";
import { ExtContext } from "../ext/context.ts";
import { ExtCommand, ExtSession, ExtensionsRegistry, ExtUiHost } from "../ext/extensions.ts";
import { PluginSource } from "@light/plugins/sources.ts";
import { piEntries, piEntry, piHeader } from "../ext/session-view.ts";
import { join } from "node:path";
import { Choice, ConfigOptions } from "./options.ts";
import { AcpServer, Incoming } from "./server.ts";
import { DiffBlock, chunkUpdate, commandsUpdate, modeUpdate, sessionInfoUpdate, toolCallEnd, toolCallUpdate, usageUpdate, userChunkUpdate } from "./updates.ts";

/** The context window the usage is reported against while no model says otherwise. */
const DEFAULT_WINDOW = 200000;
/** The commands a session answers in the composer. */
const COMMANDS = [
  ["compact", "summarize the conversation so far, freeing context"],
  ["title", "give the session a title"],
];

/** A user message an extension sent, waiting for a turn to start. */
class QueuedMessage {
  readonly text: string;
  readonly images: Part[];

  constructor(text: string, images: Part[]) {
    this.text = text;
    this.images = images;
  }
}

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
  /** The session's file, appended to as it goes (null in a process that keeps none). */
  file: SessionFile | null = null;
  /** Every message of the session, compacted ones included: what a load shows again. */
  history: Message[] = [];
  /** Settles once the session's MCP servers listed their tools (a turn starts after). */
  toolsReady: Promise<void> = new Promise<void>((settle) => settle());
  /** The servers' JSON text the tools were listed for. */
  linkedText = "";
  title = "";
  /** Whether a title was asked for already (once, after the first turn). */
  titled = false;
  /** The prompt templates the session offers, scanned when it opens. */
  templates: TemplateInfo[] = [];
  /** The session's extension instance (null until the session opens). */
  ext: ExtSession | null = null;
  /** Settles once the session's extensions had their session_start (a turn starts after). */
  started: Promise<void> = new Promise<void>((settle) => settle());
  /** Whether the session's commands were announced (a late registration announces them again). */
  announced = false;
  /** Whether a loop turn is in progress (a command or a compaction is not one). */
  turnActive = false;
  /** The MCP tools last listed, beside the extension tools. */
  mcpTools: Tool[] = [];
  /** User messages a running turn's extension asked to run after it, and ones waiting for an idle session. */
  followUps: QueuedMessage[] = [];
  pendingTurns: QueuedMessage[] = [];
  /** Custom messages whose triggerTurn waits for an idle session, and the user chunks' ids. */
  pendingCustomStarts: Message[] = [];
  sentSeq = 0;

  constructor(id: string, options: ConfigOptions) {
    this.id = id;
    this.options = options;
  }
}

/** The capabilities the daemon answers `initialize` with. */
const CAPABILITIES = '{"loadSession":true,"mcpCapabilities":{"http":true},"promptCapabilities":{"image":true},"sessionCapabilities":{"list":{},"fork":{}}}';

const newId = (): string => "h-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");

/** A prompt's images, as image parts (ACP's `{type: "image", mimeType, data}` blocks). */
const promptImages = (prompt: unknown): Part[] => {
  const out: Part[] = [];
  for (const v of listOf(prompt)) {
    const b = recordOf(v);
    if (b === null || str(b["type"]) !== "image" || str(b["data"]).length === 0) continue;
    const p = new Part(IMAGE);
    p.mediaType = str(b["mimeType"]).length > 0 ? str(b["mimeType"]) : "image/png";
    p.data = str(b["data"]);
    out.push(p);
  }
  return out;
};

/** The text of a prompt's blocks: the text blocks joined (images go as parts of their own). */
const promptText = (prompt: unknown): string => {
  const out: string[] = [];
  for (const v of listOf(prompt)) {
    const b = recordOf(v);
    if (b !== null && str(b["type"]) === "text") out.push(str(b["text"]));
  }
  return out.join("\n");
};

/** The session's opening: the first user message's text and the first reply's. */
const firstExchange = (messages: Message[]): string[] => {
  let prompt = "";
  let reply = "";
  for (const m of messages) {
    if (m.parts.some((p) => p.kind === TOOL_RESULT)) continue;
    if (m.role === "user" && prompt.length === 0) prompt = m.text();
    else if (m.role === "assistant" && prompt.length > 0 && m.text().length > 0) {
      reply = m.text();
      break;
    }
  }
  return [prompt, reply];
};

export class AcpAgent {
  readonly server: AcpServer;
  readonly loop: AgentLoop;
  readonly registry: ModelRegistry;
  readonly config: HarnessConfig;
  readonly build: string;
  readonly platform: string;
  readonly paths: HarnessPaths;
  /** What the web tools have (the browser, the search backends), set by the daemon. */
  web = new WebSettings();
  /** Whether the client said it takes `_widecode/ui` (initialize's `clientCapabilities._meta.widecode.ui`). */
  hasUI = false;
  private readonly sessions = new Map<string, HarnessSession>();
  readonly extensions: ExtensionsRegistry;

  constructor(server: AcpServer, client: ModelClient, tools: ToolSet, registry: ModelRegistry, config: HarnessConfig, build: string, platform: string, paths: HarnessPaths, builtins: PluginSource[] = []) {
    this.server = server;
    this.loop = new AgentLoop(client, tools);
    this.loop.compactAt = config.compactAt;
    this.registry = registry;
    this.config = config;
    this.build = build;
    this.platform = platform;
    this.paths = paths;
    const ui = new ExtUiHost();
    ui.request = (paramsText: string) => this.server.sendRequest("_widecode/ui", paramsText);
    ui.notify = (paramsText: string) => this.server.notify("_widecode/ui", paramsText);
    this.extensions = new ExtensionsRegistry(paths, ui, builtins);
  }

  /** Stop the plugins' folder watchers (the daemon is ending). */
  stop(): void {
    this.extensions.stop();
  }

  /** The folder's session files. */
  private storeFor(cwd: string): SessionStore {
    return new SessionStore(this.paths.sessionsDir(cwd));
  }

  /** The session's extension instance; a folder or trust that changed gets a new one for the new pair. */
  private extFor(s: HarnessSession): ExtSession {
    const key = this.extensions.keyFor(s.cwd, s.trusted);
    if (s.ext === null || s.ext.key !== key) {
      // A closed session's instance stays in the engine until the daemon ends (the agent has no per-session close).
      s.ext = this.extensions.forSession(s.cwd, s.trusted).instance(s.id, s.cwd);
      s.loop.ext = s.ext;
      this.wire(s, s.ext);
    }
    return s.ext;
  }

  /** The session's callbacks: what an extension's pi appends, reads, sends and names. */
  private wire(s: HarnessSession, ext: ExtSession): void {
    ext.onAppendEntry = (customType: string, dataJson: string) => this.appendCustom(s, customType, dataJson);
    ext.onSessionQuery = (query: string, arg: string) => this.sessionQuery(s, query, arg);
    ext.onSendUserMessage = (contentJson: string, optionsJson: string) => this.sendUserMessage(s, contentJson, optionsJson);
    ext.onSendMessage = (messageJson: string, optionsJson: string) => this.sendMessage(s, messageJson, optionsJson);
    ext.onSetSessionName = (name: string) => this.setSessionName(s, name);
    ext.onGetSessionName = () => s.title;
    ext.onRegistered = (kind: string) => this.afterRegistration(s, kind);
    ext.onReloaded = () => this.afterRegistration(s, "reload");
  }

  /** Appending a custom entry through the store, outside the context. */
  private appendCustom(s: HarnessSession, customType: string, dataJson: string): void {
    const e = new Entry(CUSTOM);
    e.customType = customType;
    e.dataJson = dataJson;
    this.write(s, e);
  }

  /** A read-only session manager query, its answer as JSON text. */
  private sessionQuery(s: HarnessSession, query: string, arg: string): string {
    if (query === "getSessionId") return JSON.stringify(s.id);
    if (query === "getCwd") return JSON.stringify(s.cwd);
    if (query === "getSessionName") return JSON.stringify(s.title.length > 0 ? s.title : null);
    if (query === "getLeafId") return JSON.stringify(s.file !== null && s.file.leaf.length > 0 ? s.file.leaf : null);
    if (query === "getSessionFile") {
      if (s.file === null) return "null";
      try {
        return JSON.stringify(existsSync(s.file.path()) ? s.file.path() : null);
      } catch {
        return "null";
      }
    }
    const store = this.storeFor(s.cwd);
    if (query === "getHeader") {
      const got = store.read(s.id);
      return got !== null && got.header !== null ? piHeader(got.header) : "null";
    }
    if (query === "getEntries") {
      const got = store.read(s.id);
      return got !== null ? piEntries(got.entries) : "[]";
    }
    if (query === "getBranch") {
      const got = store.load(s.id);
      return got !== null ? piEntries(got.entries) : "[]";
    }
    if (query === "getEntry") {
      const got = store.read(s.id);
      if (got !== null)
        for (const e of got.entries) if (e.id === arg) return piEntry(e);
      return "null";
    }
    return "null";
  }

  /** The context an extension callback gets. */
  private extContext(s: HarnessSession, abort: Abort | null): ExtContext {
    const c = new ExtContext();
    c.sessionId = s.id;
    c.instanceId = s.ext !== null ? s.ext.id : 0;
    c.cwd = s.cwd;
    c.modelValue = s.loop.model;
    c.systemPrompt = s.loop.system.join("\n\n");
    c.tokens = s.loop.contextEstimate();
    c.window = s.window;
    c.aborted = abort !== null && abort.aborted;
    c.idle = !s.running;
    c.hasUI = this.hasUI && s.id.length > 0;
    c.abort = () => {
      if (abort !== null) abort.fire();
    };
    return c;
  }

  /** A session_start event to the session's extensions. */
  private sessionStarted(s: HarnessSession, reason: string): void {
    const run = this.extFor(s).sessionStart(reason, this.extContext(s, null));
    s.started = run.then(
      () => {},
      (err: unknown) => {
        log("extension session_start " + s.id + ": " + errorMessage(err, "failed"));
      },
    );
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
      case "initialize": {
        const caps = p !== null ? recordOf(p["clientCapabilities"]) : null;
        const meta = caps !== null ? recordOf(recordOf(caps["_meta"])?.["widecode"]) : null;
        this.hasUI = meta !== null && meta["ui"] === true;
        this.server.answer(m.idText, '{"protocolVersion":1,"agentCapabilities":' + CAPABILITIES + ',"authMethods":[],"agentInfo":{"name":"widecode-harness","version":' + JSON.stringify(this.build) + "}}");
        return;
      }
      case "session/new": {
        const made = this.make(p);
        this.announce(m.idText, made);
        this.sessionStarted(made, "new");
        return;
      }
      case "session/load":
        this.reopen(m.idText, p, true);
        return;
      case "session/resume":
        this.reopen(m.idText, p, false);
        return;
      case "session/fork":
        this.fork(m.idText, p);
        return;
      case "session/prompt":
        this.prompt(m.idText, p);
        return;
      case "session/cancel": {
        const s = this.sessionOf(p);
        if (s !== null) {
          if (s.running) s.abort.fire();
          if (s.ext !== null) s.ext.cancelDialogs(s.id);
        }
        return;
      }
      case "session/set_config_option":
        this.setOption(m.idText, p);
        return;
      case "session/list": {
        const cwd = p !== null ? str(p["cwd"]) : "";
        this.server.answer(m.idText, '{"sessions":' + sessionsJson(this.storeFor(cwd).list(cwd)) + "}");
        return;
      }
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
    s.file = this.storeFor(s.cwd).open(s.id, s.cwd);
    this.extFor(s);
    this.apply(s);
    this.link(s);
    this.sessions.set(s.id, s);
    return s;
  }

  /** The session's MCP servers and their tools, listed again when the servers changed. */
  private link(s: HarnessSession): void {
    if (s.mcpServersText === s.linkedText) return;
    s.linkedText = s.mcpServersText;
    const links = McpLink.fromSession(s.mcpServersText);
    for (const l of links) l.httpKind = this.config.http;
    s.loop.servers = links;
    s.mcpTools = [];
    s.loop.extraTools = s.ext !== null ? s.ext.tools() : [];
    if (links.length === 0) {
      s.toolsReady = new Promise<void>((settle) => settle());
      return;
    }
    s.toolsReady = Promise.all(links.map((l) => l.listTools(new Abort()))).then((listings: McpListing[]) => {
      const tools: Tool[] = [];
      for (let i = 0; i < listings.length; i++) {
        if (listings[i].error.length > 0) log("session " + s.id + ": the tools of " + links[i].name + " not listed: " + listings[i].error);
        for (const info of listings[i].tools) {
          const t = new Tool(info.calledAs(), info.description, info.schemaJson, "other", true);
          t.title = info.titledAs();
          tools.push(t);
        }
      }
      s.mcpTools = tools;
      this.refreshTools(s);
    });
  }

  /** The extension tools as they stand plus the MCP ones last listed (a late registration). */
  private refreshTools(s: HarnessSession): void {
    const extTools = s.ext !== null ? s.ext.tools() : [];
    s.loop.extraTools = extTools.concat(s.mcpTools);
  }

  /** A tool or command registered after the session opened: its commands and tools offered again. */
  private afterRegistration(s: HarnessSession, _kind: string): void {
    if (!s.announced) return;
    this.refreshTools(s);
    this.announceCommands(s);
  }

  /** The session's commands: the built-ins, its prompt templates, its extensions'. */
  private commandsFor(s: HarnessSession): string[][] {
    const commands = COMMANDS.slice();
    for (const t of s.templates) {
      if (commands.some((c) => c[0] === t.name)) continue;
      commands.push([t.name, t.description, t.argumentHint]);
    }
    if (s.ext !== null)
      for (const c of s.ext.commands()) {
        if (commands.some((known) => known[0] === c.name)) continue;
        commands.push([c.name, c.description, ""]);
      }
    return commands;
  }

  private announceCommands(s: HarnessSession): void {
    this.server.notify("session/update", commandsUpdate(s.id, this.commandsFor(s)));
  }

  /** The stable blocks of the session's system prompt. */
  private blocksFor(s: HarnessSession): string[] {
    const f = new SystemFacts();
    f.cwd = s.cwd;
    f.platform = this.platform;
    f.harnessText = s.harnessText;
    f.trusted = s.trusted;
    f.home = this.paths.userHome;
    f.harnessRoot = this.paths.root();
    return systemBlocks(f);
  }

  /** The session's options onto its loop: the model, effort, mode, window, folder. */
  private apply(s: HarnessSession): void {
    const m0 = this.registry.model(s.options.model);
    s.loop.id = s.id;
    s.loop.hasUI = this.hasUI;
    s.loop.model = s.options.model;
    s.loop.effort = s.options.effort;
    s.loop.mode = s.options.mode;
    s.loop.cwd = s.cwd;
    s.loop.trusted = s.trusted;
    s.loop.home = this.paths.userHome;
    s.loop.harnessRoot = this.paths.root();
    s.loop.web = this.web;
    s.loop.vision = m0 !== null && m0.vision;
    s.loop.ext = s.ext;
    // The user's rules, and a trusted project's (its .widecode/config.json, read again as the session goes).
    s.loop.deny = parseRules(s.trusted && s.cwd.length > 0 ? this.config.denyRules.concat(rulesIn(join(s.cwd, ".widecode", "config.json"))) : this.config.denyRules);
    const m = this.registry.model(s.options.model);
    s.window = m !== null ? m.window : DEFAULT_WINDOW;
    s.loop.window = s.window;
    this.loop.extras = m === null || this.registry.extrasOf(m);
  }

  /** A session's answer to new, load, resume and fork: its id and options; then what it offers. */
  private announce(idText: string, s: HarnessSession): void {
    s.templates = scanTemplates(s.cwd, s.trusted, this.paths.userHome, this.paths.root());
    s.loop.system = this.blocksFor(s);
    this.server.answer(idText, '{"sessionId":' + JSON.stringify(s.id) + ',"configOptions":' + s.options.text() + "}");
    this.announceCommands(s);
    s.announced = true;
    this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
  }

  /** `e` into the session's file; a file that cannot be written is logged, the turn goes on. */
  private write(s: HarnessSession, e: Entry): void {
    const f = s.file;
    if (f === null) return;
    try {
      f.append(e);
    } catch (err) {
      log("session " + s.id + " not written: " + errorMessage(err, "error"));
    }
  }

  /** A message joined the session: kept, after the model and mode it runs on when it is the first. */
  private kept(s: HarnessSession, m: Message): void {
    s.history.push(m);
    const f = s.file;
    if (f === null) return;
    if (f.leaf.length === 0) {
      this.note(s, MODEL, s.options.model);
      if (s.options.mode !== "build") this.note(s, MODE, s.options.mode);
    }
    this.write(s, Entry.ofMessage(m, Date.now()));
  }

  /** A model, mode or title entry. */
  private note(s: HarnessSession, kind: string, value: string): void {
    this.write(s, Entry.ofValue(kind, "", value, Date.now()));
  }

  /** A session from its file: its messages, the model and mode it was last on, its title; a batch its process left unfinished gets its results. */
  private restore(id: string, cwd: string, p: Record<string, unknown> | null): HarnessSession | null {
    const got = this.storeFor(cwd).load(id);
    if (got === null) return null;
    const s = new HarnessSession(id, this.defaults());
    s.cwd = got.file.cwd.length > 0 ? got.file.cwd : cwd;
    s.file = got.file;
    const servers = p !== null ? p["mcpServers"] : null;
    s.mcpServersText = Array.isArray(servers) ? JSON.stringify(servers) : "[]";
    const messages: Message[] = [];
    // The context starts at the last compaction's first kept message, the summary standing for what came before.
    let from = 0;
    for (const e of got.entries) {
      if (e.kind === MESSAGE) messages.push(e.message());
      else if (e.kind === MODEL) {
        if (s.options.set("model", e.value).length === 0) this.effortsOf(s.options, this.registry.model(e.value));
      } else if (e.kind === MODE) s.options.set("mode", e.value);
      else if (e.kind === TITLE) s.title = e.value;
      else if (e.kind === COMPACTION) {
        s.loop.summary = e.summary;
        const at = e.firstKeptEntryId.length > 0 ? messages.findIndex((m) => m.id === e.firstKeptEntryId) : -1;
        from = at >= 0 ? at : messages.length;
      }
    }
    s.history = messages.slice();
    s.loop.takeMessages(messages);
    s.loop.messages = messages.slice(from);
    for (const m of messages)
      for (const part of m.parts) {
        if (part.kind !== TOOL_RESULT || part.acpJson.length === 0) continue;
        const k = ToolOutcome.parse(part.acpJson);
        if (k === null || k.outcome.isError) continue;
        if (k.kind === "read") for (const l of k.outcome.locations) s.loop.reads.add(l);
        if (k.outcome.diffPath.length > 0) s.loop.reads.add(k.outcome.diffPath);
      }
    const fix = danglingResults(s.loop);
    if (fix !== null) {
      s.loop.messages.push(fix);
      s.history.push(fix);
      this.write(s, Entry.ofMessage(fix, Date.now()));
    }
    s.titled = s.title.length > 0;
    this.extFor(s);
    this.apply(s);
    this.link(s);
    this.sessions.set(id, s);
    return s;
  }

  /** A session reopened: one this process holds in place, else from its file; a load shows its turns again first. One with no file is refused, and the client starts a new one. */
  private reopen(idText: string, p: Record<string, unknown> | null, replay: boolean): void {
    const held = this.sessionOf(p);
    const id = p !== null ? str(p["sessionId"]) : "";
    const found = held !== null ? held : this.restore(id, p !== null ? str(p["cwd"]) : "", p);
    if (found === null) {
      this.server.refuse(idText, -32602, "no such session here" + (id.length > 0 ? ": " + id : ""));
      return;
    }
    const s: HarnessSession = found;
    this.takeMeta(s, p);
    const servers = p !== null ? p["mcpServers"] : null;
    if (Array.isArray(servers)) s.mcpServersText = JSON.stringify(servers);
    this.extFor(s);
    this.apply(s);
    this.link(s);
    if (!replay) {
      this.announce(idText, s);
      this.sessionStarted(s, "resume");
      return;
    }
    replayPaced(replayUpdates(s.id, s.history), (text: string) => this.server.notify("session/update", text)).then(
      () => {
        this.announce(idText, s);
        this.sessionStarted(s, "resume");
      },
      (err: unknown) => this.server.refuse(idText, -32603, errorMessage(err, "the session could not be shown again")),
    );
  }

  /** A copy of the session's conversation as a session of its own (a side question's), its branch copied into a file of its own. */
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
    s.loop.takeMessages(from.history.slice());
    s.loop.messages = from.loop.messages.slice();
    s.loop.summary = from.loop.summary;
    s.loop.contextTokens = from.loop.contextTokens;
    s.loop.sinceIndex = from.loop.sinceIndex;
    s.history = from.history.slice();
    for (const r of from.loop.reads) s.loop.reads.add(r);
    s.options.model = from.options.model;
    s.options.effort = from.options.effort;
    s.options.mode = from.options.mode;
    this.effortsOf(s.options, this.registry.model(s.options.model));
    s.title = from.title;
    s.titled = true;
    // The parent's servers and tools (a fork is given none of its own).
    s.loop.servers = from.loop.servers;
    s.loop.extraTools = from.loop.extraTools;
    s.toolsReady = from.toolsReady;
    s.linkedText = s.mcpServersText;
    const store = this.storeFor(from.cwd);
    const copied = store.fork(from.id, s.id);
    s.file = copied !== null ? copied : store.open(s.id, from.cwd);
    this.extFor(s);
    this.apply(s);
    this.announce(idText, s);
    this.sessionStarted(s, "fork");
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
    // A change in a session written already is an entry; one before any message is where the first message's note comes from.
    if ((id === "model" || id === "mode") && s.file !== null && s.file.leaf.length > 0) this.note(s, id === "model" ? MODEL : MODE, value);
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
    this.extFor(s);
    const text = promptText(p["prompt"]);
    const words = text.trim();
    if (words === "/title" || words.startsWith("/title ")) {
      this.retitle(s, idText, words.slice("/title".length).trim());
      return;
    }
    if (words === "/compact" || words.startsWith("/compact ")) {
      this.compactRequested(s, idText, words.slice("/compact".length).trim());
      return;
    }
    // An extension's command, unless a prompt template of the same name wins.
    const named = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(words);
    if (named !== null && !s.templates.some((t) => t.name === named[1])) {
      const command = s.ext !== null ? s.ext.commandNamed(named[1]) : null;
      if (command !== null) {
        this.runExtensionCommand(s, idText, command, named[2] ?? "");
        return;
      }
    }
    // A prompt template of the session's, expanded as the user's message; the built-in commands above win.
    const expanded = expandTemplate(text, s.templates);
    if (s.running) {
      // A steering message: into the turn after its current request, answered with it.
      s.loop.steering.push(expanded);
      s.promptIds.push(idText);
      return;
    }
    // Its images, for a model that reads them; another is told they were left out.
    const images = promptImages(p["prompt"]);
    const model = this.registry.model(s.options.model);
    if (images.length > 0 && !(model !== null && model.vision)) {
      this.startTurn(s, expanded + "\n\n[" + String(images.length) + (images.length === 1 ? " image was" : " images were") + " attached; this model does not read images, so they were left out]", [idText], images);
      return;
    }
    s.loop.pendingImages = images;
    this.startTurn(s, expanded, [idText], images);
  }

  /** A user message's content as text and images (pi's string or text/image blocks). */
  private contentOf(content: unknown): QueuedMessage {
    if (typeof content === "string") return new QueuedMessage(content, []);
    const texts: string[] = [];
    const images: Part[] = [];
    for (const v of listOf(content)) {
      const b = recordOf(v);
      if (b === null) continue;
      if (str(b["type"]) === "text") texts.push(str(b["text"]));
      else if (str(b["type"]) === "image") {
        const p = new Part(IMAGE);
        p.mediaType = str(b["mimeType"]).length > 0 ? str(b["mimeType"]) : "image/png";
        p.data = str(b["data"]);
        if (p.data.length > 0) images.push(p);
      }
    }
    return new QueuedMessage(texts.join("\n"), images);
  }

  /** The client's user chunk for a message an extension sent. */
  private notifyUser(s: HarnessSession, q: QueuedMessage): void {
    if (q.text.length === 0) return;
    this.server.notify("session/update", userChunkUpdate(s.id, "ext" + String(++s.sentSeq), q.text));
  }

  private userMessage(s: HarnessSession, q: QueuedMessage): Message {
    const m = new Message("user", s.loop.nextUserId());
    if (q.text.length > 0) m.parts.push(textPart(q.text));
    for (const image of q.images) m.parts.push(image);
    return m;
  }

  /** An extension's user message started as a turn, as a prompt is. */
  private beginUserTurn(s: HarnessSession, q: QueuedMessage): void {
    this.notifyUser(s, q);
    this.startTurn(s, q.text, [], q.images);
  }

  /** An extension's user message steered into the turn that runs. */
  private steerUser(s: HarnessSession, q: QueuedMessage): void {
    this.notifyUser(s, q);
    s.loop.steeringMessages.push(this.userMessage(s, q));
  }

  /** pi.sendUserMessage: a turn at once when idle, steered or followed up when one runs. */
  private sendUserMessage(s: HarnessSession, contentJson: string, optionsJson: string): void {
    const q = this.contentOf(parseJson(contentJson));
    const opts = recordOf(parseJson(optionsJson));
    const deliver = opts !== null ? str(opts["deliverAs"]) : "";
    if (s.turnActive) {
      if (deliver === "followUp") s.followUps.push(q);
      else this.steerUser(s, q);
      return;
    }
    if (s.running) {
      s.pendingTurns.push(q);
      return;
    }
    this.beginUserTurn(s, q);
  }

  /** A custom message as the harness's user message, its type and details kept. */
  private customMessageOf(s: HarnessSession, value: Record<string, unknown>): Message {
    const q = this.contentOf(value["content"] === undefined ? "" : value["content"]);
    const m = this.userMessage(s, q);
    m.customType = str(value["customType"]);
    m.display = value["display"] !== false;
    m.detailsJson = value["details"] === undefined ? "" : JSON.stringify(value["details"]);
    return m;
  }

  /** pi.sendMessage: a custom message the model reads as a user message, steered or kept for the next turn. */
  private sendMessage(s: HarnessSession, messageJson: string, optionsJson: string): void {
    const value = recordOf(parseJson(messageJson));
    if (value === null) return;
    const opts = recordOf(parseJson(optionsJson));
    const deliver = opts !== null ? str(opts["deliverAs"]) : "";
    const trigger = opts !== null && opts["triggerTurn"] === true;
    const m = this.customMessageOf(s, value);
    if (deliver === "nextTurn") {
      s.loop.pendingBefore.push(m);
      return;
    }
    if (s.turnActive) {
      s.loop.steeringMessages.push(m);
      return;
    }
    if (trigger) {
      if (s.running) {
        s.pendingCustomStarts.push(m);
        return;
      }
      s.loop.pendingBefore.push(m);
      this.startTurn(s, "", [], [], true);
      return;
    }
    this.kept(s, m);
    s.loop.messages.push(m);
  }

  /** A turn waiting for the session to be idle: a queued user message, else a custom one's trigger. */
  private pumpPending(s: HarnessSession): void {
    if (s.running || s.turnActive) return;
    if (s.pendingCustomStarts.length > 0) {
      const m = s.pendingCustomStarts[0];
      s.pendingCustomStarts.splice(0, 1);
      s.loop.pendingBefore.push(m);
      this.startTurn(s, "", [], [], true);
      return;
    }
    if (s.pendingTurns.length > 0) {
      const q = s.pendingTurns[0];
      s.pendingTurns.splice(0, 1);
      this.beginUserTurn(s, q);
    }
  }

  /** A follow-up an extension sent while a turn ran starts after it. */
  private pumpFollowUps(s: HarnessSession): void {
    if (s.running || s.turnActive || s.followUps.length === 0) return;
    const q = s.followUps[0];
    s.followUps.splice(0, 1);
    this.beginUserTurn(s, q);
  }

  /** A turn: the model asked with `text`, its events to the client, the prompts `ids` answered at its end. */
  private startTurn(s: HarnessSession, text: string, ids: string[], images: Part[], skipUser = false): void {
    s.running = true;
    s.turnActive = true;
    s.promptIds = ids;
    s.abort = new Abort();
    this.apply(s);
    s.loop.system = this.blocksFor(s);
    const ext = s.ext;
    if (ext === null || ext.engine === null) {
      this.runTurn(s, text, skipUser);
      return;
    }
    s.started.then(
      () => this.beforeTurn(s, text, images, ext).then(() => this.runTurn(s, text, skipUser), (err: unknown) => this.turnFailed(s, err)),
      (err: unknown) => this.turnFailed(s, err),
    );
  }

  /** The extension's before_agent_start before the turn's first request. */
  private async beforeTurn(s: HarnessSession, text: string, images: Part[], ext: ExtSession): Promise<void> {
    const attached: Record<string, unknown>[] = [];
    for (const image of images) attached.push({ type: "image", data: image.data, mimeType: image.mediaType });
    const answer = await ext.beforeAgentStart(text, attached, s.loop.system.join("\n\n"), this.extContext(s, s.abort));
    if (answer.systemPrompt.length > 0) s.loop.system = [answer.systemPrompt];
    for (const message of answer.messages) s.loop.pendingNotes.push(message);
  }

  private turnFailed(s: HarnessSession, err: unknown): void {
    const end = new TurnEnd();
    end.stopReason = FAILED;
    end.error = err instanceof Error ? err.message : "the turn failed";
    this.turnEnded(s, end);
  }

  private runTurn(s: HarnessSession, text: string, skipUser = false): void {
    const listener = this.listenerFor(s);
    // The session's MCP tools first, when they are still being listed.
    s.toolsReady.then(
      () => this.loop.run(s.loop, text, listener, s.abort, skipUser).then((end: TurnEnd) => this.turnEnded(s, end), (err: unknown) => this.turnFailed(s, err)),
      (err: unknown) => this.turnFailed(s, err),
    );
  }

  /** `/name args` for an extension's command: the handler runs instead of a turn, the prompt answered when it settles. */
  private async runExtensionCommand(s: HarnessSession, idText: string, command: ExtCommand, args: string): Promise<void> {
    if (s.running) {
      this.said(s, idText, "A turn is running: try the command when it ends.");
      return;
    }
    s.running = true;
    s.promptIds = [idText];
    s.abort = new Abort();
    this.apply(s);
    const ext = s.ext;
    if (ext !== null && ext.engine !== null) await s.started;
    const error = ext !== null ? await ext.runCommand(command, args, this.extContext(s, s.abort)) : "the extension is not loaded";
    s.running = false;
    s.promptIds = [];
    if (error.length > 0) this.said(s, idText, error);
    else this.server.answer(idText, '{"stopReason":"end_turn","usage":{"inputTokens":0,"outputTokens":0}}');
    this.pumpPending(s);
  }

  /** The loop's events to the client and the session's file. */
  private listenerFor(s: HarnessSession): LoopListener {
    const listener = new LoopListener();
    listener.onText = (messageId: string, delta: string) => this.server.notify("session/update", chunkUpdate(s.id, "agent_message_chunk", messageId, delta));
    listener.onThinking = (messageId: string, delta: string) => this.server.notify("session/update", chunkUpdate(s.id, "agent_thought_chunk", messageId, delta));
    listener.onUsage = (usage: Usage) => {
      s.used = usage.context();
      const cost = this.costOf(s, usage);
      if (cost >= 0) s.costUsd = (s.costUsd < 0 ? 0 : s.costUsd) + cost;
      this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
    };
    // A subagent's requests: their cost counts, the context shown stays the session's.
    listener.onSubUsage = (usage: Usage) => {
      const cost = this.costOf(s, usage);
      if (cost < 0) return;
      s.costUsd = (s.costUsd < 0 ? 0 : s.costUsd) + cost;
      this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
    };
    listener.onToolStart = (callId: string, name: string, inputJson: string) => {
      // Every tool the session has, whatever the mode, its MCP ones as listed by now: a call is titled as its tool shows.
      const t = this.loop.tools.plus(s.loop.extraTools).find(name);
      const kind = t !== null ? t.kind : "other";
      const input = recordOf(JSON.parse(inputJson));
      const path = input !== null ? str(input["file_path"]) : "";
      this.server.notify("session/update", toolCallUpdate(s.id, callId, t !== null ? t.title : name, kind, "in_progress", inputJson, path.length > 0 ? [path] : []));
    };
    listener.onToolEnd = (callId: string, outcome: ToolOutcome) => {
      const diff = outcome.diffPath.length > 0 && !outcome.isError ? new DiffBlock(outcome.diffPath, outcome.created, outcome.oldText, outcome.newText) : null;
      this.server.notify("session/update", toolCallEnd(s.id, callId, outcome.isError, outcome.text, diff, outcome.rawOutputJson));
    };
    listener.onMessage = (m: Message) => this.kept(s, m);
    listener.onCompaction = (c: CompactionResult) => {
      this.write(s, Entry.ofCompaction(c.summary, c.firstKeptId, c.tokensBefore, Date.now()));
      s.used = c.tokensAfter;
      this.server.notify("session/update", usageUpdate(s.id, s.used, s.window, s.costUsd));
    };
    return listener;
  }

  /** `/compact [hint]`: everything so far summarized, the summary the context from now on; a prompt arriving meanwhile starts a turn after. */
  private compactRequested(s: HarnessSession, idText: string, hint: string): void {
    if (s.running) {
      this.said(s, idText, "A turn is running: /compact when it ends.");
      return;
    }
    s.running = true;
    s.promptIds = [idText];
    s.abort = new Abort();
    this.apply(s);
    const listener = this.listenerFor(s);
    const settle = (note: string): void => {
      s.running = false;
      const waiting = s.promptIds.slice(1);
      const steered = s.loop.steering;
      s.promptIds = [];
      s.loop.steering = [];
      this.said(s, idText, note);
      if (steered.length > 0) this.startTurn(s, steered.join("\n"), waiting, []);
    };
    this.loop.compactContext(s.loop, 0, hint, s.abort).then(
      (c: CompactionResult | null) => {
        if (c === null) return settle("Nothing to compact yet.");
        if (c.error.length > 0) return settle("Not compacted: " + c.error);
        const fn = listener.onCompaction;
        if (fn !== null) fn(c);
        settle("Compacted: " + String(c.tokensBefore) + " tokens to " + String(c.tokensAfter) + ".");
      },
      (err: unknown) => settle("Not compacted: " + errorMessage(err, "the request failed")),
    );
  }

  /** The turn is over: every prompt of it is answered with how it ended; the first turn that ended well names the session. */
  private turnEnded(s: HarnessSession, end: TurnEnd): void {
    s.running = false;
    s.turnActive = false;
    const ids = s.promptIds;
    s.promptIds = [];
    s.loop.steering = [];
    s.loop.steeringMessages = [];
    const stop = end.stopReason === CANCELLED ? "cancelled" : end.stopReason === FAILED ? "end_turn" : end.stopReason;
    const result = '{"stopReason":' + JSON.stringify(stop) + ',"usage":{"inputTokens":' + String(end.usage.input + end.usage.cacheRead + end.usage.cacheWrite) + ',"outputTokens":' + String(end.usage.output) + "}}";
    for (const id of ids) {
      if (end.stopReason === FAILED) this.server.refuse(id, -32603, end.error);
      else this.server.answer(id, result);
    }
    if (!s.titled && end.stopReason !== FAILED && end.stopReason !== CANCELLED && s.file !== null && s.file.leaf.length > 0) {
      s.titled = true;
      this.entitle(s, null);
    }
    this.pumpFollowUps(s);
    this.pumpPending(s);
  }

  /** The session's title from the model, from its opening; `idText` is a `/title` prompt to answer with the outcome. */
  private entitle(s: HarnessSession, idText: string | null): void {
    const first = firstExchange(s.loop.messages);
    if (first[0].length === 0) {
      if (idText !== null) this.said(s, idText, "Nothing to name yet: send a message first.");
      return;
    }
    titleFor(this.loop.client, this.registry, s.loop.model, first[0], first[1]).then(
      (title: string) => {
        if (title.length > 0) this.setTitle(s, title);
        if (idText !== null) this.said(s, idText, title.length > 0 ? "Titled: " + title : "No title came back.");
      },
      (err: unknown) => {
        log("session " + s.id + " not titled: " + errorMessage(err, "error"));
        if (idText !== null) this.said(s, idText, "No title came back: " + errorMessage(err, "the request failed"));
      },
    );
  }

  private setTitle(s: HarnessSession, title: string): void {
    s.title = title;
    s.titled = true;
    this.note(s, TITLE, title);
  }

  /** pi.setSessionName: the title entry `/title words` writes, and a session_info_update for the client. */
  private setSessionName(s: HarnessSession, name: string): void {
    const title = name.replace(/[\r\n]+/g, " ").trim();
    this.setTitle(s, title);
    this.server.notify("session/update", sessionInfoUpdate(s.id, title));
  }

  /** `/title <words>` names the session so; `/title` alone asks the model again. */
  private retitle(s: HarnessSession, idText: string, words: string): void {
    if (words.length > 0) {
      if (s.file !== null && s.file.leaf.length === 0) {
        this.said(s, idText, "Nothing to name yet: send a message first.");
        return;
      }
      this.setTitle(s, words);
      this.said(s, idText, "Titled: " + words);
      return;
    }
    this.entitle(s, idText);
  }

  /** A line of the agent's as the answer to prompt `idText`, outside the conversation. */
  private said(s: HarnessSession, idText: string, text: string): void {
    this.server.notify("session/update", chunkUpdate(s.id, "agent_message_chunk", "note-" + idText, text));
    this.server.answer(idText, '{"stopReason":"end_turn","usage":{"inputTokens":0,"outputTokens":0}}');
  }

  /** How many sessions this process holds (tests). */
  count(): number {
    return this.sessions.size;
  }

  /** What a request cost: what the provider said, else the model's prices applied (below 0: unknown). */
  private costOf(s: HarnessSession, usage: Usage): number {
    if (usage.reportedCost >= 0) return usage.reportedCost;
    const m = this.registry.model(s.loop.model);
    return m !== null ? costUsd(m, usage.input, usage.output, usage.cacheRead, usage.cacheWrite) : -1;
  }

  /** The messages of session `id`'s context (tests). */
  messagesOf(id: string): Message[] {
    const s = this.sessions.get(id);
    return s === undefined ? [] : s.loop.messages;
  }

  /** The context of session `id`: its message ids and its summary (tests). */
  contextOf(id: string): string {
    const s = this.sessions.get(id);
    return s === undefined ? "" : s.loop.messages.map((m) => m.id).join(",") + " " + s.loop.summary;
  }

  /** The title of session `id` ("" for none; tests). */
  titleOf(id: string): string {
    const s = this.sessions.get(id);
    return s === undefined ? "" : s.title;
  }
}
