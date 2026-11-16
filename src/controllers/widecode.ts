// widecode composed over the start's folder, after the run, the log and the settings (the
// controllers it imports). A test's run composes the folder, runs its `before` and starts the plugins
// as it says; the real app's takes the store and config.json, the plugins' folders, the agent, the
// keys, the columns and the watching. The host makes the root view next; mounted(renderer) runs what
// follows the first frame: focus, the clipboard, the frame trail, the crash context, load, resume,
// onboarding, --open and a selftest. disconnected() stops what the start opened, so the app starts
// again clean. Round 3 dissolves this into the controllers the plan names.
import { readFileSync } from "node:fs";
import { errorMessage, isRecord } from "@lightstart/lib/json.ts";
import { basename } from "node:path";
import { log, trail } from "@lightstart/lib/log.ts";
import { composeWidecode, Widecode } from "../compose.ts";
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import { checkSource } from "../api/plugins.ts";
import { AgentChoice, HarnessFile, Onboarding, folderCarries, runOnboarding } from "../views/onboarding.ts";
import { FLUSH_AFTER, FLUSH_RENDER, FLUSH_VIEWS, Renderer, TInput, frames } from "@lightstart/light/native/tui";
import { Selftest } from "../selftest.ts";
import type { Config, Store } from "../services/store.ts";
import { Controller } from "@lightstart/light/controller/class.ts";
import { BUILD } from "../build.ts";
import { Command } from "@lightstart/kernel/commands.ts";
import { flushBeforeExit, QuitFlusher } from "../quit.ts";
import app from "../app.ts";
import { Carry, Run } from "../run.ts";
import hostController from "./host.ts";
import logger from "./log.ts";
import run from "./run.ts";
import settings from "./settings.ts";

/** How often the log says the run is alive. */
const ALIVE_MS = 5 * 60 * 1000;

export class WidecodeController extends Controller {
  /** Everything the app's parts hold, made by connected(). */
  w!: Widecode;
  /** What the columns, the agent and the user's keys could not use, told after load. */
  columnsNote = "";
  agentNote = "";
  keysNote = "";
  /** What this start tells once it runs ("" for nothing). */
  private opened = "";
  /** Once a process: what a mount wires to the terminal and the frames. */
  private wired = false;
  /** The session and its turn, as the log says them; the mounted app's. */
  private where: () => string = () => "";
  /** Whether what this start opened was stopped already (a test's closeWidecode, then the app's stop). */
  private closed = true;

  constructor() {
    super("widecode");
  }

  /** This start's store and config.json (none for a test's run). */
  get store(): Store | null {
    return settings.current.store;
  }

  get config(): Config | null {
    return settings.current.config;
  }

  override connected(): Promise<void> | null {
    const current = run.current;
    logger.onExit = () => this.close();
    return current.real ? this.connect(current) : this.connectTest(current);
  }

  override disconnected(): Promise<void> | null {
    this.close();
    return null;
  }

  /** Stop what this start opened: the agent's process, the plugins and their processes, the folder's watch. Once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const w = this.w;
    w.host.conversation.kill();
    w.host.kernel.stop();
    w.js.killProcesses();
    w.host.workspace.close();
    w.js.mcp.close();
  }

  /**
   * Start the app again over `target` (`/open`): the agent chosen, its CLI, the model and the effort
   * carry over; a test's run carries over too, with the folder read once it starts.
   */
  async reopen(target: string): Promise<void> {
    const host = this.w.host;
    const c = host.conversation;
    const carry = new Carry();
    carry.agentId = host.session.agentId.peek();
    carry.executable = c.executable;
    carry.extraArgs = c.extraArgs.slice();
    carry.modelName = c.modelName;
    carry.effort = c.effort;
    carry.notice = "opened " + target;
    await run.reopen(target, carry);
  }

  /** Take over what the start before carried (an `/open`): the conversation's CLI, arguments, model and effort, and the agent chosen. */
  private takeOver(w: Widecode): void {
    const carry = run.takeCarry();
    this.opened = "";
    if (carry === null) return;
    const c = w.host.conversation;
    c.executable = carry.executable;
    c.extraArgs.length = 0;
    for (const a of carry.extraArgs) c.extraArgs.push(a);
    c.modelName = carry.modelName;
    c.effort = carry.effort;
    w.host.session.agentId.value = carry.agentId;
    this.opened = carry.notice;
  }

  /** A test's start: the folder composed, its `before`, the plugins as it says, the folder read if it asks. */
  private async connectTest(current: Run): Promise<void> {
    this.columnsNote = "";
    this.agentNote = "";
    this.keysNote = "";
    const w = composeWidecode(hostController.current);
    this.w = w;
    this.closed = false;
    w.host.onOpen = (target: string) => this.reopen(target);
    const before = current.before;
    if (before !== null) await before(w);
    this.takeOver(w);
    if (current.start) w.start(current.plugins, current.state, current.extra);
    if (current.load) await w.host.load();
    if (this.opened.length > 0) w.host.screen.tell(this.opened);
  }

  private async connect(current: Run): Promise<void> {
    this.columnsNote = "";
    this.agentNote = "";
    this.keysNote = "";
    const selftest = app.args.string("selftest") ?? "";
    const where = current.folder;
    const w = composeWidecode(hostController.current);
    const host = w.host;
    const store = settings.current.store;
    const config = settings.current.config;
    settings.seed(w.defaults());
    this.w = w;
    this.closed = false;
    host.onOpen = (next: string) => this.reopen(next);
    this.takeOver(w);
    await host.useStore(store);
    host.session.userPermissions = config !== null ? config.permissions : null;
    host.session.titler.executable = host.conversation.executable;
    // The peers daemon is this binary run again; a selftest runs none. Desktop alerts are the real
    // app's alone: a test or a selftest must not reach the user's screen.
    host.peersLauncher = selftest.length > 0 ? "" : process.execPath;
    host.real = selftest.length === 0;
    host.onLog = (text: string) => log(text);
    // JS plugins: the user's folder, and the project's own once the user trusts it.
    const projectPlugins = host.harness.pluginsDir();
    if (store !== null) {
      w.js.dirs.push(store.pluginsDir());
      if (store.trusted(where)) w.js.dirs.push(projectPlugins);
    }
    // The agent: --agent, else config.json's "agent"; one a plugin brings is taken up when it registers.
    if (this.opened.length === 0) host.session.agentId.value = app.args.string("agent") ?? (config !== null && config.agent.length > 0 ? config.agent : "claude");
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
    if (store !== null) this.addStoreCommands(store);
    if (store !== null) {
      w.js.watchFolders();
      w.watchHarness();
    }
    // Without a store (--ephemeral) titles would have nowhere to go.
    if (store === null) host.session.titler.allowed = false;
    for (const p of host.kernel.problems) log("plugin " + p);
  }

  /** The commands that need the user's store: the folder's trust, and the agent to talk to kept in config.json. */
  private addStoreCommands(store: Store): void {
    const h = this.w.host;
    const commands = h.kernel.commands;
    commands.add(new Command("/trust", "", "trust this folder: the agent works here and its own harness (.widecode: plugins, prompt, config) runs, now and on every launch", "plugins", (_arg: string) => this.trust()));
    commands.add(
      new Command("/agent", "<id>", "the agent to talk to (claude, or one a plugin brings), kept in config.json", "plugins", (arg: string) => {
        const id = arg.trim();
        if (id.length === 0) {
          h.screen.tell("agent " + h.session.agentId.peek() + " (" + h.session.agents.map((a) => a.id()).join(", ") + "); /agent <id> switches");
          return;
        }
        const error = h.session.useAgent(id);
        if (error.length > 0) {
          h.screen.tell(error);
          return;
        }
        const written = store.setConfigValue("agent", id);
        h.screen.tell(written.length > 0 ? written : "agent " + id + ", kept in config.json");
      }),
    );
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

  /** The renderer the app is mounted on now; a restart mounts another. */
  private renderer: Renderer | null = null;

  /** The screen's text as the renderer drew it last ("" before a mount). */
  screenText(): string {
    const renderer = this.renderer;
    return renderer !== null ? renderer.screenText() : "";
  }

  /** Everything the old pipeline did once runApp answered; the host calls this after runApp. */
  mounted(renderer: Renderer): void {
    this.renderer = renderer;
    const w = this.w;
    const host = w.host;
    const term = renderer.term;
    renderer.setFocus(w.chat.pane.input);
    host.screen.clipboard.onWrite = (text: string) => term.write(text);
    host.screen.onFocusInput = (input: TInput | null) => renderer.setFocus(input);
    // Once a process, whatever the restarts: the terminal's resizes, the frames' phases, the log's pulse.
    if (!this.wired) {
      this.wired = true;
      term.onResize(() => this.w.shell.resize(term.cols));
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
      setInterval(() => log("alive · " + this.where()), ALIVE_MS);
    }
    /** The session and its turn, as the log says them. */
    let turnSince = 0;
    const where = (): string => {
      const c = host.conversation;
      const sid = c.model.sessionId.length > 0 ? c.model.sessionId : c.resumeId;
      return "session " + (sid.length > 0 ? sid : "none") + " · " + c.agent.name() + " · " + (turnSince > 0 ? "turn running for " + String(Math.round((Date.now() - turnSince) / 1000)) + " s" : "idle") + " · " + String(trail.frames) + " frames";
    };
    let loggedSession = "";
    host.session.conversationChanged.add("log", () => {
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
    this.where = where;
    logger.crashContext = () => "\n" + trail.text() + "\nat the error: " + where() + "\nscreen at the error\n" + renderer.screenText() + "\nend screen";
    logger.leaveScreen = () => renderer.stop();
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
    host.session.conversationChanged.add("title", syncTitle);
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
      if (this.opened.length > 0) host.screen.tell(this.opened);
      // --trust is a run with nothing asked; the first-run questions wait for a normal launch.
      this.onboard(!app.args.flag("trust") && this.store !== null && this.store.firstRun);
      for (const e of w.js.errors) log("plugins: " + e);
      if (settings.current.migrated.length > 0) {
        log(settings.current.migrated);
        host.screen.tell(settings.current.migrated);
      }
      const open = app.args.string("open") ?? null;
      if (open !== null) host.roles.code.open(open);
      const selftest = app.args.string("selftest") ?? "";
      if (selftest.length > 0) {
        const t = new Selftest(selftest, w);
        t.screen = () => this.screenText();
        t.current = () => this.w;
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
