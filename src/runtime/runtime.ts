// widecode's JS plugins: their sources (the built-in ones in the binary, then the user's in
// ~/.widecode/plugins, then the project's in .widecode/plugins once the folder is trusted)
// evaluated in one QuickJS context after the prelude; each `widecode.plugin(...)` becomes a kernel
// plugin (JsPlugin), a later one of an id replacing an earlier, so a user's file overrides a
// built-in. Their calls into the core (`__host`) are answered here: commands, keys, hooks,
// messages, settings; the tools they add are served to agents over MCP (src/agent/mcp.ts), each
// call going to its plugin. A plugin's function that throws is reported; one that runs past its time
// budget is switched off. A file saved in a plugin folder reloads its own plugins alone, after a
// moment: the new source is evaluated into the live context first (a file that fails keeps its
// previous plugins running), then the old instances are retired, their functions freed, and the
// new ones started; the agent and every other plugin go on. `reload` (/reload) is the full one: it
// stops every JS plugin, drops what they added, and evaluates the sources again in a fresh context.
import { trail } from "@lightstart/lib/log.ts";
import { errorMessage } from "@lightstart/lib/json.ts";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Host } from "../host/host.ts";
import { Agent } from "../conversation/agent.ts";
import { Plugin } from "@lightstart/kernel/plugin.ts";
import { SegmentContext } from "../screen/contributions.ts";
import { removeLanguages } from "@lightstart/highlight/registry.ts";
import { ChatWidget } from "../views/chat-widget.ts";
import { CodeWidget } from "../views/code-widget.ts";
import { ToolsWidget } from "../views/tools-widget.ts";
import { Bridge, FAILED, HostAnswer, JsEngine, JsResult, OK, OVER_BUDGET } from "@lightstart/plugins/engine.ts";
import { JsAgent } from "./agent.ts";
import { PluginProcess } from "@lightstart/plugins/process.ts";
import { PluginSource, sourcesIn } from "@lightstart/plugins/sources.ts";
import { PRELUDE } from "./prelude.ts";
import { PluginTable } from "./registry.ts";
import { ProcessTable } from "./processes.ts";
import { HostRouter } from "./router.ts";
import { ViewTable } from "./view-registry.ts";
import { McpCall, McpServer } from "../agent/mcp.ts";
import { ProcessRun, spawnCapped, SpawnOptions } from "@lightstart/lib/process.ts";
import { Closer, Latest } from "@lightstart/lib/timing.ts";
import { json, answer, objectText, refuse } from "../api/values.ts";

/** How long a folder's events gather before the plugins reload. */
const PROCESS_OUT_MAX = 64 * 1024 * 1024;
const RELOAD_MS = 300;
/** Plugin errors kept for `plugins.list` and the log. */
const ERRORS_KEPT = 100;

/** A plugin a JS source registered, run through the runtime; `reg` is its registration in the prelude (the functions it made), `gen` the instance started last. */
/** A plugin source as the status bar names it: a file's name, a folder plugin's folder (`notes/`). */
const shownName = (file: string): string => (basename(file) === "index.js" ? basename(dirname(file)) + "/" : basename(file));

export class JsPlugin extends Plugin {
  readonly runtime: JsRuntime;
  readonly activateFn: number;
  readonly deactivateFn: number;
  readonly defaultValue: unknown;
  readonly file: string;
  readonly reg: number;
  gen = 0;

  constructor(runtime: JsRuntime, id: string, requires: string[], defaultValue: unknown, activateFn: number, deactivateFn: number, file: string, reg: number) {
    super(id, requires);
    this.runtime = runtime;
    this.defaultValue = defaultValue;
    this.activateFn = activateFn;
    this.deactivateFn = deactivateFn;
    this.file = file;
    this.reg = reg;
  }

  override activate(): void {
    this.gen = this.runtime.table.nextInstance();
    if (this.activateFn < 0) return;
    const r = this.runtime.invoke(this.id, this.activateFn, "[]");
    if (r.status !== OK) this.problem = r.message();
  }

  override deactivate(): void {
    if (this.deactivateFn >= 0) this.runtime.invoke(this.id, this.deactivateFn, "[]");
    // The languages registry outlives the app: what the plugin registered goes with it.
    removeLanguages(this.id);
  }

  override defaults(): unknown {
    return this.defaultValue;
  }
}

/** What a late callback of plugin `owner` checks before running: the load and the instance it came from are the ones running. */
export class Life {
  readonly owner: string;
  readonly generation: number;
  readonly gen: number;

  constructor(owner: string, generation: number, gen: number) {
    this.owner = owner;
    this.generation = generation;
    this.gen = gen;
  }
}


export class JsRuntime extends Bridge {
  readonly host: Host;
  /** The prelude every context starts with; a plugin check evaluates it in a context of its own. */
  readonly prelude: string = PRELUDE;
  /** The built-in plugins' sources, compiled into the binary. */
  builtins: PluginSource[] = [];
  /** The native code widget a plugin can mount as the code column (null: none). */
  code: CodeWidget | null = null;
  /** The native chat widget a plugin can mount as the chat column (null: none). */
  chat: ChatWidget | null = null;
  /** The Tools tab's widget, for the plugin that mounts it. */
  tools: ToolsWidget | null = null;
  /** Plugin folders, in order: the user's, then the project's when trusted. */
  dirs: string[] = [];
  /** Sources added after all the others (tests). */
  extra: PluginSource[] = [];
  memoryMb = 64;
  budgetMs = 250;
  /** The plugins' registrations, the ones running, and their loaded sources. */
  readonly table = new PluginTable();
  /** What went wrong loading or running plugins (also told and logged). */
  errors: string[] = [];
  private engine: JsEngine | null = null;
  private file = "";
  /** The file being evaluated again on its own, and what it registered meanwhile. */
  private evaluating = "";
  private registered: JsPlugin[] = [];
  /** Files whose reload waits for the running call into JS to return. */
  private pendingFiles: string[] = [];
  /** The tools changed since toolsChanged last fired. */
  toolsDirty = false;
  /** The tabs, band strips and code views JS plugins draw. */
  readonly views = new ViewTable();
  /** The segments' context as JSON, kept for the frame it was made in. */
  private ctxNow = -1;
  private ctxJson = "";
  private closers: Closer[] = [];
  /** The agents plugins brought, and the processes they started (by handle). */
  agents: JsAgent[] = [];
  private readonly processes = new ProcessTable();
  private readonly reloads = new Latest();
  /** How many calls into JS are running (a plugin's call into the core may call another plugin), and a reload waiting for them. */
  private depth = 0;
  /** The plugin whose function is running, and its registration, for an owner-bound call. */
  callingOwner = "";
  callingReg = 0;
  private reloadAfter = false;
  /** widecode's MCP server: the tools plugins add, for the agents (it listens once an agent's plugin asks where). */
  readonly mcp = new McpServer("widecode");
  /** The core side of a plugin's calls. */
  readonly router: HostRouter;
  /** What ends a tool call whose agent cancelled it, by the MCP call's id. */
  private cancels = new Map<number, { owner: string; fn: number }>();

  constructor(host: Host) {
    super();
    this.host = host;
    this.mcp.onToolCall = (call: McpCall) => this.toolCall(call);
    this.mcp.onToolCancel = (call: McpCall) => this.toolCancel(call);
    this.router = new HostRouter(this);
  }

  /** Every registration of the context, shadowed ones included (a view of the table). */
  get defs(): JsPlugin[] {
    return this.table.defs;
  }

  /** The plugins running in the kernel, in order (a view of the table). */
  get plugins(): JsPlugin[] {
    return this.table.plugins;
  }

  /** The folder sources as they were evaluated last (a view of the table). */
  get loaded(): PluginSource[] {
    return this.table.loaded;
  }

  /** An agent called a plugin's tool: the plugin gets the call's id, arguments and the agent's own tool-use id, and answers with toolDone. */
  private toolCall(call: McpCall): void {
    const owner = call.tool.owner;
    if (!this.host.kernel.has(owner)) {
      this.mcp.answer(call.id, "the plugin " + owner + " does not run", true);
      return;
    }
    const r = this.invoke(owner, call.tool.fn, "[" + String(call.id) + "," + call.args + "," + JSON.stringify(call.toolUseId) + "]");
    if (r.status !== OK) this.mcp.answer(call.id, owner + " failed: " + r.message(), true);
  }

  /** A plugin's tool call registered what ends it when the agent cancels. */
  setToolCancel(owner: string, callId: number, fn: number): void {
    this.cancels.set(callId, { owner, fn });
  }

  /** The agent cancelled a tool call: run what the plugin registered for it, once. */
  private toolCancel(call: McpCall): void {
    const cancel = this.cancels.get(call.id);
    if (cancel === undefined) return;
    this.cancels.delete(call.id);
    if (this.host.kernel.has(cancel.owner)) this.invoke(cancel.owner, cancel.fn, "[]");
  }

  /** A tool call answered: what could cancel it is dropped. */
  forgetToolCancel(callId: number): void {
    this.cancels.delete(callId);
  }

  /** Every source, in order: built-in, then each folder's files by name. */
  sources(): PluginSource[] {
    const out = this.builtins.slice();
    for (const d of this.dirs) for (const s of sourcesIn(d)) out.push(s);
    for (const s of this.extra) out.push(s);
    return out;
  }

  /** A fresh context: the prelude, then every source, whose plugins join the kernel (not yet started). */
  load(): void {
    const engine = new JsEngine(this, this.memoryMb, this.budgetMs);
    this.engine = engine;
    this.table.reset();
    this.views.clear();
    if (!this.loadPrelude(engine)) return;
    const all = this.sources();
    for (const s of all) {
      const r = this.evalSource(engine, s);
      if (r.status !== OK) this.fail(s.file + ": " + r.message());
    }
    this.table.loaded = all.filter((s) => this.inFolders(s.file));
  }

  /** The prelude into a fresh context; false, and a problem, when it fails. */
  private loadPrelude(engine: JsEngine): boolean {
    const r = engine.eval(PRELUDE, "widecode:prelude");
    if (r.status === OK) return true;
    this.fail("the plugin prelude: " + r.message());
    return false;
  }

  /** Evaluate a source as the file it came from, in a scope of its own (two files may use the same top-level names). */
  private evalSource(engine: JsEngine, s: PluginSource): JsResult {
    this.file = s.file;
    engine.eval("__file(" + JSON.stringify(s.file) + ")", "widecode:file");
    const r = engine.eval("(function () {\n" + s.code + "\n})();", s.file);
    this.file = "";
    return r;
  }

  /** Free what registration `d` made in the context and drop its definition. */
  private retireDef(engine: JsEngine, d: JsPlugin): void {
    engine.eval("__retire(" + String(d.reg) + ")", "widecode:retire");
    this.table.removeDef(d);
  }

  /** Whether `file` is in one of the plugin folders. */
  private inFolders(file: string): boolean {
    for (const d of this.dirs) if (file.startsWith(d + "/")) return true;
    return false;
  }

  /** The instance of `owner` running now, 0 for none. */
  genOf(owner: string): number {
    for (const p of this.table.plugins) if (p.id === owner) return p.gen;
    return 0;
  }

  /** A stamp for a callback plugin `owner` registers now. */
  life(owner: string): Life {
    return new Life(owner, this.table.generation, this.genOf(owner));
  }

  /** Whether the load and the instance `l` came from are the ones running. */
  alive(l: Life): boolean {
    return l.generation === this.table.generation && this.host.kernel.has(l.owner) && this.genOf(l.owner) === l.gen;
  }

  /** End plugin `owner`'s processes. */
  private killProcessesOf(owner: string): void {
    this.processes.killOwner(owner);
  }

  /** Stop plugin `p` and drop what it added: its agents, processes, tools, tabs, strips and views; the conversation keeps its session for the agent that comes back. */
  retire(p: JsPlugin, why: string): void {
    const id = p.id;
    const c = this.host.conversation;
    const active = c.agent.owner === id;
    if (active) {
      const sid = c.sessionId;
      if (sid.length > 0) c.resumeId = sid;
    }
    for (let i = this.agents.length - 1; i >= 0; i--)
      if (this.agents[i].owner === id) {
        this.agents[i].retire();
        this.agents.splice(i, 1);
      }
    this.killProcessesOf(id);
    const before = this.mcp.tools.length;
    this.mcp.failOwner(id, why);
    this.mcp.forgetOwner(id);
    this.mcp.tools = this.mcp.tools.filter((t) => t.owner !== id);
    if (this.mcp.tools.length !== before) this.toolsDirty = true;
    for (const stopped of this.host.kernel.remove(id)) this.host.removeOwner(stopped);
    this.views.removeOwner(id);
    this.table.removeRunning(p);
    // Its agent left with it: the conversation talks to Claude, or to nothing when no agent is left.
    if (active) this.fallBackAgent(id);
  }

  /** The plugin that played the conversation's agent went: choose Claude, else a base agent that says it has none. */
  private fallBackAgent(owner: string): void {
    const c = this.host.conversation;
    const why = this.host.session.useAgent("claude");
    if (why.length === 0) return;
    c.agent = new Agent();
    this.host.session.agentId.value = "claude";
    c.changed();
    this.fail("agent " + owner + " went away; " + why);
  }

  /**
   * Stop the plugins a folder brought and forget its sources: the folder was closed (another
   * opened). A plugin the folder replaced comes back.
   */
  forgetFolder(dir: string): void {
    if (dir.length === 0) return;
    const files: string[] = [];
    for (const d of this.table.defs) if (d.file.startsWith(dir + "/") && !files.includes(d.file)) files.push(d.file);
    for (const file of files) this.reloadFile(file, null);
    this.table.forgetUnder(dir);
    this.dirs = this.dirs.filter((d) => d !== dir);
  }

  /** Start the registration of `id` that comes last among the files still there (a replacement gone brings the built-in back); one switched off in the config stays out. */
  private revive(id: string): void {
    const found = this.table.lastDef(id, (file) => file.startsWith("builtin:") || existsSync(file) || this.extra.some((s) => s.file === file));
    if (found === null || this.host.kernel.has(id) || this.host.kernel.settings.isOff(id)) return;
    found.problem = "";
    this.table.addRunning(found);
    this.host.kernel.use(found);
  }

  /** Stop plugin `id` and start it again (its settings changed), or start it when it was off and is on now, or stop it when it is off now. */
  reloadPlugin(id: string): void {
    for (const p of this.table.plugins.slice()) if (p.id === id) this.retire(p, "its settings changed");
    this.revive(id);
    const k = this.host.kernel;
    const before = k.problems.length;
    k.startNew();
    for (let i = before; i < k.problems.length; i++) this.fail(k.problems[i]);
    this.host.filesLoaded.fire();
    this.host.statusLoaded.fire();
    this.host.conversationChanged.fire();
    this.flushToolsChanged();
  }

  /** The source of `file` as it is on disk now, null when it is gone. */
  private readSource(file: string): PluginSource | null {
    try {
      if (!statSync(file).isFile()) return null;
      return new PluginSource(file, readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Evaluate `file` again on its own (`source`, null when the file is gone): its new plugins
   * replace the ones it defined, the agent and every other plugin untouched. A source that fails
   * keeps the previous plugins running. Deferred while a call into JS runs.
   */
  reloadFile(file: string, source: PluginSource | null): void {
    if (this.depth > 0) {
      if (!this.pendingFiles.includes(file)) this.pendingFiles.push(file);
      return;
    }
    const engine = this.engine;
    if (engine === null) return;
    const k = this.host.kernel;
    const active = this.host.screen.active.peek();
    const tabs = this.host.screen.shownTabs();
    const old = this.table.defsFor(file);
    let fresh: JsPlugin[] = [];
    if (source !== null) {
      this.evaluating = file;
      this.registered = [];
      const r = this.evalSource(engine, source);
      this.evaluating = "";
      fresh = this.registered;
      this.registered = [];
      if (r.status !== OK) {
        for (const p of fresh) this.retireDef(engine, p);
        this.fail(file + ": " + r.message());
        return;
      }
    }
    const retired: string[] = [];
    for (const d of old) {
      if (this.table.plugins.includes(d)) {
        this.retire(d, "its plugin " + d.id + " reloaded; call the tool again");
        retired.push(d.id);
      }
      this.retireDef(engine, d);
    }
    const ids: string[] = [];
    for (const p of fresh) {
      for (const running of this.table.plugins.slice()) if (running.id === p.id) this.retire(running, "its plugin " + p.id + " was replaced; call the tool again");
      this.table.addRunning(p);
      k.use(p);
      ids.push(p.id);
    }
    for (const id of retired) if (!fresh.some((p) => p.id === id)) this.revive(id);
    const before = k.problems.length;
    k.startNew();
    for (let i = before; i < k.problems.length; i++) this.fail(k.problems[i]);
    for (const id of tabs) this.host.screen.setShown(id);
    this.host.screen.focus(active);
    this.host.filesLoaded.fire();
    this.host.statusLoaded.fire();
    this.host.conversationChanged.fire();
    this.flushToolsChanged();
    this.host.screen.tell(source === null ? "removed " + shownName(file) + (retired.length > 0 ? ": " + retired.join(", ") : "") : "reloaded " + shownName(file) + (ids.length > 0 ? ": " + ids.join(", ") : ""));
  }

  /** Read folder `dir` again and reload the files that differ from what was evaluated last: changed, added, removed. */
  syncFolder(dir: string): void {
    const now = sourcesIn(dir);
    const before = this.table.loadedIn(dir);
    this.table.replaceLoaded(dir, now);
    for (const s of before) if (!now.some((n) => n.file === s.file)) this.reloadFile(s.file, null);
    for (const n of now) {
      const prev = before.find((s) => s.file === n.file);
      if (prev === undefined || prev.code !== n.code) this.reloadFile(n.file, n);
    }
  }

  /** Evaluate `file` again once the running call returns (a plugin folder's file, relative to the project folder or absolute; "" for every plugin, a full reload): "" when taken, else why not. */
  reloadPath(file: string): string {
    if (file.length === 0) {
      this.reload();
      return "";
    }
    const path = isAbsolute(file) ? file : join(this.host.workspace.folder, file);
    if (!this.inFolders(path)) return path + " is not in a plugin folder (" + this.dirs.join(", ") + ")";
    const source = this.readSource(path);
    this.table.removeLoaded(path);
    if (source !== null) this.table.addLoaded(source);
    this.reloadFile(path, source);
    return "";
  }

  /** Fire toolsChanged once for the tools that changed, outside any call into JS. */
  flushToolsChanged(): void {
    if (!this.toolsDirty || this.depth > 0) return;
    this.toolsDirty = false;
    this.host.toolsChanged.fire();
  }

  /** Stop every JS plugin, drop what they added, evaluate the sources again and start them. */
  reload(): void {
    // Asked for from inside a plugin's call (a plugin running /reload): its context is still in use, so after the call.
    if (this.depth > 0) {
      this.reloadAfter = true;
      return;
    }
    const k = this.host.kernel;
    // Where the user was: the plugins' columns and tabs go and come back, the focus with them.
    const active = this.host.screen.active.peek();
    const tabs = this.host.screen.shownTabs();
    // The conversation keeps its session: the agent that comes back resumes it on the next message.
    const c = this.host.conversation;
    const sid = c.sessionId;
    if (sid.length > 0) c.resumeId = sid;
    // The plugins' agents and processes go with their context; the new load registers the agents again.
    for (const a of this.agents) a.retire();
    this.agents = [];
    this.killProcesses();
    // Their tools go with them (the new load adds them again); a call waiting on one is answered, its question withdrawn.
    this.mcp.failAll("widecode's plugins reloaded; call the tool again");
    this.mcp.tools = [];
    this.host.conversation.settleAsks(true);
    for (const p of this.table.plugins) {
      k.remove(p.id);
      this.host.removeOwner(p.id);
    }
    const old = this.engine;
    if (old !== null) old.free();
    this.errors = [];
    this.load();
    const keysNote = this.host.keys.applyUser();
    if (keysNote.length > 0) this.fail(keysNote);
    const before = k.problems.length;
    k.startNew();
    for (let i = before; i < k.problems.length; i++) this.fail(k.problems[i]);
    for (const id of tabs) this.host.screen.setShown(id);
    this.host.screen.focus(active);
    // The new plugins catch up with the state the others already saw.
    this.host.filesLoaded.fire();
    this.host.statusLoaded.fire();
    this.host.conversationChanged.fire();
    this.toolsDirty = true;
    this.flushToolsChanged();
    this.host.screen.tell("plugins reloaded: " + String(this.table.plugins.length) + (this.errors.length > 0 ? ", " + String(this.errors.length) + " with problems (see the log)" : ""));
  }

  /** End every process a plugin started (a reload, widecode quitting). */
  killProcesses(): void {
    this.processes.killAll();
  }

  /** The agent the conversation talks to when a plugin brought it. */
  chosenAgent(): JsAgent | null {
    const c = this.host.conversation.agent;
    for (const a of this.agents) if (a === c) return a;
    return null;
  }

  process(id: number): PluginProcess | null {
    return this.processes.find(id);
  }

  /** Start plugin `owner`'s long-running `command` in `cwd`; its lines, exit and errors go to `onLines`, `onExit`, `onError`. Answers its handle, -1 when it could not start (`onError` hears why). */
  spawnProcess(owner: string, command: string[], cwd: string, onLines: number, onExit: number, onError: number): number {
    const l = this.life(owner);
    const live = (): boolean => this.alive(l);
    const p = this.processes.create(owner);
    p.onLines = (lines: string[]) => {
      if (live() && onLines >= 0) this.invoke(owner, onLines, "[" + JSON.stringify(lines) + "]");
    };
    p.onExit = (code: number) => {
      this.processes.remove(p);
      if (live() && onExit >= 0) this.invoke(owner, onExit, "[" + String(code) + "]");
    };
    p.onError = (text: string) => {
      if (live() && onError >= 0) this.invoke(owner, onError, "[" + json(text) + "]");
    };
    const error = p.start(command, cwd);
    if (error.length > 0) {
      if (onError >= 0) this.invoke(owner, onError, "[" + json(error) + "]");
      return -1;
    }
    this.processes.add(p);
    return p.id;
  }

  /** Reload the files that changed when a plugin folder or a plugin's own folder in it changes (after its events settle); plugin folders made later are not watched, a plugin's folder made later is once a change syncs. */
  watchFolders(): void {
    this.stopWatching();
    for (const d of this.dirs) {
      if (!existsSync(d)) continue;
      this.watchOne(d);
      // A plugin of its own folder: its index.js changes inside it, which the folder's watch does not hear.
      for (const s of sourcesIn(d)) if (s.file.endsWith("/index.js") && dirname(dirname(s.file)) === d) this.watchOne(dirname(s.file));
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

  stopWatching(): void {
    for (const c of this.closers) c.unwatch();
    this.closers = [];
  }

  private changed(): void {
    const ticket = this.reloads.next();
    setTimeout(() => {
      if (!this.reloads.is(ticket)) return;
      for (const d of this.dirs) this.syncFolder(d);
      // A plugin's folder added or removed: its own watch comes or goes.
      if (this.closers.length > 0) this.watchFolders();
    }, RELOAD_MS);
  }

  /** `invoke` with a budget of `budgetMs` for this call (and the calls it makes), the usual one after. */
  override invokeLong(owner: string, id: number, args: string, budgetMs: number): JsResult {
    const engine = this.engine;
    if (engine === null) return new JsResult(FAILED, "widecode: no plugin context");
    engine.setBudget(budgetMs);
    const saved = this.budgetMs;
    this.budgetMs = budgetMs;
    try {
      return this.invoke(owner, id, args);
    } finally {
      this.budgetMs = saved;
      engine.setBudget(saved);
    }
  }

  /** Call plugin `owner`'s function `id` with `args` (a JSON array): past its budget it is switched off, an error is reported. */
  invoke(owner: string, id: number, args: string): JsResult {
    const engine = this.engine;
    if (engine === null) return new JsResult(FAILED, "widecode: no plugin context");
    const at = trail.enter("plugin", owner);
    this.depth++;
    const wasOwner = this.callingOwner;
    const wasReg = this.callingReg;
    this.callingOwner = owner;
    const running = this.table.running(owner);
    this.callingReg = running !== null ? running.reg : 0;
    let r: JsResult;
    try {
      r = engine.invoke(id, args);
    } finally {
      this.callingOwner = wasOwner;
      this.callingReg = wasReg;
    }
    const jobs = engine.jobs();
    this.depth--;
    let over = r.status === OVER_BUDGET;
    for (const e of jobs) if (e.status === OVER_BUDGET) over = true;
    if (over) this.switchOff(owner, "it ran past its time budget (" + String(this.budgetMs) + " ms)");
    else if (r.status !== OK) this.fail(owner + ": " + r.message());
    for (const e of jobs) if (e.status !== OVER_BUDGET) this.fail(owner + ": " + e.message());
    if (this.depth === 0) {
      if (this.reloadAfter) {
        this.reloadAfter = false;
        this.pendingFiles = [];
        this.reload();
      }
      while (this.pendingFiles.length > 0 && this.depth === 0) {
        const file = this.pendingFiles.shift() ?? "";
        this.reloadFile(file, this.readSource(file));
      }
      this.flushToolsChanged();
    }
    trail.leave(at);
    return r;
  }

  /** Stop plugin `owner` and drop what it added, saying why. */
  switchOff(owner: string, why: string): void {
    for (const p of this.table.plugins.slice()) if (p.id === owner) this.retire(p, "the plugin " + owner + " was switched off");
    this.fail("plugin " + owner + " switched off: " + why);
  }

  private fail(text: string): void {
    this.errors.push(text);
    if (this.errors.length > ERRORS_KEPT) this.errors.splice(0, this.errors.length - ERRORS_KEPT);
    this.host.note("plugins: " + text);
    this.host.screen.tell(text);
  }

  /** What a segment draws from, as JSON: the status line input, the folder's name, the message, the spinner, the time. */
  segmentContext(ctx: SegmentContext): string {
    if (ctx.now !== this.ctxNow) {
      this.ctxNow = ctx.now;
      this.ctxJson = objectText(["info", "folderName", "note", "busy", "spinner", "now"], [ctx.info.json(ctx.now), json(ctx.folderName), json(ctx.note), json(ctx.busy), json(ctx.spinner), json(ctx.now)]);
    }
    return this.ctxJson;
  }

  /**
   * Run `command` under `sh -c` with `input` on its stdin, killed past `timeoutMs` (and answered
   * at once: a child it started may hold the output open), its output capped at 64 MB; plugin
   * `owner`'s `fn` gets `[null, { code, out, err, timedOut }]` (or `[message, null]` when it
   * cannot start), unless the plugins were loaded again meanwhile.
   */
  runProcess(owner: string, command: string, input: string, timeoutMs: number, fn: number): void {
    const l = this.life(owner);
    const o = new SpawnOptions();
    o.input = input;
    o.timeoutMs = Math.max(10, timeoutMs);
    o.maxBytes = PROCESS_OUT_MAX;
    o.killSignal = "SIGKILL";
    void spawnCapped("sh", ["-c", command], o).then((run: ProcessRun) => {
      if (!this.alive(l)) return;
      const result = run.error.length > 0 ? "[" + json(run.error) + ",null]" : "[null," + objectText(["code", "out", "err", "timedOut"], [String(run.code), json(run.text), json(run.errOut.toString("utf8")), json(run.timedOut)]) + "]";
      this.invoke(owner, fn, result);
    });
  }

  /** Settle plugin `owner`'s promise `fn` with what `p` gives (JSON text), or its error; not when the plugins were loaded again meanwhile. */
  settle(owner: string, fn: number, p: Promise<string>): void {
    const l = this.life(owner);
    p.then(
      (text: string) => {
        if (this.alive(l)) this.invoke(owner, fn, "[null," + text + "]");
      },
      (err: unknown) => {
        if (this.alive(l)) this.invoke(owner, fn, "[" + json(errorMessage(err, String(err))) + ",null]");
      },
    );
  }

  /** `settle`, answering the call that started the work. */
  settled(owner: string, fn: number, p: Promise<string>): HostAnswer {
    this.settle(owner, fn, p);
    return answer(null);
  }

  /** Call plugin `owner`'s `fn` every `ms` while its instance runs. */
  every(owner: string, ms: number, fn: number): void {
    const l = this.life(owner);
    // Unreferenced: a plugin's timer alone does not keep the program running.
    const tick = (): void => {
      setTimeout(() => {
        if (!this.alive(l)) return;
        this.invoke(owner, fn, "[]");
        tick();
      }, Math.max(10, ms)).unref();
    };
    tick();
  }



  /** A plugin's call into the core. */
  override answer(name: string, argsJson: string): HostAnswer {
    return this.router.answer(name, argsJson);
  }

  /** `widecode.plugin(...)`: the plugin joins the kernel, replacing any of its id; while a file is evaluated again on its own, it waits for that to finish. */
  register(id: string, requires: string[], defaultValue: unknown, activateFn: number, deactivateFn: number, file: string, reg: number): HostAnswer {
    if (id.length === 0) return refuse("a plugin needs an id");
    const p = new JsPlugin(this, id, requires, defaultValue, activateFn, deactivateFn, file.length > 0 ? file : this.file, reg);
    this.table.addDef(p);
    if (this.evaluating.length > 0) {
      this.registered.push(p);
      return answer(null);
    }
    const k = this.host.kernel;
    if (k.has(id)) return refuse("a plugin " + id + " is already running");
    k.remove(id);
    for (const x of this.table.plugins.slice()) if (x.id === id) this.table.removeRunning(x);
    this.table.addRunning(p);
    k.use(p);
    return answer(null);
  }
}
