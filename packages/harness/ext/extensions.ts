// The daemon's extensions: pi-shaped `.js` files from the store's `extensions` (beside the app's
// `plugins`) and a trusted folder's `.widecode/extensions`, run in one QuickJS context per (folder, trusted)
// pair on the @light/plugins engine. A file's default export gets its `pi` object; handlers,
// tools and commands are registered through the host. Every call has the app's 250 ms CPU budget;
// one that throws is logged and the turn goes on, one over budget is switched off for the daemon's
// life. The async answer path is the app runtime's: the prelude calls back with the call's id and
// the settled value or error, and the host keeps the invocation's outcome.
import { join } from "node:path";
import { listOf, num, parseJson, recordOf, str } from "@light/lib/json.ts";
import { log, trail } from "@light/lib/log.ts";
import { FAILED, HostAnswer, HostHandler, JsEngine, OVER_BUDGET, OK } from "@light/plugins/engine.ts";
import { PluginSource, sourcesIn } from "@light/plugins/sources.ts";
import { Abort } from "../loop/abort.ts";
import { Message } from "../model/message.ts";
import { HarnessPaths } from "../paths.ts";
import { ExtraTool, Tool, ToolContext, ToolOutcome } from "../tools/tool.ts";
import { ExtContext } from "./context.ts";
import { messagesFromPi, messagesToPi } from "./messages.ts";
import { fromPiInput, piNameOf, toPiInput } from "./names.ts";
import { EXT_PRELUDE } from "./prelude.ts";
import { extSource } from "./source.ts";

/** The app's per-call CPU budget. */
const BUDGET_MS = 250;
const MEMORY_MB = 32;

class CallResult {
  ok = true;
  text = "null";
  error = "";

  static failed(why: string): CallResult {
    const r = new CallResult();
    r.ok = false;
    r.error = why;
    return r;
  }
}

class Pending {
  failed = false;
  text = "null";
}

export class ExtEntry {
  readonly file: string;
  enabled = true;

  constructor(file: string) {
    this.file = file;
  }
}

class HandlerRef {
  readonly entry: ExtEntry;
  readonly event: string;
  readonly id: number;

  constructor(entry: ExtEntry, event: string, id: number) {
    this.entry = entry;
    this.event = event;
    this.id = id;
  }
}

class ExtToolDef {
  readonly entry: ExtEntry;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly executeId: number;

  constructor(entry: ExtEntry, name: string, label: string, description: string, parameters: unknown, executeId: number) {
    this.entry = entry;
    this.name = name;
    this.label = label;
    this.description = description;
    this.parameters = parameters;
    this.executeId = executeId;
  }
}

export class ExtCommand {
  readonly entry: ExtEntry;
  readonly name: string;
  readonly description: string;
  readonly handlerId: number;

  constructor(entry: ExtEntry, name: string, description: string, handlerId: number) {
    this.entry = entry;
    this.name = name;
    this.description = description;
    this.handlerId = handlerId;
  }
}

export class ToolCallAnswer {
  block = false;
  reason = "";
  inputJson = "";
}

export class BeforeStartAnswer {
  systemPrompt = "";
  messages: string[] = [];
}

/** An extension's extension: one folder and its trust, its files, one engine and what they registered. */
export class Extensions extends HostHandler {
  readonly folder: string;
  readonly trusted: boolean;
  readonly key: string;
  private readonly paths: HarnessPaths;
  private loaded = false;
  started = false;
  engine: JsEngine | null = null;
  private readonly entries: ExtEntry[] = [];
  readonly handlers: HandlerRef[] = [];
  readonly toolDefs: ExtToolDef[] = [];
  readonly commandDefs: ExtCommand[] = [];
  private currentFile = "";
  private runningFile = "";
  private readonly stack: ExtContext[] = [];
  private readonly pending = new Map<number, Pending>();
  private toolSeq = 0;

  constructor(paths: HarnessPaths, folder: string, trusted: boolean) {
    super();
    this.paths = paths;
    this.folder = folder;
    this.trusted = trusted;
    this.key = folder + "\u0000" + (trusted ? "1" : "0");
  }

  /** The files, the user's first and a trusted folder's after, a name found twice the first one's. */
  private findSources(): PluginSource[] {
    const out: PluginSource[] = [];
    const seen = new Set<string>();
    const dirs: string[] = [this.paths.extensionsDir()];
    if (this.trusted && this.folder.length > 0) dirs.push(join(this.folder, ".widecode", "extensions"));
    for (const dir of dirs)
      for (const source of sourcesIn(dir)) {
        const at = source.file.lastIndexOf("/");
        const name = at >= 0 ? source.file.slice(at + 1) : source.file;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(source);
      }
    return out;
  }

  /** Load the files once, on the first session that uses this pair; no file leaves no engine. */
  ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const sources = this.findSources();
    if (sources.length === 0) return;
    const engine = new JsEngine(this, MEMORY_MB, BUDGET_MS);
    this.engine = engine;
    const prelude = engine.eval(EXT_PRELUDE, "harness:ext-prelude");
    if (prelude.status !== OK) {
      log("the extension prelude: " + prelude.message());
      engine.free();
      this.engine = null;
      return;
    }
    for (const source of sources) {
      const entry = new ExtEntry(source.file);
      this.entries.push(entry);
      const passed = extSource(source);
      if (passed.error.length > 0) {
        entry.enabled = false;
        log(passed.error);
        continue;
      }
      this.currentFile = source.file;
      engine.eval("__ext.begin(" + JSON.stringify(source.file) + ")", "harness:ext-begin");
      const evaluated = engine.eval(passed.code, source.file);
      this.currentFile = "";
      if (evaluated.status !== OK) {
        entry.enabled = false;
        log("extension " + source.file + ": " + evaluated.message());
        continue;
      }
      const started = this.call(entry, 0, "[]", "start", null);
      if (!started.ok) {
        entry.enabled = false;
        log("extension " + source.file + ": " + started.error);
      }
    }
  }

  /** The handlers of `event` whose extension still runs. */
  private forEvent(event: string): HandlerRef[] {
    return this.handlers.filter((h) => h.event === event && h.entry.enabled);
  }

  private switchOff(entry: ExtEntry, why: string): void {
    if (!entry.enabled) return;
    entry.enabled = false;
    log("extension " + entry.file + " switched off: " + why);
  }

  private failedCall(entry: ExtEntry, event: string, why: string): void {
    log("extension " + entry.file + " (" + event + "): " + why);
  }

  private ctxObject(ctx: ExtContext | null): Record<string, unknown> {
    const out: Record<string, unknown> = { cwd: ctx !== null ? ctx.cwd : "", mode: "rpc", hasUI: false, model: null, aborted: ctx !== null && ctx.aborted };
    if (ctx !== null && ctx.modelValue.length > 0) out["model"] = { provider: ctx.provider(), id: ctx.modelId() };
    return out;
  }

  /** One call into the engine, its promise jobs run, the budget and errors handled; `text` the value as JSON. */
  private call(entry: ExtEntry, id: number, args: string, event: string, ctx: ExtContext | null): CallResult {
    const engine = this.engine;
    if (engine === null) return CallResult.failed("no extension context");
    if (!entry.enabled) return CallResult.failed("the extension is switched off");
    this.pending.clear();
    this.stack.push(ctx ?? new ExtContext());
    const wasFile = this.runningFile;
    this.runningFile = entry.file;
    const at = trail.enter("extension", entry.file);
    let result = FAILED;
    let text = "";
    let over = false;
    try {
      const r = engine.invoke(id, args);
      result = r.status;
      text = r.text;
      for (const job of engine.jobs()) {
        if (job.status === OVER_BUDGET) over = true;
        else if (job.status !== OK) this.failedCall(entry, event, job.message());
      }
    } finally {
      this.runningFile = wasFile;
      this.stack.pop();
      trail.leave(at);
    }
    if (result === OVER_BUDGET) over = true;
    if (over) {
      this.switchOff(entry, "it ran past its time budget (" + String(BUDGET_MS) + " ms)");
      return CallResult.failed("it ran past its time budget (" + String(BUDGET_MS) + " ms)");
    }
    if (result !== OK) {
      this.failedCall(entry, event, text.length > 0 ? (text.indexOf("\n") >= 0 ? text.slice(0, text.indexOf("\n")) : text) : "the call failed");
      return CallResult.failed(text);
    }
    const marked = recordOf(parseJson(text));
    if (marked !== null && marked["__pending"] !== undefined) {
      const cid = num(marked["__pending"], -1);
      const p = this.pending.get(cid);
      this.pending.delete(cid);
      if (p === undefined) {
        this.failedCall(entry, event, "the callback did not answer");
        return CallResult.failed("the callback did not answer");
      }
      if (p.failed) {
        this.failedCall(entry, event, p.text);
        return CallResult.failed(p.text);
      }
      const out = new CallResult();
      out.text = p.text;
      return out;
    }
    const out = new CallResult();
    out.text = text.length > 0 ? text : "null";
    return out;
  }

  override answer(name: string, argsJson: string): HostAnswer {
    const args = listOf(parseJson(argsJson));
    switch (name) {
      case "extHandler": {
        const entry = this.entryOf(str(args[0]));
        if (entry !== null) this.handlers.push(new HandlerRef(entry, str(args[1]), num(args[2], -1)));
        return new HostAnswer(OK, "null");
      }
      case "extTool": {
        const entry = this.entryOf(str(args[0]));
        if (entry !== null) this.toolDefs.push(new ExtToolDef(entry, str(args[1]), str(args[2]), str(args[3]), args[4], num(args[5], -1)));
        return new HostAnswer(OK, "null");
      }
      case "extCommand": {
        const entry = this.entryOf(str(args[0]));
        if (entry !== null) this.commandDefs.push(new ExtCommand(entry, str(args[1]), str(args[2]), num(args[3], -1)));
        return new HostAnswer(OK, "null");
      }
      case "extSettle": {
        const cid = num(args[0], -1);
        let p = this.pending.get(cid);
        if (p === undefined) {
          p = new Pending();
          this.pending.set(cid, p);
        }
        const failed = args[2] === true;
        p.failed = failed;
        p.text = failed ? str(args[1]) : JSON.stringify(args[2] === undefined ? null : args[2]);
        return new HostAnswer(OK, "null");
      }
      case "extAbort": {
        const ctx = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
        if (ctx !== null && ctx.abort !== null) ctx.abort();
        return new HostAnswer(OK, "null");
      }
      case "extIsIdle": {
        const ctx = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
        return new HostAnswer(OK, ctx !== null && ctx.idle ? "true" : "false");
      }
      case "extContextUsage": {
        const ctx = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
        const tokens = ctx !== null ? ctx.tokens : 0;
        const window = ctx !== null ? ctx.window : 0;
        return new HostAnswer(OK, JSON.stringify({ tokens, contextWindow: window, percent: window > 0 ? (tokens / window) * 100 : null }));
      }
      case "extSystemPrompt": {
        const ctx = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
        return new HostAnswer(OK, JSON.stringify(ctx !== null ? ctx.systemPrompt : ""));
      }
      case "extUi": {
        log("extension " + (this.runningFile.length > 0 ? this.runningFile : "?") + ": ui." + str(args[0]) + " " + JSON.stringify(args.slice(1)));
        return new HostAnswer(OK, "null");
      }
      default:
        return new HostAnswer(FAILED, "extensions: no host call " + name);
    }
  }

  private entryOf(file: string): ExtEntry | null {
    const wanted = file.length > 0 ? file : this.currentFile;
    for (const entry of this.entries) if (entry.file === wanted) return entry;
    return null;
  }

  /** session_start, after the files loaded: startup for a new session of this pair first, then new; resume and fork as asked. */
  sessionStart(reason: string, ctx: ExtContext): void {
    this.ensure();
    if (this.engine === null) return;
    const actual = reason === "new" && !this.started ? "startup" : reason;
    this.started = true;
    for (const h of this.forEvent("session_start")) this.call(h.entry, h.id, JSON.stringify([{ type: "session_start", reason: actual }, this.ctxObject(ctx)]), "session_start", ctx);
  }

  /** before_agent_start: a system prompt replacement and custom messages from the handlers. */
  beforeAgentStart(prompt: string, images: Record<string, unknown>[], systemPrompt: string, ctx: ExtContext): BeforeStartAnswer {
    const out = new BeforeStartAnswer();
    let current = systemPrompt;
    for (const h of this.forEvent("before_agent_start")) {
      const event: Record<string, unknown> = { type: "before_agent_start", prompt, images, systemPrompt: current };
      const r = this.call(h.entry, h.id, JSON.stringify([event, this.ctxObject(ctx)]), "before_agent_start", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null) continue;
      const system = str(answer["systemPrompt"]);
      if (system.length > 0) {
        current = system;
        out.systemPrompt = system;
      }
      const message = recordOf(answer["message"]);
      if (message !== null) {
        const content = messageText(message["content"]);
        if (content.length > 0) out.messages.push(content);
      }
    }
    return out;
  }

  /** context: the messages one request sends, replaced when a handler answers with others. */
  context(messages: Message[], ctx: ExtContext): Message[] | null {
    if (this.forEvent("context").length === 0) return null;
    let current = messagesToPi(messages);
    let replacement: Message[] | null = null;
    for (const h of this.forEvent("context")) {
      const event: Record<string, unknown> = { type: "context", messages: parseJson(current) };
      const r = this.call(h.entry, h.id, JSON.stringify([event, this.ctxObject(ctx)]), "context", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null || answer["messages"] === undefined) continue;
      const converted = messagesFromPi(answer["messages"]);
      if (converted === null) continue;
      replacement = converted;
      current = messagesToPi(converted);
    }
    return replacement;
  }

  /** tool_call: a call may be blocked or its input changed in place, in pi's names and arguments. */
  toolCall(toolCallId: string, toolName: string, inputJson: string, ctx: ExtContext): ToolCallAnswer {
    const out = new ToolCallAnswer();
    out.inputJson = inputJson;
    const handlers = this.forEvent("tool_call");
    if (handlers.length === 0) return out;
    const piName = piNameOf(toolName);
    let input = toPiInput(toolName, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {});
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_call", toolCallId, toolName: piName, input };
      const r = this.call(h.entry, h.id, JSON.stringify([event, this.ctxObject(ctx)]), "tool_call", ctx);
      if (!r.ok) {
        out.block = true;
        out.reason = "blocked by " + h.entry.file + ": " + (r.error.length > 0 ? r.error : "the extension failed");
        break;
      }
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer !== null && answer["block"] === true) {
        out.block = true;
        const why = str(answer["reason"]);
        out.reason = why.length > 0 ? "blocked by " + h.entry.file + ": " + why : "blocked by " + h.entry.file;
        break;
      }
      const changed = value !== null ? recordOf(value["input"]) : null;
      if (changed !== null) input = changed;
    }
    if (!out.block) out.inputJson = JSON.stringify(fromPiInput(toolName, input));
    return out;
  }

  /** tool_result: the content, details and error flag a handler replaces. */
  toolResult(toolCallId: string, toolName: string, inputJson: string, outcome: ToolOutcome, ctx: ExtContext): void {
    const handlers = this.forEvent("tool_result");
    if (handlers.length === 0) return;
    const piName = piNameOf(toolName);
    const piInput = toPiInput(toolName, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {});
    let content = contentText(outcome);
    let details = outcome.detailsJson.length > 0 ? parseJson(outcome.detailsJson) : null;
    let isError = outcome.isError;
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_result", toolCallId, toolName: piName, input: piInput, content: parseJson(content), details, isError };
      const r = this.call(h.entry, h.id, JSON.stringify([event, this.ctxObject(ctx)]), "tool_result", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null) continue;
      if (answer["content"] !== undefined) content = JSON.stringify(answer["content"]);
      if (answer["details"] !== undefined) details = answer["details"];
      if (typeof answer["isError"] === "boolean") isError = answer["isError"];
    }
    applyContent(outcome, parseJson(content));
    outcome.isError = isError;
    outcome.detailsJson = details === null ? "" : JSON.stringify(details);
  }

  /** The commands this pair's extensions registered, enabled ones only. */
  commands(): ExtCommand[] {
    return this.commandDefs.filter((c) => c.entry.enabled);
  }

  commandNamed(name: string): ExtCommand | null {
    for (const c of this.commandDefs) if (c.entry.enabled && c.name === name) return c;
    return null;
  }

  /** Run a command's handler; `error` says why it failed ("" when it ran). */
  runCommand(command: ExtCommand, args: string, ctx: ExtContext): string {
    const r = this.call(command.entry, command.handlerId, JSON.stringify([args, this.ctxObject(ctx)]), "command " + command.name, ctx);
    return r.ok ? "" : r.error;
  }

  /** The tools to offer the model, one per registered tool, a disabled extension's left out. */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const def of this.toolDefs) {
      if (!def.entry.enabled) continue;
      const t = new Tool(def.name, def.description, JSON.stringify(def.parameters), "other", true);
      t.title = def.label.length > 0 ? def.label : def.name;
      const extra = new ExtraTool();
      extra.runExtra = (inputJson: string, toolCtx: ToolContext, abort: Abort) => this.runTool(def, inputJson, toolCtx, abort);
      t.extra = extra;
      out.push(t);
    }
    return out;
  }

  private async runTool(def: ExtToolDef, inputJson: string, toolCtx: ToolContext, abort: Abort): Promise<ToolOutcome> {
    if (!def.entry.enabled) return ToolOutcome.failed("the extension " + def.entry.file + " is switched off");
    const ctx = new ExtContext();
    ctx.cwd = toolCtx.cwd;
    ctx.modelValue = toolCtx.modelValue;
    ctx.systemPrompt = toolCtx.systemPrompt;
    ctx.tokens = toolCtx.tokens;
    ctx.window = toolCtx.window;
    ctx.aborted = abort.aborted;
    ctx.abort = () => abort.fire();
    ctx.idle = false;
    const callId = "ext_" + String(++this.toolSeq);
    const args = JSON.stringify([callId, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {}, this.ctxObject(ctx)]);
    const r = this.call(def.entry, def.executeId, args, "tool " + def.name, ctx);
    if (!r.ok) return ToolOutcome.failed("the extension " + def.entry.file + " failed: " + r.error);
    return outcomeOf(parseJson(r.text));
  }
}

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const v of listOf(content)) {
    const r = recordOf(v);
    if (r !== null && str(r["type"]) === "text") parts.push(str(r["text"]));
  }
  return parts.join("\n");
};

const contentText = (outcome: ToolOutcome): string => {
  const parts: string[] = [JSON.stringify({ type: "text", text: outcome.text })];
  if (outcome.imageData.length > 0) parts.push(JSON.stringify({ type: "image", data: outcome.imageData, mimeType: outcome.imageType }));
  return "[" + parts.join(",") + "]";
};

const applyContent = (outcome: ToolOutcome, content: unknown): void => {
  const texts: string[] = [];
  let imageType = "";
  let imageData = "";
  for (const v of listOf(content)) {
    const r = recordOf(v);
    if (r === null) continue;
    if (str(r["type"]) === "text") texts.push(str(r["text"]));
    else if (str(r["type"]) === "image") {
      imageType = str(r["mimeType"]);
      imageData = str(r["data"]);
    }
  }
  outcome.text = texts.join("\n");
  outcome.imageType = imageType;
  outcome.imageData = imageData;
};

const outcomeOf = (value: unknown): ToolOutcome => {
  const out = new ToolOutcome();
  const r = recordOf(value);
  if (r === null) {
    out.text = "";
    return out;
  }
  let text = "";
  let imageType = "";
  let imageData = "";
  for (const v of listOf(r["content"])) {
    const c = recordOf(v);
    if (c === null) continue;
    if (str(c["type"]) === "text") text += (text.length > 0 ? "\n" : "") + str(c["text"]);
    else if (str(c["type"]) === "image") {
      imageType = str(c["mimeType"]);
      imageData = str(c["data"]);
    }
  }
  out.text = text;
  out.imageType = imageType;
  out.imageData = imageData;
  out.isError = r["isError"] === true;
  out.detailsJson = r["details"] === undefined ? "" : JSON.stringify(r["details"]);
  return out;
};

/** The extensions of the daemon's sessions, one instance per (folder, trusted) pair. */
export class ExtensionsRegistry {
  private readonly paths: HarnessPaths;
  private readonly groups = new Map<string, Extensions>();

  constructor(paths: HarnessPaths) {
    this.paths = paths;
  }

  keyFor(folder: string, trusted: boolean): string {
    return folder + "\u0000" + (trusted ? "1" : "0");
  }

  /** The pair's extensions, made on its first session and loaded then. */
  forSession(folder: string, trusted: boolean): Extensions {
    const key = this.keyFor(folder, trusted);
    const found = this.groups.get(key);
    if (found !== undefined) return found;
    const made = new Extensions(this.paths, folder, trusted);
    this.groups.set(key, made);
    made.ensure();
    return made;
  }
}

