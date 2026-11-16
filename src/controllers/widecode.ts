// widecode's one transitional controller, standing in for main.ts and startup.ts. Its connected()
// runs everything the entry did before the terminal: the log, the signals and the crash monitor,
// the folder check, then the workspace, the conversation, the store, the config, the plugins, the
// keys, the columns and the watching. The host makes the root view next; its mounted(renderer) runs
// what the old pipeline did from runApp on: focus, the clipboard, resizes, the frame trail, the
// crash hooks, load, resume, onboarding, --open and a selftest. Round 3 dissolves this into the
// controllers the plan names.
import { existsSync, readFileSync, statSync } from "node:fs";
import { errorMessage, isRecord } from "@lightstart/lib/json.ts";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { log, logPath, nameLog, openLog, openLogIn, trail } from "@lightstart/lib/log.ts";
import { installCrash, noteCrash } from "@lightstart/lib/crash.ts";
import { composeWidecode, Widecode } from "../compose.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { checkSource } from "../api/plugins.ts";
import { AgentChoice, HarnessFile, Onboarding, folderCarries, runOnboarding } from "../views/onboarding.ts";
import { Conversation } from "../conversation/conversation.ts";
import { FLUSH_AFTER, FLUSH_RENDER, FLUSH_VIEWS, Renderer, TInput, frames } from "@lightstart/light/native/tui";
import { Selftest } from "../selftest.ts";
import { Config, Store } from "../services/store.ts";
import { Controller } from "@lightstart/light/controller/class.ts";
import { BUILD } from "../build.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { registerStoreCommands } from "../commands.ts";
import { flushBeforeExit, QuitFlusher } from "../quit.ts";
import app from "../app.ts";

/** How long folder events gather before the screen refreshes. */
const CHANGES_MS = 150;

/** How often the log says the run is alive. */
const ALIVE_MS = 5 * 60 * 1000;

export class WidecodeController extends Controller {
  /** Everything the app's parts hold, made by connected(). */
  w!: Widecode;
  store: Store | null = null;
  config: Config | null = null;
  /** Why an earlier ~/.ctui was not moved, or what was moved ("" for neither). */
  migrated = "";
  /** What the columns, the agent and the user's keys could not use, told after load. */
  columnsNote = "";
  agentNote = "";
  keysNote = "";
  /** The crash trail's context and how to put the screen back, once mounted. */
  crashContext: (() => string) | null = null;
  leaveScreen: (() => void) | null = null;

  constructor() {
    super("widecode");
  }

  override connected(): Promise<void> | null {
    return this.connect();
  }

  private async connect(): Promise<void> {
    const logArg = app.args.string("log") ?? null;
    nameLog("widecode");
    openLog(logArg);
    log(BUILD);

    // Natively an error has no stack: the trail of what ran last is what places it. The runtime
    // prints the error and exits after this, the exit listeners running (the agent's CLI stopped).
    process.on("uncaughtExceptionMonitor", (err: Error, origin: string) => {
      log((origin === "unhandledRejection" ? "unhandled rejection: " : "uncaught exception: ") + (err instanceof Error ? err.name + ": " + err.message : String(err)));
      const context = this.crashContext;
      if (context !== null)
        try {
          log(context());
        } catch (e) {
          log("the context could not be read: " + errorMessage(e, "error"));
        }
      const leave = this.leaveScreen;
      if (leave !== null) leave();
      const p = logPath();
      process.stderr.write("widecode stopped on an error" + (p.length > 0 ? "; its log: " + p : "") + "\n");
    });
    process.on("exit", (code: number) => log("exit, code " + String(code)));
    // The terminal closed: an exit, so its listeners stop the agent's CLI (the default would skip them).
    process.on("SIGHUP", () => {
      log("signal SIGHUP: the terminal went away");
      process.exit(129);
    });
    process.on("SIGTERM", () => log("signal SIGTERM"));

    const selftest = app.args.string("selftest") ?? "";
    const folder = resolve(app.args.string("dir") ?? process.cwd());
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      console.error("widecode: not a folder: " + folder);
      process.exit(2);
    }

    const workspace = await openWorkspace(folder, CHANGES_MS);
    const conversation = new Conversation(workspace.folder);
    conversation.executable = app.args.string("claude") ?? "";
    conversation.effort = app.args.string("effort") ?? "";
    const fixture = app.args.string("fake-fixture");
    if (fixture !== undefined) conversation.extraArgs.push("--fixture", resolve(fixture));
    if (app.args.flag("ephemeral")) conversation.extraArgs.push("--no-session-persistence");
    // widecode's store, ~/.widecode: none with --ephemeral (tests, live checks), so they leave nothing behind.
    const store = app.args.flag("ephemeral") ? null : new Store(Store.defaultRoot());
    // An earlier version kept its data in ~/.ctui: moved over once.
    this.migrated = store !== null && (process.env["WIDECODE_HOME"] ?? "").length === 0 ? store.migrateFrom(join(homedir(), ".ctui")) : "";
    // --model names the model of a new session; without it, the models plugin's first.
    conversation.modelName = app.args.string("model") ?? "";
    const w = composeWidecode(workspace, conversation);
    const host = w.host;
    const config = store !== null ? store.loadConfig(w.defaults()) : null;
    this.store = store;
    this.config = config;
    this.w = w;
    // The log: a file of this run's own under the store unless --log named one, config.json's "log" said otherwise or --no-log.
    if (logArg === null && store !== null && config !== null && config.log.enabled && !app.args.flag("no-log")) {
      const dir = config.log.dir;
      openLogIn(dir.length === 0 ? join(store.root, "logs") : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(store.root, dir), config.log.keep);
      log(BUILD);
    }
    log("pid " + String(process.pid) + " · " + (process.argv.length > 2 ? process.argv.slice(2).join(" ") : "no flags") + " · store " + (store !== null ? store.root : "none"));
    // A native crash reports itself to this log and puts the terminal back; before the TUI saves raw mode.
    installCrash(logPath(), "widecode");
    trail.onChange = (text: string) => noteCrash(text);
    await host.useStore(store);
    host.session.userPermissions = config !== null ? config.permissions : null;
    host.session.titler.executable = conversation.executable;
    // The peers daemon is this binary run again; a selftest runs none. Desktop alerts are the real
    // app's alone: a test or a selftest must not reach the user's screen.
    host.peersLauncher = selftest.length > 0 ? "" : process.execPath;
    host.real = selftest.length === 0;
    host.onLog = (text: string) => log(text);
    // JS plugins: the user's folder, and the project's own once the user trusts it.
    const projectPlugins = host.harness.pluginsDir();
    if (store !== null) {
      w.js.dirs.push(store.pluginsDir());
      if (store.trusted(folder)) w.js.dirs.push(projectPlugins);
    }
    // The agent: --agent, else config.json's "agent"; one a plugin brings is taken up when it registers.
    host.session.agentId.value = app.args.string("agent") ?? (config !== null && config.agent.length > 0 ? config.agent : "claude");
    // The user's key bindings (keys.json), read again on /reload.
    if (store !== null) host.keys.onRead = () => store.readKeys();
    this.keysNote = host.keys.applyUser();
    // The keymap: config.json's "keymap" (the one /keymap kept comes before it, read as the app starts).
    if (config !== null && config.keymap.length > 0) host.keys.keymap = config.keymap;
    w.start(config !== null ? config.plugins : null, store !== null ? store.stateFile() : new NoStateFile(), []);
    // --trust: the folder trusted for this run, nothing asked and nothing kept (scripts, selftests).
    // Its harness goes in use now: start loaded the plugins and config while the folder was untrusted.
    if (app.args.flag("trust")) {
      const note = w.useHarnessNow();
      if (note.length > 0) host.screen.tell(note);
    }
    this.agentNote = host.session.useAgent(host.session.agentId.peek());
    host.screen.clipboard.configure(config !== null ? config.clipboard : "auto");
    this.columnsNote = w.configureColumns(config !== null ? config.columns : null);
    registerStoreCommands(w, store, () => this.trust());
    if (store !== null) {
      w.js.watchFolders();
      w.watchHarness();
    }
    // Without a store (--ephemeral) titles would have nowhere to go.
    if (store === null) host.session.titler.allowed = false;
    for (const p of host.kernel.problems) log("plugin " + p);
    // However the program ends (Ctrl+C, a signal, a crash), the CLI and its turn end with it.
    process.on("exit", () => {
      host.conversation.kill();
      w.js.killProcesses();
      w.js.mcp.close();
    });
  }

  /** Trust the folder from now on (compose.ts), saying so. */
  private trust(): void {
    if (this.store !== null) this.w.host.screen.tell(this.w.trust());
  }

  /** A harness plugin file as the trust question lists it: the ids it registers, or why it does not load (checked in a context of its own, nothing run). */
  private checkPlugin(file: string): HarnessFile {
    const w = this.w;
    const current = w.host.workspace.folder;
    let code = "";
    try {
      code = readFileSync(file, "utf8");
    } catch (err) {
      return new HarnessFile(file.slice(current.length + 1), [], errorMessage(err, "cannot read"));
    }
    const c = checkSource(w.js, code, file);
    return new HarnessFile(file.slice(current.length + 1), c.ids, c.errors.length > 0 ? c.errors[0] : "");
  }

  /** The questions of the first run with this store and of a folder not yet trusted, one after the other. */
  private onboard(firstRun: boolean): void {
    const w = this.w;
    const host = w.host;
    const store = this.store;
    if (store === null || (host.session.trusted.peek() && !firstRun)) return;
    const o = new Onboarding();
    o.firstRun = firstRun;
    o.trusted = host.session.trusted.peek();
    o.carries = host.session.trusted.peek() ? o.carries : folderCarries(host, (file: string) => this.checkPlugin(file));
    for (const a of host.session.agents) o.agents.push(new AgentChoice(a.id(), a.name()));
    const models = host.kernel.settings.section("models");
    const list = isRecord(models) ? (models as { list?: unknown }).list : null;
    if (Array.isArray(list) && host.kernel.commands.find("/model") !== null) for (const m of list as unknown[]) if (typeof m === "string" && m.trim().length > 0) o.models.push(m.trim());
    o.onAgent = (id: string) => host.kernel.commands.run("/agent " + id);
    o.onModel = (name: string) => host.kernel.commands.run("/model " + name);
    o.onTrust = () => this.trust();
    o.onLookOnly = () => host.screen.tell("looking only: /trust lets " + host.conversation.agent.name() + " work here");
    o.onExit = () => host.quit();
    runOnboarding(host, o);
  }

  /** Everything the old pipeline did once runApp answered; the host calls this after runApp. */
  mounted(renderer: Renderer): void {
    const w = this.w;
    const host = w.host;
    const term = renderer.term;
    renderer.setFocus(w.chat.pane.input);
    host.screen.clipboard.onWrite = (text: string) => term.write(text);
    term.onResize(() => w.shell.resize(term.cols));
    host.screen.onFocusInput = (input: TInput | null) => renderer.setFocus(input);
    // A frame's phases on the trail: the views' update, then the layout and paint.
    let frameAt = 0;
    frames.onFlush(() => {
      trail.reset();
      trail.frames++;
      frameAt = trail.within("frame", "views");
    }, FLUSH_VIEWS - 1);
    frames.onFlush(() => {
      trail.leave(frameAt);
      frameAt = trail.within("frame", "paint");
    }, FLUSH_RENDER - 1);
    frames.onFlush(() => trail.leave(frameAt), FLUSH_AFTER + 1);
    /** The session and its turn, as the log says them. */
    let turnSince = 0;
    const where = (): string => {
      const c = host.conversation;
      const sid = c.model.sessionId.length > 0 ? c.model.sessionId : c.resumeId;
      return "session " + (sid.length > 0 ? sid : "none") + " · " + c.agent.name() + " · " + (turnSince > 0 ? "turn running for " + String(Math.round((Date.now() - turnSince) / 1000)) + " s" : "idle") + " · " + String(trail.frames) + " frames";
    };
    let loggedSession = "";
    host.conversationChanged.add("log", () => {
      const c = host.conversation;
      const sid = c.model.sessionId;
      if (sid.length > 0 && sid !== loggedSession) {
        loggedSession = sid;
        log("session " + sid + " · " + c.agent.name());
      }
      if (c.model.running && turnSince === 0) {
        turnSince = Date.now();
        log("turn started");
      } else if (!c.model.running && turnSince > 0) {
        log("turn ended after " + String(Math.round((Date.now() - turnSince) / 1000)) + " s");
        turnSince = 0;
      }
    });
    setInterval(() => log("alive · " + where()), ALIVE_MS);
    this.crashContext = () => "\n" + trail.text() + "\nat the error: " + where() + "\nscreen at the error\n" + renderer.screenText() + "\nend screen";
    this.leaveScreen = () => renderer.stop();
    host.screen.onScreen = (columns: string[]) => w.screenText(renderer.back, columns);
    let quitting = false;
    host.onQuit = () => {
      if (quitting) return;
      quitting = true;
      log("quit · " + where());
      renderer.stop();
      host.kernel.stop();
      host.workspace.close();
      w.js.stopWatching();
      host.session.harness.stopWatching();
      // Back on the normal screen: how to come back to this conversation (sessions are Claude
      // Code's own files, so `claude --resume` opens it too). The session records are flushed first.
      const finish = (): void => {
        const id = host.conversation.model.sessionId.length > 0 ? host.conversation.model.sessionId : host.conversation.resumeId;
        if (id.length > 0 && !app.args.flag("ephemeral")) {
          const title = host.conversation.title.length > 0 ? " (" + host.conversation.title + ")" : "";
          console.log("To come back to this session" + title + ":\n " + basename(process.execPath) + " --resume " + id);
        }
        w.js.mcp.close();
        process.exit(0);
      };
      const records = host.session.records;
      flushBeforeExit(records !== null ? new QuitFlusher(() => records.settled()) : null, finish);
    };
    let dumps = 0;
    host.onDump = () => {
      dumps++;
      log("screen " + String(dumps) + " frame " + renderer.lastFrameMs.toFixed(1) + " ms\n" + renderer.screenText() + "\nend screen " + String(dumps));
    };
    // The terminal's size is read when the renderer starts; before that it answers a default.
    w.shell.resize(term.cols);
    // The terminal's title: the session's, or the folder's name while it has none.
    let title = "";
    const syncTitle = (): void => {
      const t = (host.conversation.title.length > 0 ? host.conversation.title : host.folder.folderName()) + " · widecode";
      if (t === title) return;
      title = t;
      term.title(t);
    };
    host.conversationChanged.add("title", syncTitle);
    host.folderOpened.add("title", syncTitle);
    syncTitle();
    const agent = host.conversation.agent;
    log("started " + String(term.cols) + "x" + String(term.rows) + " in " + host.workspace.folder + " with " + (agent.owner.length === 0 ? w.host.conversation.executable : agent.name() + " (plugin " + agent.owner + ")"));

    const run = async (): Promise<void> => {
      await host.load();
      log("tree files=" + String(host.folder.paths().length) + " changed=" + String(host.folder.marks().size));
      const resumeId = app.args.string("resume") ?? null;
      if (resumeId !== null) {
        // As the Sessions tab resumes one: through the agent its record names, with the title kept for it, and Claude asked for one when it has none.
        const why = host.session.resumeSession(resumeId, "");
        if (why.length > 0) {
          log("resume " + resumeId + ": " + why);
          host.screen.tell(why);
        }
        const kept = host.conversation.title;
        if (why.length === 0 && kept.length === 0) {
          const first = host.conversation.firstExchange();
          if (first.prompt.length > 0 && host.conversation.agent.id() === "claude") host.session.titler.request(resumeId, first.prompt, first.reply, false);
        }
      } else if (host.session.trusted.peek()) host.conversation.prepare();
      host.screen.tell(BUILD);
      if (this.config !== null && this.config.notice.length > 0) host.screen.tell(this.config.notice);
      if (host.kernel.settings.notice.length > 0) host.screen.tell(host.kernel.settings.notice);
      if (this.columnsNote.length > 0) host.screen.tell(this.columnsNote);
      if (this.agentNote.length > 0) host.screen.tell(this.agentNote);
      if (this.keysNote.length > 0) {
        log(this.keysNote);
        host.screen.tell(this.keysNote);
      }
      // --trust is a run with nothing asked; the first-run questions wait for a normal launch.
      this.onboard(!app.args.flag("trust") && this.store !== null && this.store.firstRun);
      // Another folder opened (/open): trusted already, or asked.
      host.folderOpened.add("onboarding", () => this.onboard(false));
      for (const e of w.js.errors) log("plugins: " + e);
      if (this.migrated.length > 0) {
        log(this.migrated);
        host.screen.tell(this.migrated);
      }
      const open = app.args.string("open") ?? null;
      if (open !== null) host.roles.code.open(open);
      const selftest = app.args.string("selftest") ?? "";
      if (selftest.length > 0) {
        const t = new Selftest(selftest, w);
        t.screen = () => renderer.screenText();
        t.start();
      }
    };
    run().catch((err: unknown) => {
      log("cannot start: " + errorMessage(err, "error"));
      process.exit(1);
    });
  }
}

export default new WidecodeController();
