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
import { FAILED, HostAnswer, HostHandler, JsEngine, JsResult, OVER_BUDGET, OK } from "@light/plugins/engine.ts";
import { PluginSource, sourcesIn } from "@light/plugins/sources.ts";
import { Abort } from "../loop/abort.ts";
import { Message } from "../model/message.ts";
import { HarnessPaths } from "../paths.ts";
import { ExecProcess } from "../tools/proc.ts";
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

class Waiter {
  resolve: ((r: CallResult) => void) | null = null;
}

export class ExtEntry {
  readonly file: string;
  enabled = true;

  constructor(file: string) {
    this.file = file;
  }
}

/** One file's source after the pass, with the entry its state is kept on. */
class LoadedSource {
  readonly entry: ExtEntry;
  readonly code: string;

  constructor(entry: ExtEntry, code: string) {
    this.entry = entry;
    this.code = code;
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

/** How the extensions reach the client's screen: a dialog request, and a notification. */
export class ExtUiHost {
  request: ((paramsText: string) => Promise<unknown>) | null = null;
  notify: ((paramsText: string) => void) | null = null;
}

/** One dialog waiting on the client: what settles it, and the default it falls back to. */
class ExtDialog {
  readonly entry: ExtEntry;
  readonly hostId: number;
  readonly sessionId: string;
  readonly defaultValue: unknown;
  settled = false;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(entry: ExtEntry, hostId: number, sessionId: string, defaultValue: unknown) {
    this.entry = entry;
    this.hostId = hostId;
    this.sessionId = sessionId;
    this.defaultValue = defaultValue;
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
  private readonly ui: ExtUiHost | null;
  private loaded = false;
  started = false;
  engine: JsEngine | null = null;
  private readonly entries: ExtEntry[] = [];
  private readonly sources: LoadedSource[] = [];
  private readonly instances = new Map<number, ExtSession>();
  private instanceSeq = 0;
  private readonly execs = new Map<number, ExecProcess>();
  private currentFile = "";
  private readonly contexts = new Map<number, ExtContext>();
  private readonly ctxEntries = new Map<number, ExtEntry>();
  private ctxSeq = 0;
  private readonly settled = new Map<number, Pending>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly waiterEntries = new Map<number, ExtEntry>();
  private readonly dialogs = new Map<number, ExtDialog>();
  private hostSettleId = -1;
  private activeEntry: ExtEntry | null = null;

  constructor(paths: HarnessPaths, folder: string, trusted: boolean, ui: ExtUiHost | null) {
    super();
    this.paths = paths;
    this.folder = folder;
    this.trusted = trusted;
    this.ui = ui;
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
    const settleId = engine.eval("JSON.stringify(__hostSettleId)", "harness:ext-prelude");
    if (settleId.status === OK) this.hostSettleId = num(parseJson(settleId.text), -1);
    for (const source of sources) {
      const entry = new ExtEntry(source.file);
      this.entries.push(entry);
      const passed = extSource(source);
      if (passed.error.length > 0) {
        entry.enabled = false;
        log(passed.error);
        continue;
      }
      this.sources.push(new LoadedSource(entry, passed.code));
    }
  }

  /** A session's instance: every enabled file evaluated again with a `pi` of its own, its handlers, tools and commands its own. */
  instance(sessionId: string, cwd: string): ExtSession {
    this.ensure();
    const instance = new ExtSession(this, ++this.instanceSeq, sessionId, cwd.length > 0 ? cwd : this.folder);
    this.instances.set(instance.id, instance);
    instance.load(this.sources);
    return instance;
  }

  instanceOf(id: number): ExtSession | null {
    const found = this.instances.get(id);
    return found === undefined ? null : found;
  }

  private switchOff(entry: ExtEntry, why: string): void {
    if (!entry.enabled) return;
    entry.enabled = false;
    log("extension " + entry.file + " switched off: " + why);
    this.waiterEntries.forEach((e: ExtEntry, cid: number) => {
      if (e !== entry) return;
      this.waiterEntries.delete(cid);
      const waiter = this.waiters.get(cid);
      this.waiters.delete(cid);
      if (waiter !== undefined && waiter.resolve !== null) waiter.resolve(CallResult.failed("the extension is switched off"));
    });
  }

  private failedCall(entry: ExtEntry, event: string, why: string): void {
    log("extension " + entry.file + " (" + event + "): " + why);
  }

  ctxObject(ctx: ExtContext | null): Record<string, unknown> {
    const out: Record<string, unknown> = { cwd: ctx !== null ? ctx.cwd : "", mode: "rpc", hasUI: ctx !== null && ctx.hasUI, model: null, aborted: ctx !== null && ctx.aborted };
    if (ctx !== null) {
      ctx.ctxId = ++this.ctxSeq;
      out["ctxId"] = ctx.ctxId;
    }
    if (ctx !== null && ctx.modelValue.length > 0) out["model"] = { provider: ctx.provider(), id: ctx.modelId() };
    return out;
  }

  private pendingResult(entry: ExtEntry, event: string, p: Pending): CallResult {
    if (p.failed) {
      this.failedCall(entry, event, p.text);
      return CallResult.failed(p.text);
    }
    const out = new CallResult();
    out.text = p.text;
    return out;
  }

  /** The invocation and the promise jobs it left, the budget, the trail and the switch-off; `text` the value as JSON. */
  private invokeAndPump(entry: ExtEntry, event: string, invoke: () => JsResult): CallResult {
    const engine = this.engine;
    if (engine === null) return CallResult.failed("no extension context");
    if (!entry.enabled) return CallResult.failed("the extension is switched off");
    const wasEntry = this.activeEntry;
    this.activeEntry = entry;
    const at = trail.enter("extension", entry.file);
    let result = FAILED;
    let text = "";
    let over = false;
    try {
      const r = invoke();
      result = r.status;
      text = r.text;
      for (const job of engine.jobs()) {
        if (job.status === OVER_BUDGET) over = true;
        else if (job.status !== OK) this.failedCall(entry, event, job.message());
      }
    } finally {
      this.activeEntry = wasEntry;
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
    const out = new CallResult();
    out.text = text.length > 0 ? text : "null";
    return out;
  }

  /** One call into the engine, its answer awaited when a promise settles later; `text` the value as JSON. */
  async call(entry: ExtEntry, id: number, args: string, event: string, ctx: ExtContext | null): Promise<CallResult> {
    const engine = this.engine;
    if (engine === null) return CallResult.failed("no extension context");
    if (!entry.enabled) return CallResult.failed("the extension is switched off");
    const ctxId = ctx !== null ? ctx.ctxId : 0;
    if (ctx !== null) {
      this.contexts.set(ctxId, ctx);
      this.ctxEntries.set(ctxId, entry);
    }
    try {
      const r = this.invokeAndPump(entry, event, () => engine.invoke(id, args));
      if (!r.ok) return r;
      const marked = recordOf(parseJson(r.text));
      if (marked === null || marked["__pending"] === undefined) return r;
      const cid = num(marked["__pending"], -1);
      const done = this.settled.get(cid);
      if (done !== undefined) {
        this.settled.delete(cid);
        return this.pendingResult(entry, event, done);
      }
      const waiter = new Waiter();
      this.waiters.set(cid, waiter);
      this.waiterEntries.set(cid, entry);
      const result = await new Promise<CallResult>((resolve) => {
        waiter.resolve = resolve;
      });
      if (!result.ok) this.failedCall(entry, event, result.error);
      return result;
    } finally {
      if (ctx !== null) {
        this.contexts.delete(ctxId);
        this.ctxEntries.delete(ctxId);
      }
    }
  }

  /** The host's answer to a call it kept `hostLater`: invoke the prelude's settle function and pump its jobs. */
  settleHost(entry: ExtEntry, id: number, error: string, valueJson: string): void {
    const engine = this.engine;
    if (engine === null || this.hostSettleId < 0) return;
    const value = parseJson(valueJson.length > 0 ? valueJson : "null");
    const args = JSON.stringify([id, error.length > 0 ? error : null, value]);
    this.invokeAndPump(entry, "host", () => engine.invoke(this.hostSettleId, args));
  }

  /** A dialog answered: settle the waiting call with `value`; a later answer is ignored. */
  private settleDialog(d: ExtDialog, value: unknown): void {
    if (d.settled) return;
    d.settled = true;
    if (d.timer !== null) {
      clearTimeout(d.timer);
      d.timer = null;
    }
    this.dialogs.delete(d.hostId);
    this.settleHost(d.entry, d.hostId, "", JSON.stringify(value === undefined ? null : value));
  }

  /** Every open dialog of `sessionId` resolves its default (a turn's cancel). */
  cancelDialogs(sessionId: string): void {
    for (const d of Array.from(this.dialogs.values())) if (d.sessionId === sessionId) this.settleDialog(d, d.defaultValue);
  }

  /** What a client's answer to a dialog settles: its value, its confirmation, or the default. */
  private dialogValue(method: string, result: unknown, fallback: unknown): unknown {
    const r = recordOf(result);
    if (r === null || r["cancelled"] === true) return fallback;
    if (method === "confirm") return typeof r["confirmed"] === "boolean" ? r["confirmed"] : fallback;
    return typeof r["value"] === "string" ? r["value"] : fallback;
  }

  /** The `_widecode/ui` request a dialog sends. */
  private dialogParams(sessionId: string, method: string, fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { sessionId, method, title: str(fields["title"]) };
    if (method === "select") {
      const options: string[] = [];
      for (const v of listOf(fields["options"])) if (typeof v === "string") options.push(v);
      out["options"] = options;
    } else if (method === "confirm") out["message"] = str(fields["message"]);
    else if (method === "input") out["placeholder"] = str(fields["placeholder"]);
    else if (method === "editor") out["prefill"] = str(fields["prefill"]);
    const timeout = num(fields["timeout"], 0);
    if (timeout > 0) out["timeout"] = timeout;
    return out;
  }

  /** The `_widecode/ui` notification a ui call sends. */
  private uiParams(sessionId: string, method: string, args: unknown[]): Record<string, unknown> {
    const out: Record<string, unknown> = { sessionId, method };
    if (method === "notify") {
      out["message"] = str(args[2]);
      out["notifyType"] = str(args[3]);
    } else if (method === "setStatus") {
      out["statusKey"] = str(args[2]);
      if (args[3] !== null && args[3] !== undefined) out["statusText"] = str(args[3]);
    } else if (method === "setWidget") {
      out["widgetKey"] = str(args[2]);
      if (str(args[3]) === "lines") {
        const lines: string[] = [];
        for (const v of listOf(args[4])) if (typeof v === "string") lines.push(v);
        out["widgetLines"] = lines;
      }
      if (typeof args[5] === "string" && args[5].length > 0) out["widgetPlacement"] = args[5];
    } else if (method === "setTitle") out["title"] = str(args[2]);
    else if (method === "set_editor_text") out["text"] = str(args[2]);
    return out;
  }

  override answer(name: string, argsJson: string): HostAnswer {
    const args = listOf(parseJson(argsJson));
    switch (name) {
      case "extHandler": {
        const entry = this.entryOf(str(args[0]));
        const instance = this.instanceOf(num(args[1], -1));
        if (entry !== null && instance !== null) instance.handlers.push(new HandlerRef(entry, str(args[2]), num(args[3], -1)));
        return new HostAnswer(OK, "null");
      }
      case "extTool": {
        const entry = this.entryOf(str(args[0]));
        const instance = this.instanceOf(num(args[1], -1));
        if (entry !== null && instance !== null) {
          instance.toolDefs.push(new ExtToolDef(entry, str(args[2]), str(args[3]), str(args[4]), args[5], num(args[6], -1)));
          if (instance.onRegistered !== null) instance.onRegistered("tool");
        }
        return new HostAnswer(OK, "null");
      }
      case "extCommand": {
        const entry = this.entryOf(str(args[0]));
        const instance = this.instanceOf(num(args[1], -1));
        if (entry !== null && instance !== null) {
          instance.commandDefs.push(new ExtCommand(entry, str(args[2]), str(args[3]), num(args[4], -1)));
          if (instance.onRegistered !== null) instance.onRegistered("command");
        }
        return new HostAnswer(OK, "null");
      }
      case "extSettle": {
        const cid = num(args[0], -1);
        const failed = args[2] === true;
        const p = new Pending();
        p.failed = failed;
        p.text = failed ? str(args[1]) : JSON.stringify(args[2] === undefined ? null : args[2]);
        const waiter = this.waiters.get(cid);
        if (waiter !== undefined) {
          this.waiters.delete(cid);
          this.waiterEntries.delete(cid);
          if (waiter.resolve !== null) {
            const out = new CallResult();
            out.ok = !failed;
            out.text = p.text;
            out.error = failed ? p.text : "";
            waiter.resolve(out);
          }
        } else {
          this.settled.set(cid, p);
        }
        return new HostAnswer(OK, "null");
      }
      case "extExec": {
        const hostId = num(args[0], -1);
        const execId = num(args[1], -1);
        const instance = this.instanceOf(num(args[2], -1));
        const entry = this.entryOf(str(args[3]));
        const command = str(args[4]);
        const argv: string[] = [];
        for (const v of listOf(args[5])) argv.push(str(v));
        const options = recordOf(args[6]) ?? {};
        const wanted = str(options["cwd"]);
        const cwd = wanted.length > 0 ? wanted : instance !== null ? instance.cwd : this.folder;
        const run = new ExecProcess(command, argv, cwd, num(options["timeout"], 0));
        this.execs.set(execId, run);
        run.done.then((result) => {
          this.execs.delete(execId);
          if (entry === null) return;
          const value: Record<string, unknown> = { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed, truncated: result.truncated };
          this.settleHost(entry, hostId, "", JSON.stringify(value));
        });
        return new HostAnswer(OK, "null");
      }
      case "extExecKill": {
        const run = this.execs.get(num(args[0], -1));
        if (run !== undefined) run.kill();
        return new HostAnswer(OK, "null");
      }
      case "extAbort": {
        const ctx = this.contexts.get(num(args[0], -1));
        if (ctx !== undefined && ctx.abort !== null) ctx.abort();
        return new HostAnswer(OK, "null");
      }
      case "extIsIdle": {
        const ctx = this.contexts.get(num(args[0], -1));
        return new HostAnswer(OK, ctx !== undefined && ctx.idle ? "true" : "false");
      }
      case "extContextUsage": {
        const ctx = this.contexts.get(num(args[0], -1));
        const tokens = ctx !== undefined ? ctx.tokens : 0;
        const window = ctx !== undefined ? ctx.window : 0;
        return new HostAnswer(OK, JSON.stringify({ tokens, contextWindow: window, percent: window > 0 ? (tokens / window) * 100 : null }));
      }
      case "extSystemPrompt": {
        const ctx = this.contexts.get(num(args[0], -1));
        return new HostAnswer(OK, JSON.stringify(ctx !== undefined ? ctx.systemPrompt : ""));
      }
      case "extDialog": {
        const hostId = num(args[0], -1);
        const ctxId = num(args[1], -1);
        const method = str(args[2]);
        const fields = recordOf(args[3]) ?? {};
        const ctx = this.contexts.get(ctxId);
        const entry = this.ctxEntries.get(ctxId);
        const fallback: unknown = method === "confirm" ? false : null;
        if (ctx === undefined || entry === undefined || !ctx.hasUI || ctx.sessionId.length === 0) {
          if (entry !== undefined) this.settleHost(entry, hostId, "", JSON.stringify(fallback));
          return new HostAnswer(OK, "null");
        }
        const d = new ExtDialog(entry, hostId, ctx.sessionId, fallback);
        this.dialogs.set(hostId, d);
        const host = this.ui;
        if (host === null || host.request === null) {
          this.settleDialog(d, fallback);
          return new HostAnswer(OK, "null");
        }
        const timeout = num(fields["timeout"], 0);
        if (timeout > 0) d.timer = setTimeout(() => this.settleDialog(d, fallback), timeout);
        host.request(JSON.stringify(this.dialogParams(ctx.sessionId, method, fields))).then(
          (result: unknown) => this.settleDialog(d, this.dialogValue(method, result, fallback)),
          () => this.settleDialog(d, fallback),
        );
        return new HostAnswer(OK, "null");
      }
      case "extUi": {
        const ctxId = num(args[0], -1);
        const entry = this.ctxEntries.get(ctxId);
        const ctx = this.contexts.get(ctxId);
        const method = str(args[1]);
        if (method === "setWidget" && str(args[3]) === "function") {
          log("extension " + (entry !== undefined ? entry.file : "?") + ": ui.setWidget " + str(args[2]) + ": a function's lines are not sent");
          return new HostAnswer(OK, "null");
        }
        if (method === "setWidget" && str(args[3]) === "invalid") {
          log("extension " + (entry !== undefined ? entry.file : "?") + ": ui.setWidget " + str(args[2]) + ": the content is not an array of strings");
          return new HostAnswer(OK, "null");
        }
        if (ctx !== undefined && ctx.hasUI && ctx.sessionId.length > 0) {
          const text = JSON.stringify(this.uiParams(ctx.sessionId, method, args));
          const host = this.ui;
          if (host !== null && host.notify !== null) host.notify(text);
          else log("extension " + (entry !== undefined ? entry.file : "?") + ": ui." + method + " " + text);
        } else {
          log("extension " + (entry !== undefined ? entry.file : "?") + ": ui." + method + " " + JSON.stringify(args.slice(2)));
        }
        return new HostAnswer(OK, "null");
      }
      case "extAppendEntry": {
        const instance = this.instanceOf(num(args[1], -1));
        if (instance !== null && instance.onAppendEntry !== null) instance.onAppendEntry(str(args[2]), args[3] === null || args[3] === undefined ? "" : JSON.stringify(args[3]));
        return new HostAnswer(OK, "null");
      }
      case "extSession": {
        const ctx = this.contexts.get(num(args[0], -1));
        const instance = ctx !== undefined ? this.instanceOf(ctx.instanceId) : null;
        if (instance !== null && instance.onSessionQuery !== null) return new HostAnswer(OK, instance.onSessionQuery(str(args[1]), str(args[2])));
        return new HostAnswer(OK, "null");
      }
      case "extSendUserMessage": {
        const instance = this.instanceOf(num(args[1], -1));
        if (instance !== null && instance.onSendUserMessage !== null) instance.onSendUserMessage(JSON.stringify(args[2] === undefined ? null : args[2]), JSON.stringify(args[3] === undefined ? null : args[3]));
        return new HostAnswer(OK, "null");
      }
      case "extSendMessage": {
        const instance = this.instanceOf(num(args[1], -1));
        if (instance !== null && instance.onSendMessage !== null) instance.onSendMessage(JSON.stringify(args[2] === undefined ? null : args[2]), JSON.stringify(args[3] === undefined ? null : args[3]));
        return new HostAnswer(OK, "null");
      }
      case "extSetSessionName": {
        const instance = this.instanceOf(num(args[1], -1));
        if (instance !== null && instance.onSetSessionName !== null) instance.onSetSessionName(str(args[2]));
        return new HostAnswer(OK, "null");
      }
      case "extGetSessionName": {
        const instance = this.instanceOf(num(args[1], -1));
        const name = instance !== null && instance.onGetSessionName !== null ? instance.onGetSessionName() : "";
        return new HostAnswer(OK, JSON.stringify(name.length > 0 ? name : null));
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
}

/** One session's extensions: the same files evaluated again, with a `pi` of its own and what it registered. */
export class ExtSession {
  readonly owner: Extensions;
  readonly id: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly key: string;
  readonly engine: JsEngine | null;
  readonly handlers: HandlerRef[] = [];
  readonly toolDefs: ExtToolDef[] = [];
  readonly commandDefs: ExtCommand[] = [];
  ready: Promise<void> = new Promise<void>((settle) => settle());
  /** Appending a custom entry to the session's file. */
  onAppendEntry: ((customType: string, dataJson: string) => void) | null = null;
  /** A read-only session manager query, its answer as JSON text. */
  onSessionQuery: ((query: string, arg: string) => string) | null = null;
  /** Sending a user message or a custom one. */
  onSendUserMessage: ((contentJson: string, optionsJson: string) => void) | null = null;
  onSendMessage: ((messageJson: string, optionsJson: string) => void) | null = null;
  /** The session's title set or read. */
  onSetSessionName: ((name: string) => void) | null = null;
  onGetSessionName: (() => string) | null = null;
  /** A tool or command was registered after the session opened. */
  onRegistered: ((kind: string) => void) | null = null;
  private toolSeq = 0;

  constructor(owner: Extensions, id: number, sessionId: string, cwd: string) {
    this.owner = owner;
    this.id = id;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.key = owner.key;
    this.engine = owner.engine;
  }

  /** Evaluate every enabled file again in the shared engine, its default export called with this instance's `pi`. */
  load(sources: LoadedSource[]): void {
    const engine = this.engine;
    if (engine === null) return;
    const starts: Promise<void>[] = [];
    for (const source of sources) {
      if (!source.entry.enabled) continue;
      const begin = engine.eval("__ext.begin(" + JSON.stringify(source.entry.file) + ", " + String(this.id) + ")", "harness:ext-begin");
      if (begin.status !== OK) {
        log("extension " + source.entry.file + ": " + begin.message());
        continue;
      }
      const evaluated = engine.eval(source.code, source.entry.file);
      if (evaluated.status !== OK) {
        source.entry.enabled = false;
        log("extension " + source.entry.file + ": " + evaluated.message());
        continue;
      }
      starts.push(this.startEntry(source.entry));
    }
    this.ready = this.settleStarts(starts);
  }

  private async startEntry(entry: ExtEntry): Promise<void> {
    const started = await this.owner.call(entry, 0, "[]", "start", null);
    if (!started.ok) {
      entry.enabled = false;
      log("extension " + entry.file + ": " + started.error);
    }
  }

  private async settleStarts(starts: Promise<void>[]): Promise<void> {
    for (const p of starts) await p;
  }

  /** The handlers of `event` this instance registered whose extension still runs. */
  private forEvent(event: string): HandlerRef[] {
    return this.handlers.filter((h) => h.event === event && h.entry.enabled);
  }

  /** session_start, after the files loaded: startup for a new session of this pair first, then new; resume and fork as asked. */
  async sessionStart(reason: string, ctx: ExtContext): Promise<void> {
    await this.ready;
    if (this.engine === null) return;
    const actual = reason === "new" && !this.owner.started ? "startup" : reason;
    this.owner.started = true;
    for (const h of this.forEvent("session_start")) await this.owner.call(h.entry, h.id, JSON.stringify([{ type: "session_start", reason: actual }, this.owner.ctxObject(ctx)]), "session_start", ctx);
  }

  /** before_agent_start: a system prompt replacement and custom messages from the handlers. */
  async beforeAgentStart(prompt: string, images: Record<string, unknown>[], systemPrompt: string, ctx: ExtContext): Promise<BeforeStartAnswer> {
    const out = new BeforeStartAnswer();
    let current = systemPrompt;
    for (const h of this.forEvent("before_agent_start")) {
      const event: Record<string, unknown> = { type: "before_agent_start", prompt, images, systemPrompt: current };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "before_agent_start", ctx);
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
  async context(messages: Message[], ctx: ExtContext): Promise<Message[] | null> {
    if (this.forEvent("context").length === 0) return null;
    let current = messagesToPi(messages);
    let replacement: Message[] | null = null;
    for (const h of this.forEvent("context")) {
      const event: Record<string, unknown> = { type: "context", messages: parseJson(current) };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "context", ctx);
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
  async toolCall(toolCallId: string, toolName: string, inputJson: string, ctx: ExtContext): Promise<ToolCallAnswer> {
    const out = new ToolCallAnswer();
    out.inputJson = inputJson;
    const handlers = this.forEvent("tool_call");
    if (handlers.length === 0) return out;
    const piName = piNameOf(toolName);
    let input = toPiInput(toolName, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {});
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_call", toolCallId, toolName: piName, input };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "tool_call", ctx);
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
  async toolResult(toolCallId: string, toolName: string, inputJson: string, outcome: ToolOutcome, ctx: ExtContext): Promise<void> {
    const handlers = this.forEvent("tool_result");
    if (handlers.length === 0) return;
    const piName = piNameOf(toolName);
    const piInput = toPiInput(toolName, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {});
    let content = contentText(outcome);
    let details = outcome.detailsJson.length > 0 ? parseJson(outcome.detailsJson) : null;
    let isError = outcome.isError;
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_result", toolCallId, toolName: piName, input: piInput, content: parseJson(content), details, isError };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "tool_result", ctx);
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

  /** The commands this instance's extensions registered, enabled ones only. */
  commands(): ExtCommand[] {
    return this.commandDefs.filter((c) => c.entry.enabled);
  }

  commandNamed(name: string): ExtCommand | null {
    for (const c of this.commandDefs) if (c.entry.enabled && c.name === name) return c;
    return null;
  }

  /** Run a command's handler; `error` says why it failed ("" when it ran). */
  async runCommand(command: ExtCommand, args: string, ctx: ExtContext): Promise<string> {
    const r = await this.owner.call(command.entry, command.handlerId, JSON.stringify([args, this.owner.ctxObject(ctx)]), "command " + command.name, ctx);
    return r.ok ? "" : r.error;
  }

  /** Dialogs this instance's session opened resolve to their defaults. */
  cancelDialogs(sessionId: string): void {
    this.owner.cancelDialogs(sessionId);
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
    ctx.sessionId = toolCtx.sessionId;
    ctx.hasUI = toolCtx.hasUI;
    ctx.instanceId = this.id;
    const callId = "ext_" + String(++this.toolSeq);
    const args = JSON.stringify([callId, recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {}, this.owner.ctxObject(ctx)]);
    const r = await this.owner.call(def.entry, def.executeId, args, "tool " + def.name, ctx);
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

/** The extensions of the daemon's sessions: one engine per (folder, trusted) pair, an instance per session. */
export class ExtensionsRegistry {
  private readonly paths: HarnessPaths;
  private readonly ui: ExtUiHost | null;
  private readonly groups = new Map<string, Extensions>();

  constructor(paths: HarnessPaths, ui: ExtUiHost | null = null) {
    this.paths = paths;
    this.ui = ui;
  }

  keyFor(folder: string, trusted: boolean): string {
    return folder + "\u0000" + (trusted ? "1" : "0");
  }

  /** The pair's extensions, made on its first session and loaded then. */
  forSession(folder: string, trusted: boolean): Extensions {
    const key = this.keyFor(folder, trusted);
    const found = this.groups.get(key);
    if (found !== undefined) return found;
    const made = new Extensions(this.paths, folder, trusted, this.ui);
    this.groups.set(key, made);
    made.ensure();
    return made;
  }
}

