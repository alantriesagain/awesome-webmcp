// The daemon's plugins: lightcode plugin files (one `lightcode.plugin({ id, agent(agent) })` each, the
// app's `activate` left to the app) from the built-ins the caller hands in, the store's `plugins/` and
// a trusted folder's `.lightcode/plugins/`, in the app's order: an id defined again replaces the earlier.
// One QuickJS context per (folder, trusted) pair evaluates every file once, to learn which ids have an
// agent part; none leaves no engine. A session evaluates the files of its agent parts again and calls
// each `agent(agent)` with an api of its own; handlers, tools and commands are registered through the
// host. Every call has the app's 250 ms CPU budget; one that throws is logged and the turn goes on,
// one over budget is switched off for the daemon's life. The async answer path is the app runtime's:
// the prelude calls back with the call's id and the settled value or error, and the host keeps the
// invocation's outcome.
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { readTextOr } from "@lightstart/lib/fs.ts";
import { listOf, num, parseJson, recordOf, str } from "@lightstart/lib/json.ts";
import { log, trail } from "@lightstart/lib/log.ts";
import { Closer } from "@lightstart/lib/timing.ts";
import { FAILED, HostAnswer, HostHandler, JsEngine, JsResult, OVER_BUDGET, OK } from "@lightstart/plugins/engine.ts";
import { PluginSource, isFolderPlugin, moduleFilesOf, sourcesIn } from "@lightstart/plugins/sources.ts";
import { Abort } from "../loop/abort.ts";
import { Message } from "../model/message.ts";
import { HarnessPaths, INSTALLED } from "../paths.ts";
import { ExecProcess } from "../tools/proc.ts";
import { ExtraTool, Tool, ToolContext, ToolOutcome } from "../tools/tool.ts";
import { ExtContext } from "./context.ts";
import { messagesFromAgent, messagesToAgent } from "./messages.ts";
import { EXT_PRELUDE } from "./prelude.ts";

/** The app's per-call CPU budget. */
const BUDGET_MS = 250;
const MEMORY_MB = 32;
/** How long a plugin folder's changes settle before the files are read again. */
const RELOAD_MS = 150;

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

/** A source as the engine evaluates it: a folder plugin's entry as it is (an ES module), a file's in a scope of its own. */
const scriptOf = (source: PluginSource): string => (isFolderPlugin(source.file) ? source.code : "(function () {\n" + source.code + "\n})();");

/** The generation the next folder plugin's modules are named with. */
let moduleGen = 0;

/** Evaluate a plugin's `code` from `file`: a folder plugin's as ES modules (its files registered, its entry a new generation), a file's as the script `scriptOf` made. */
const evalPlugin = (engine: JsEngine, file: string, code: string): JsResult => {
  if (!isFolderPlugin(file)) return engine.eval(code, file);
  for (const f of moduleFilesOf(file)) engine.addModule(f.file, f.code);
  moduleGen++;
  return engine.evalModule(code, file + "#" + String(moduleGen));
};

export class ExtEntry {
  readonly id: string;
  readonly file: string;
  readonly key: string;
  enabled = true;

  constructor(id: string, file: string) {
    this.id = id;
    this.file = file;
    this.key = id + "\u0000" + file;
  }
}

/** One file's source as the engine takes it. */
class LoadedSource {
  readonly file: string;
  readonly code: string;

  constructor(file: string, code: string) {
    this.file = file;
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

/** How the plugins reach the client's screen: a dialog request, and a notification. */
export class ExtUiHost {
  request: ((paramsText: string) => Promise<unknown>) | null = null;
  notify: ((paramsText: string) => void) | null = null;
  app: ((paramsText: string) => void) | null = null;
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

/** An input handler's answer: go on, transform the message, or answer it without a turn. */
export class InputAnswer {
  action = "";
  text = "";
  /** The images as JSON, in the agent's image shape. */
  images = "[]";
}

/** A session_before_compact handler's answer: skip the compaction or give its summary. */
export class CompactAnswer {
  cancel = false;
  summary = "";
}

/** A session_before_fork handler's answer: refuse the fork, and the plugin that did. */
export class ForkAnswer {
  cancel = false;
  plugin = "";
}

/** A folder and its trust: the plugin files, one engine, the ids with an agent part, and what they registered. */
export class Extensions extends HostHandler {
  readonly folder: string;
  readonly trusted: boolean;
  readonly key: string;
  private readonly paths: HarnessPaths;
  private readonly ui: ExtUiHost | null;
  private readonly builtins: PluginSource[];
  private loaded = false;
  started = false;
  engine: JsEngine | null = null;
  readonly entries: ExtEntry[] = [];
  private readonly sources: LoadedSource[] = [];
  private readonly idsByFile = new Map<string, string[]>();
  private readonly dirSources = new Map<string, LoadedSource[]>();
  agentIds: string[] = [];
  private readonly instances = new Map<number, ExtSession>();
  private instanceSeq = 0;
  private readonly execs = new Map<number, ExecProcess>();
  private readonly contexts = new Map<number, ExtContext>();
  private readonly ctxEntries = new Map<number, ExtEntry>();
  private ctxSeq = 0;
  private readonly settled = new Map<number, Pending>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly waiterEntries = new Map<number, ExtEntry>();
  private readonly dialogs = new Map<number, ExtDialog>();
  private hostSettleId = -1;
  startId = -1;
  pluginDispatchId = -1;
  private activeEntry: ExtEntry | null = null;
  private readonly closers: Closer[] = [];
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchSeq = 0;
  private syncQueued = false;
  private syncing = false;
  private calls = 0;

  constructor(paths: HarnessPaths, folder: string, trusted: boolean, ui: ExtUiHost | null, builtins: PluginSource[] = []) {
    super();
    this.paths = paths;
    this.folder = folder;
    this.trusted = trusted;
    this.ui = ui;
    this.builtins = builtins;
    this.key = folder + "\u0000" + (trusted ? "1" : "0");
  }

  /** A plugin folder's sources, an installed copy of a built-in left out while the built-ins come from beside the binary. */
  private sourcesOf(dir: string): PluginSource[] {
    const all = sourcesIn(dir);
    if (this.builtins.length === 0) return all;
    return all.filter((s) => !(isFolderPlugin(s.file) && existsSync(join(dirname(s.file), INSTALLED))));
  }

  /** The folders the plugin files are read from: the store's, and a trusted folder's. */
  private pluginDirs(): string[] {
    const out: string[] = [this.paths.pluginsDir()];
    if (this.trusted && this.folder.length > 0) out.push(join(this.folder, ".lightcode", "plugins"));
    return out;
  }

  /** Evaluate `file`'s code in the engine (a folder plugin's as ES modules, its files registered and its entry a new generation; a file's wrapped), logging a failure. */
  private evaluate(engine: JsEngine, file: string, code: string): boolean {
    const begin = engine.eval("__extFile(" + JSON.stringify(file) + ")", "harness:plugin-file");
    if (begin.status !== OK) {
      log("plugin " + file + ": " + begin.message());
      return false;
    }
    const evaluated = evalPlugin(engine, file, code);
    if (evaluated.status !== OK) {
      log("plugin " + file + ": " + evaluated.message());
      return false;
    }
    return true;
  }

  /** The ids `file` defined in the engine, from the definitions still standing for it. */
  private activeIdsFor(engine: JsEngine, file: string): string[] {
    const out: string[] = [];
    const active = engine.eval("__ext.active()", "harness:plugin-active");
    if (active.status !== OK) {
      log("plugin ids: " + active.message());
      return out;
    }
    for (const value of listOf(parseJson(active.text))) {
      const record = recordOf(value);
      if (record === null || str(record["file"]) !== file) continue;
      const id = str(record["id"]);
      if (id.length > 0 && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /** The entries from the ids each file defines, an id defined again naming the later file; `fresh` files lose a switch-off. */
  private rebuildEntries(fresh: string[]): void {
    const old = this.entries.slice();
    this.entries.length = 0;
    this.agentIds = [];
    const plugins = this.plugins();
    const named = new Map<string, string>();
    for (const source of this.sources) {
      const ids = this.idsByFile.get(source.file);
      if (ids === undefined) continue;
      for (const id of ids) named.set(id, source.file);
    }
    for (const source of this.sources) {
      const ids = this.idsByFile.get(source.file);
      if (ids === undefined) continue;
      for (const id of ids) {
        if (named.get(id) !== source.file || plugins[id] === false) continue;
        const entry = new ExtEntry(id, source.file);
        const before = old.find((e) => e.key === entry.key);
        if (before !== undefined && !fresh.includes(source.file)) entry.enabled = before.enabled;
        this.entries.push(entry);
        if (!this.agentIds.includes(id)) this.agentIds.push(id);
      }
    }
  }

  /** The files with an agent part, as they stand. */
  private agentSources(): LoadedSource[] {
    const files: string[] = [];
    for (const entry of this.entries) if (!files.includes(entry.file)) files.push(entry.file);
    const out: LoadedSource[] = [];
    for (const source of this.sources) if (files.includes(source.file)) out.push(source);
    return out;
  }

  /** The `plugins` value of the user's config.json with a trusted folder's over it, per id. */
  private plugins(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const user = this.pluginsAt(this.paths.configPath());
    for (const id of Object.keys(user)) out[id] = user[id];
    if (this.trusted && this.folder.length > 0) {
      const project = this.pluginsAt(join(this.folder, ".lightcode", "config.json"));
      for (const id of Object.keys(project)) out[id] = project[id];
    }
    return out;
  }

  private pluginsAt(path: string): Record<string, unknown> {
    const root = recordOf(parseJson(readTextOr(path, "{}")));
    const plugins = root !== null ? recordOf(root["plugins"]) : null;
    return plugins !== null ? plugins : {};
  }

  /** A plugin's section of `plugins`, an object or `{}`. */
  pluginSettings(id: string): string {
    const value = recordOf(this.plugins()[id]);
    return JSON.stringify(value !== null ? value : {});
  }

  /** Load the files once, on the first session that uses this pair, to learn which ids have an agent part; none leaves no engine. */
  ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const sources: PluginSource[] = [];
    for (const source of this.builtins) sources.push(source);
    for (const dir of this.pluginDirs()) {
      const list = this.sourcesOf(dir);
      const loaded: LoadedSource[] = [];
      for (const source of list) loaded.push(new LoadedSource(source.file, scriptOf(source)));
      this.dirSources.set(dir, loaded);
      for (const source of list) sources.push(source);
    }
    if (sources.length === 0) return;
    const engine = new JsEngine(this, MEMORY_MB, BUDGET_MS);
    this.engine = engine;
    const prelude = engine.eval(EXT_PRELUDE, "harness:plugin-prelude");
    if (prelude.status !== OK) {
      log("the plugin prelude: " + prelude.message());
      engine.free();
      this.engine = null;
      return;
    }
    const settleId = engine.eval("JSON.stringify(__hostSettleId)", "harness:plugin-prelude");
    if (settleId.status === OK) this.hostSettleId = num(parseJson(settleId.text), -1);
    const startId = engine.eval("JSON.stringify(__agentStartId)", "harness:plugin-prelude");
    if (startId.status === OK) this.startId = num(parseJson(startId.text), -1);
    const pluginDispatchId = engine.eval("JSON.stringify(__extPluginId)", "harness:plugin-prelude");
    if (pluginDispatchId.status === OK) this.pluginDispatchId = num(parseJson(pluginDispatchId.text), -1);
    engine.eval("__extReset()", "harness:plugin-prelude");
    for (const source of sources) {
      const code = scriptOf(source);
      if (!this.evaluate(engine, source.file, code)) continue;
      this.sources.push(new LoadedSource(source.file, code));
      this.idsByFile.set(source.file, this.activeIdsFor(engine, source.file));
    }
    this.rebuildEntries([]);
    if (this.agentIds.length === 0) {
      engine.free();
      this.engine = null;
      this.idsByFile.clear();
      this.sources.length = 0;
      this.dirSources.clear();
      return;
    }
    engine.eval("__extReset()", "harness:plugin-prelude");
    this.watchFolders();
  }

  /** A session's instance: the files with an agent part evaluated again with an api of its own. */
  instance(sessionId: string, cwd: string): ExtSession {
    this.ensure();
    const instance = new ExtSession(this, ++this.instanceSeq, sessionId, cwd.length > 0 ? cwd : this.folder);
    this.instances.set(instance.id, instance);
    instance.load(this.agentSources());
    return instance;
  }

  instanceOf(id: number): ExtSession | null {
    const found = this.instances.get(id);
    return found === undefined ? null : found;
  }

  /** A file's current source, null when it was removed. */
  private sourceNamed(file: string): LoadedSource | null {
    for (const source of this.sources) if (source.file === file) return source;
    return null;
  }

  /** Read every plugin folder again and reload the files that changed, were added or removed. */
  async syncNow(): Promise<void> {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    if (this.calls > 0) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    const at = trail.enter("plugins", "reload");
    try {
      await this.syncSources();
    } catch (err: unknown) {
      log("plugins: reload: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      trail.leave(at);
      this.syncing = false;
    }
    if (this.syncQueued) {
      this.syncQueued = false;
      setTimeout(() => this.syncNow(), 0);
    }
  }

  private async syncSources(): Promise<void> {
    const engine = this.engine;
    if (engine === null) return;
    const dirs = this.pluginDirs();
    const beforeFiles: string[] = [];
    for (const list of this.dirSources.values()) for (const source of list) beforeFiles.push(source.file);
    const nowByDir = new Map<string, LoadedSource[]>();
    const nowFiles: string[] = [];
    for (const dir of dirs) {
      const loaded: LoadedSource[] = [];
      for (const source of this.sourcesOf(dir)) loaded.push(new LoadedSource(source.file, scriptOf(source)));
      nowByDir.set(dir, loaded);
      for (const source of loaded) nowFiles.push(source.file);
    }
    const changed: string[] = [];
    for (const file of beforeFiles) if (!nowFiles.includes(file)) changed.push(file);
    for (const dir of dirs) {
      const before = this.dirSources.get(dir) ?? [];
      for (const source of nowByDir.get(dir) ?? []) {
        const prev = before.find((s) => s.file === source.file);
        if (prev === undefined || prev.code !== source.code) changed.push(source.file);
      }
    }
    if (changed.length === 0) return;
    const had = new Map<string, boolean>();
    for (const file of changed) had.set(file, this.entries.some((e) => e.file === file));
    this.dirSources.clear();
    for (const dir of dirs) this.dirSources.set(dir, nowByDir.get(dir) ?? []);
    this.sources.length = 0;
    for (const source of this.builtins) this.sources.push(new LoadedSource(source.file, scriptOf(source)));
    for (const dir of dirs) for (const source of this.dirSources.get(dir) ?? []) this.sources.push(source);
    const fresh: string[] = [];
    for (const file of changed) {
      fresh.push(file);
      const source = this.sourceNamed(file);
      if (source === null) {
        this.idsByFile.delete(file);
        continue;
      }
      engine.eval("__extForget(" + JSON.stringify(file) + ")", "harness:plugin-file");
      this.idsByFile.set(file, this.evaluate(engine, file, source.code) ? this.activeIdsFor(engine, file) : []);
    }
    this.rebuildEntries(fresh);
    for (const file of changed) {
      const source = this.sourceNamed(file);
      await this.reloadFile(file, source, had.get(file) === true, this.entries.some((e) => e.file === file));
    }
    this.watchFolders();
  }

  /** Reload `file` in every live instance: its shutdown, its registrations dropped, its new code and start. */
  private async reloadFile(file: string, source: LoadedSource | null, before: boolean, after: boolean): Promise<void> {
    if (!before && !after) return;
    for (const instance of Array.from(this.instances.values())) {
      if (before) {
        await instance.shutdownFile(file);
        instance.dropFile(file);
      }
      if (after && source !== null) {
        instance.reloadSource(source);
        await instance.startFile(file);
        await instance.sessionStart("reload", null, file);
      }
      if (instance.onReloaded !== null) instance.onReloaded();
    }
  }

  /** Reload every plugin of the pair in every live instance, as a save does: shutdown, the source again, start. */
  async reloadAll(): Promise<void> {
    await this.syncSources();
    const files: string[] = [];
    for (const entry of this.entries) if (!files.includes(entry.file)) files.push(entry.file);
    this.rebuildEntries(files);
    for (const file of files) {
      const source = this.sourceNamed(file);
      await this.reloadFile(file, source, true, source !== null);
    }
    this.watchFolders();
  }

  /** Watch the plugin folders and each plugin's own folder, for the files the engine has. */
  private watchFolders(): void {
    this.stopWatching();
    for (const dir of this.pluginDirs()) {
      if (!existsSync(dir)) continue;
      this.watchOne(dir);
      for (const source of this.sourcesOf(dir)) if (source.file.endsWith("/index.js") && dirname(dirname(source.file)) === dir) this.watchOne(dirname(source.file));
    }
  }

  private watchOne(dir: string): void {
    try {
      const w = watch(dir, () => this.changed());
      this.closers.push(new Closer(() => w.close()));
    } catch {
      return;
    }
  }

  /** Stop watching the plugin folders. */
  stopWatching(): void {
    for (const closer of this.closers) closer.unwatch();
    this.closers.length = 0;
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private changed(): void {
    const ticket = ++this.watchSeq;
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      if (ticket !== this.watchSeq) return;
      this.syncNow();
    }, RELOAD_MS);
  }

  private switchOff(entry: ExtEntry, why: string): void {
    if (!entry.enabled) return;
    entry.enabled = false;
    log("plugin " + entry.id + " (" + entry.file + ") switched off: " + why);
    this.waiterEntries.forEach((e: ExtEntry, cid: number) => {
      if (e !== entry) return;
      this.waiterEntries.delete(cid);
      const waiter = this.waiters.get(cid);
      this.waiters.delete(cid);
      if (waiter !== undefined && waiter.resolve !== null) waiter.resolve(CallResult.failed("the plugin is switched off"));
    });
  }

  private failedCall(entry: ExtEntry, event: string, why: string): void {
    log("plugin " + entry.id + " (" + entry.file + ") (" + event + "): " + why);
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
    if (engine === null) return CallResult.failed("no plugin context");
    if (!entry.enabled) return CallResult.failed("the plugin is switched off");
    const wasEntry = this.activeEntry;
    this.activeEntry = entry;
    const at = trail.enter("plugin", entry.file);
    let result = FAILED;
    let text = "";
    let over = false;
    this.calls++;
    try {
      const r = invoke();
      result = r.status;
      text = r.text;
      for (const job of engine.jobs()) {
        if (job.status === OVER_BUDGET) over = true;
        else if (job.status !== OK) this.failedCall(entry, event, job.message());
      }
    } finally {
      this.calls--;
      this.activeEntry = wasEntry;
      trail.leave(at);
      if (this.calls === 0 && this.syncQueued && !this.syncing) {
        this.syncQueued = false;
        setTimeout(() => this.syncNow(), 0);
      }
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
    if (engine === null) return CallResult.failed("no plugin context");
    if (!entry.enabled) return CallResult.failed("the plugin is switched off");
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

  /** The `_lightcode/ui` request a dialog sends. */
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

  /** The `_lightcode/ui` notification a ui call sends. */
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
          log("plugin " + (entry !== undefined ? entry.id + " (" + entry.file + ")" : "?") + ": ui.setWidget " + str(args[2]) + ": a function's lines are not sent");
          return new HostAnswer(OK, "null");
        }
        if (method === "setWidget" && str(args[3]) === "invalid") {
          log("plugin " + (entry !== undefined ? entry.id + " (" + entry.file + ")" : "?") + ": ui.setWidget " + str(args[2]) + ": the content is not an array of strings");
          return new HostAnswer(OK, "null");
        }
        if (ctx !== undefined && ctx.hasUI && ctx.sessionId.length > 0) {
          const text = JSON.stringify(this.uiParams(ctx.sessionId, method, args));
          const host = this.ui;
          if (host !== null && host.notify !== null) host.notify(text);
          else log("plugin " + (entry !== undefined ? entry.id + " (" + entry.file + ")" : "?") + ": ui." + method + " " + text);
        } else {
          log("plugin " + (entry !== undefined ? entry.id + " (" + entry.file + ")" : "?") + ": ui." + method + " " + JSON.stringify(args.slice(2)));
        }
        return new HostAnswer(OK, "null");
      }
      case "extAppSend": {
        const entry = this.entryOf(str(args[0]));
        const instance = this.instanceOf(num(args[1], -1));
        if (entry !== null && instance !== null && entry.enabled) {
          const params: Record<string, unknown> = { sessionId: instance.sessionId, plugin: entry.id, type: str(args[2]), data: args[3] === undefined ? null : args[3] };
          const text = JSON.stringify(params);
          const host = this.ui;
          if (host !== null && host.app !== null) host.app(text);
          else log("plugin " + entry.id + " (" + entry.file + "): agent.app.send " + text);
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
      case "extSettings": {
        const entry = this.entryOf(str(args[0]));
        return new HostAnswer(OK, entry !== null ? this.pluginSettings(entry.id) : "{}");
      }
      case "extAllTools": {
        const instance = this.instanceOf(num(args[0], -1));
        return new HostAnswer(OK, instance !== null && instance.onAllTools !== null ? instance.onAllTools() : "[]");
      }
      case "extActiveTools": {
        const instance = this.instanceOf(num(args[0], -1));
        return new HostAnswer(OK, instance !== null && instance.onActiveTools !== null ? instance.onActiveTools() : "[]");
      }
      case "extSetActiveTools": {
        const instance = this.instanceOf(num(args[0], -1));
        if (instance !== null && instance.onSetActiveTools !== null) instance.onSetActiveTools(JSON.stringify(args[1] === undefined ? [] : args[1]));
        return new HostAnswer(OK, "null");
      }
      case "extSetModel": {
        const instance = this.instanceOf(num(args[0], -1));
        const why = instance !== null && instance.onSetModel !== null ? instance.onSetModel(str(args[1])) : "no plugin session";
        return new HostAnswer(OK, why.length === 0 ? "true" : "false");
      }
      case "extSetEffort": {
        const instance = this.instanceOf(num(args[0], -1));
        const why = instance !== null && instance.onSetEffort !== null ? instance.onSetEffort(str(args[1])) : "no plugin session";
        return new HostAnswer(OK, why.length === 0 ? "true" : "false");
      }
      case "extThinkingLevel": {
        const instance = this.instanceOf(num(args[0], -1));
        return new HostAnswer(OK, JSON.stringify(instance !== null && instance.onGetEffort !== null ? instance.onGetEffort() : ""));
      }
      case "extReload": {
        const instance = this.instanceOf(num(args[0], -1));
        if (instance !== null) {
          const group = instance.owner;
          setTimeout(() => {
            group.reloadAll().catch((err: unknown) => log("plugins: reload: " + (err instanceof Error ? err.message : String(err))));
          }, 0);
        }
        return new HostAnswer(OK, "null");
      }
      case "extLog": {
        const instance = this.instanceOf(num(args[0], -1));
        log("plugin " + (instance !== null ? "session " + instance.sessionId : "?") + " " + str(args[1]) + ": " + str(args[2]));
        return new HostAnswer(OK, "null");
      }
      default:
        return new HostAnswer(FAILED, "plugins: no host call " + name);
    }
  }

  private entryOf(key: string): ExtEntry | null {
    for (const entry of this.entries) if (entry.key === key) return entry;
    return null;
  }
}

/** One session's plugins: its files evaluated again, with an agent api of its own and what it registered. */
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
  /** One of the session's files was reloaded or removed (its commands and tools are offered again). */
  onReloaded: (() => void) | null = null;
  /** The session's tools as JSON, every one and the active set, and the active set a plugin asks for. */
  onAllTools: (() => string) | null = null;
  onActiveTools: (() => string) | null = null;
  onSetActiveTools: ((namesJson: string) => void) | null = null;
  /** The session's model and effort set from a plugin ("" when taken, else why not); the effort read. */
  onSetModel: ((value: string) => string) | null = null;
  onSetEffort: ((value: string) => string) | null = null;
  onGetEffort: (() => string) | null = null;
  private toolSeq = 0;

  constructor(owner: Extensions, id: number, sessionId: string, cwd: string) {
    this.owner = owner;
    this.id = id;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.key = owner.key;
    this.engine = owner.engine;
  }

  /** Evaluate the files with an agent part again in the shared engine, then call each agent with this instance's api. */
  load(sources: LoadedSource[]): void {
    const engine = this.engine;
    if (engine === null) return;
    const starts: Promise<void>[] = [];
    for (const source of sources) {
      const begin = engine.eval("__extFile(" + JSON.stringify(source.file) + ")", "harness:plugin-file");
      if (begin.status !== OK) {
        log("plugin " + source.file + ": " + begin.message());
        continue;
      }
      const evaluated = evalPlugin(engine, source.file, source.code);
      if (evaluated.status !== OK) {
        log("plugin " + source.file + ": " + evaluated.message());
        continue;
      }
    }
    for (const entry of this.owner.entries) if (entry.enabled) starts.push(this.startEntry(entry));
    this.ready = this.settleStarts(starts);
  }

  /** Evaluate `file` again in this instance, after its old registrations were dropped. */
  reloadSource(source: LoadedSource): void {
    const engine = this.engine;
    if (engine === null) return;
    const begin = engine.eval("__extFile(" + JSON.stringify(source.file) + ")", "harness:plugin-file");
    if (begin.status !== OK) {
      log("plugin " + source.file + ": " + begin.message());
      return;
    }
    const evaluated = evalPlugin(engine, source.file, source.code);
    if (evaluated.status !== OK) log("plugin " + source.file + ": " + evaluated.message());
  }

  /** Every entry `file` defines now gets its agent part started in this instance. */
  async startFile(file: string): Promise<void> {
    for (const entry of this.owner.entries) if (entry.enabled && entry.file === file) await this.startEntry(entry);
  }

  /** session_shutdown to the handlers `file` registered, before they are dropped. */
  async shutdownFile(file: string): Promise<void> {
    for (const h of this.handlers.slice()) {
      if (h.entry.file !== file) continue;
      await this.owner.call(h.entry, h.id, JSON.stringify([{ type: "session_shutdown", reason: "reload" }, this.owner.ctxObject(null)]), "session_shutdown", null);
    }
  }

  /** Drop everything `file` registered in this instance, leaving other files' state. */
  dropFile(file: string): void {
    for (let i = this.handlers.length - 1; i >= 0; i--) if (this.handlers[i].entry.file === file) this.handlers.splice(i, 1);
    for (let i = this.toolDefs.length - 1; i >= 0; i--) if (this.toolDefs[i].entry.file === file) this.toolDefs.splice(i, 1);
    for (let i = this.commandDefs.length - 1; i >= 0; i--) if (this.commandDefs[i].entry.file === file) this.commandDefs.splice(i, 1);
  }

  private async startEntry(entry: ExtEntry): Promise<void> {
    if (this.engine === null) return;
    const started = await this.owner.call(entry, this.owner.startId, JSON.stringify([entry.id, this.id]), "start", null);
    if (!started.ok) {
      entry.enabled = false;
      log("plugin " + entry.id + " (" + entry.file + "): " + started.error);
    }
  }

  private async settleStarts(starts: Promise<void>[]): Promise<void> {
    for (const p of starts) await p;
  }

  /** The handlers of `event` this instance registered whose plugin still runs. */
  private forEvent(event: string): HandlerRef[] {
    return this.handlers.filter((h) => h.event === event && h.entry.enabled);
  }

  /** session_start, after the files loaded: startup for a new session of this pair first, then new; resume and fork as asked. `file` limits it to one file's handlers (a reload). */
  async sessionStart(reason: string, ctx: ExtContext | null, file = ""): Promise<void> {
    await this.ready;
    if (this.engine === null) return;
    const actual = reason === "new" && !this.owner.started ? "startup" : reason;
    this.owner.started = true;
    for (const h of this.forEvent("session_start")) {
      if (file.length > 0 && h.entry.file !== file) continue;
      await this.owner.call(h.entry, h.id, JSON.stringify([{ type: "session_start", reason: actual }, this.owner.ctxObject(ctx)]), "session_start", ctx);
    }
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

  /** The handlers of `event`, told `data`, their answers in order (a handler that fails is skipped). */
  private async dispatch(event: string, data: Record<string, unknown>, ctx: ExtContext): Promise<Record<string, unknown>[]> {
    const answers: Record<string, unknown>[] = [];
    for (const h of this.forEvent(event)) {
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([data, this.owner.ctxObject(ctx)]), event, ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer !== null) answers.push(answer);
    }
    return answers;
  }

  /** agent_start: a turn begins, after before_agent_start. */
  async agentStart(ctx: ExtContext): Promise<void> {
    await this.dispatch("agent_start", { type: "agent_start" }, ctx);
  }

  /** agent_end: the turn's requests are done, the messages it added. */
  async agentEnd(ctx: ExtContext, messages: Message[]): Promise<void> {
    await this.dispatch("agent_end", { type: "agent_end", messages: parseJson(messagesToAgent(messages)) }, ctx);
  }

  /** agent_settled: the prompt is answered, `aborted` when its turn was cancelled. */
  async agentSettled(ctx: ExtContext, aborted: boolean): Promise<void> {
    await this.dispatch("agent_settled", { type: "agent_settled", aborted }, ctx);
  }

  /** turn_start: before one request of the loop. */
  async turnStart(ctx: ExtContext, turnIndex: number): Promise<void> {
    await this.dispatch("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() }, ctx);
  }

  /** turn_end: after a request's tool batch, its assistant message and its tool results. */
  async turnEnd(ctx: ExtContext, turnIndex: number, message: Message, toolResults: Message[]): Promise<void> {
    const results = listOf(parseJson(messagesToAgent(toolResults)));
    const messages = listOf(parseJson(messagesToAgent([message])));
    const first = messages.length > 0 ? messages[0] : null;
    await this.dispatch("turn_end", { type: "turn_end", turnIndex, message: first, toolResults: results }, ctx);
  }

  /** input: a prompt arrives; a transform feeds the next handler, handled answers it without a turn. */
  async input(text: string, imagesJson: string, source: string, ctx: ExtContext): Promise<InputAnswer> {
    const out = new InputAnswer();
    out.text = text;
    out.images = imagesJson;
    let currentText = text;
    let currentImages = parseJson(imagesJson);
    for (const h of this.forEvent("input")) {
      const event: Record<string, unknown> = { type: "input", text: currentText, images: currentImages, source };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "input", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null) continue;
      const action = str(answer["action"]);
      if (action === "handled") {
        out.action = "handled";
        break;
      }
      if (action === "transform") {
        out.action = "transform";
        if (typeof answer["text"] === "string") currentText = answer["text"];
        if (Array.isArray(answer["images"])) currentImages = answer["images"];
      }
    }
    out.text = currentText;
    out.images = JSON.stringify(currentImages);
    return out;
  }

  /** model_select: the model option changed, by the client or a plugin. */
  async modelSelect(ctx: ExtContext, model: string, previousModel: string, source: string): Promise<void> {
    await this.dispatch("model_select", { type: "model_select", model, previousModel, source }, ctx);
  }

  /** thinking_level_select: the effort changed. */
  async thinkingLevelSelect(ctx: ExtContext, level: string, previousLevel: string): Promise<void> {
    await this.dispatch("thinking_level_select", { type: "thinking_level_select", level, previousLevel }, ctx);
  }

  /** session_before_compact: cancel the compaction or give the summary it would ask the model for. */
  async beforeCompact(ctx: ExtContext, reason: string, customInstructions: string): Promise<CompactAnswer> {
    const out = new CompactAnswer();
    for (const h of this.forEvent("session_before_compact")) {
      const event: Record<string, unknown> = { type: "session_before_compact", reason, customInstructions };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "session_before_compact", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null) continue;
      if (answer["cancel"] === true) {
        out.cancel = true;
        return out;
      }
      const compaction = recordOf(answer["compaction"]);
      const summary = compaction !== null ? str(compaction["summary"]) : "";
      if (summary.length > 0) out.summary = summary;
    }
    return out;
  }

  /** session_compact: the compaction happened, its summary from a plugin or the model. */
  async sessionCompact(ctx: ExtContext, summary: string, fromPlugin: boolean): Promise<void> {
    await this.dispatch("session_compact", { type: "session_compact", summary, fromPlugin }, ctx);
  }

  /** session_before_fork: a handler may refuse the fork. */
  /** session_before_fork: `reason` is "side" for a side question's fork, "fork" for one the user asked for; a handler may refuse it. */
  async beforeFork(reason: string, ctx: ExtContext): Promise<ForkAnswer> {
    const out = new ForkAnswer();
    for (const h of this.forEvent("session_before_fork")) {
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([{ type: "session_before_fork", reason }, this.owner.ctxObject(ctx)]), "session_before_fork", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer !== null && answer["cancel"] === true) {
        out.cancel = true;
        out.plugin = h.entry.id.length > 0 ? h.entry.id : h.entry.file;
        break;
      }
    }
    return out;
  }

  /** session_shutdown: every handler the instance has, before the daemon or a reload ends them. */
  async sessionShutdown(reason: string): Promise<void> {
    for (const h of this.handlers.slice()) {
      await this.owner.call(h.entry, h.id, JSON.stringify([{ type: "session_shutdown", reason }, this.owner.ctxObject(null)]), "session_shutdown", null);
    }
  }

  /** context: the messages one request sends, replaced when a handler answers with others. */
  async context(messages: Message[], ctx: ExtContext): Promise<Message[] | null> {
    if (this.forEvent("context").length === 0) return null;
    let current = messagesToAgent(messages);
    let replacement: Message[] | null = null;
    for (const h of this.forEvent("context")) {
      const event: Record<string, unknown> = { type: "context", messages: parseJson(current) };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "context", ctx);
      if (!r.ok) continue;
      const value = recordOf(parseJson(r.text));
      const answer = value !== null ? recordOf(value["result"]) : null;
      if (answer === null || answer["messages"] === undefined) continue;
      const converted = messagesFromAgent(answer["messages"]);
      if (converted === null) continue;
      replacement = converted;
      current = messagesToAgent(converted);
    }
    return replacement;
  }

  /** tool_call: a call may be blocked or its input changed in place, under the harness's own tool names and inputs. */
  async toolCall(toolCallId: string, toolName: string, inputJson: string, ctx: ExtContext): Promise<ToolCallAnswer> {
    const out = new ToolCallAnswer();
    out.inputJson = inputJson;
    const handlers = this.forEvent("tool_call");
    if (handlers.length === 0) return out;
    let input = recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {};
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_call", toolCallId, toolName, input };
      const r = await this.owner.call(h.entry, h.id, JSON.stringify([event, this.owner.ctxObject(ctx)]), "tool_call", ctx);
      if (!r.ok) {
        out.block = true;
        out.reason = "blocked by " + h.entry.file + ": " + (r.error.length > 0 ? r.error : "the plugin failed");
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
    if (!out.block) out.inputJson = JSON.stringify(input);
    return out;
  }

  /** tool_result: the content, details and error flag a handler replaces. */
  async toolResult(toolCallId: string, toolName: string, inputJson: string, outcome: ToolOutcome, ctx: ExtContext): Promise<void> {
    const handlers = this.forEvent("tool_result");
    if (handlers.length === 0) return;
    const input = recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {};
    let content = contentText(outcome);
    let details = outcome.detailsJson.length > 0 ? parseJson(outcome.detailsJson) : null;
    let isError = outcome.isError;
    for (const h of handlers) {
      const event: Record<string, unknown> = { type: "tool_result", toolCallId, toolName, input, content: parseJson(content), details, isError };
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

  /** The commands this instance's plugins registered, enabled ones only. */
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

  /** A `_lightcode/plugin` message from the app to plugin `plugin`'s agent part in this instance. */
  async receivePlugin(plugin: string, type: string, dataJson: string): Promise<void> {
    const id = this.owner.pluginDispatchId;
    if (id < 0) return;
    let entry: ExtEntry | null = null;
    for (const e of this.owner.entries) {
      if (e.id !== plugin) continue;
      entry = e;
      break;
    }
    if (entry === null || !entry.enabled) return;
    const data = parseJson(dataJson.length > 0 ? dataJson : "null");
    await this.owner.call(entry, id, JSON.stringify([this.id, plugin, type, data]), "app " + type, null);
  }

  /** The tools to offer the model, one per registered tool, a disabled plugin's left out. */
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
    if (!def.entry.enabled) return ToolOutcome.failed("the plugin " + def.entry.id + " (" + def.entry.file + ") is switched off");
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
    if (!r.ok) return ToolOutcome.failed("the plugin " + def.entry.id + " (" + def.entry.file + ") failed: " + r.error);
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

/** The plugins of the daemon's sessions: one engine per (folder, trusted) pair, an instance per session. */
export class ExtensionsRegistry {
  private readonly paths: HarnessPaths;
  private readonly ui: ExtUiHost | null;
  private readonly builtins: PluginSource[];
  private readonly groups = new Map<string, Extensions>();

  constructor(paths: HarnessPaths, ui: ExtUiHost | null = null, builtins: PluginSource[] = []) {
    this.paths = paths;
    this.ui = ui;
    this.builtins = builtins;
  }

  keyFor(folder: string, trusted: boolean): string {
    return folder + "\u0000" + (trusted ? "1" : "0");
  }

  /** Stop every pair's watchers. */
  stop(): void {
    for (const group of this.groups.values()) group.stopWatching();
  }

  /** The pair's plugins, made on its first session and loaded then. */
  forSession(folder: string, trusted: boolean): Extensions {
    const key = this.keyFor(folder, trusted);
    const found = this.groups.get(key);
    if (found !== undefined) return found;
    const made = new Extensions(this.paths, folder, trusted, this.ui, this.builtins);
    this.groups.set(key, made);
    made.ensure();
    return made;
  }
}

