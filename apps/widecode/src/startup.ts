// widecode's startup pipeline: the workspace, the conversation, the store, the plugins, the core
// commands, the terminal app, its log hooks, onboarding, a resume and a selftest. The entry
// (`main.ts`) owns the flags, the log file, the signals and the terminal checks, then calls here.
import { readFileSync } from "node:fs";
import { errorMessage, isRecord } from "@light/lib/json.ts";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { argValue, hasArg, log, openLogIn, trail } from "@light/lib/log.ts";
import { composeWidecode } from "./compose.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { checkSource } from "./api/plugins.ts";
import { AgentChoice, HarnessFile, Onboarding, folderCarries, runOnboarding } from "./views/onboarding.ts";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { FLUSH_AFTER, FLUSH_RENDER, FLUSH_VIEWS, type KeyEvent, Renderer, TInput, Terminal, frames, runApp } from "@lightstart/light/native/tui";
import { Selftest } from "./selftest.ts";
import { Store } from "./services/store.ts";
import { BUILD_TIME, BUILD_VERSION } from "./runtime/build-info.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { registerStoreCommands } from "./commands.ts";
import { flushBeforeExit, QuitFlusher } from "./quit.ts";

/** How long folder events gather before the screen refreshes. */
const CHANGES_MS = 150;

/** The build, as the log, the status bar and --version say it. */
export const BUILD = "widecode " + BUILD_VERSION + " built " + BUILD_TIME;

/** How often the log says the run is alive. */
const ALIVE_MS = 5 * 60 * 1000;

/** What the entry lets the pipeline set for a crash: the session and turn, and how to put the terminal back. */
export class StartupHooks {
  crashContext: (() => string) | null = null;
  leaveScreen: (() => void) | null = null;
}

export const startWidecode = async (term: Terminal, folder: string, selftest: string, logArg: string | null, hooks: StartupHooks): Promise<void> => {
  const workspace = await openWorkspace(folder, CHANGES_MS);
  const conversation = new Conversation(workspace.folder);
  conversation.executable = argValue("--claude") ?? "";
  conversation.effort = argValue("--effort") ?? "";
  const fixture = argValue("--fake-fixture");
  if (fixture !== null) conversation.extraArgs.push("--fixture", resolve(fixture));
  if (hasArg("--ephemeral")) conversation.extraArgs.push("--no-session-persistence");
  // widecode's store, ~/.widecode: none with --ephemeral (tests, live checks), so they leave nothing behind.
  const store = hasArg("--ephemeral") ? null : new Store(Store.defaultRoot());
  // An earlier version kept its data in ~/.ctui: moved over once.
  const migrated = store !== null && (process.env["WIDECODE_HOME"] ?? "").length === 0 ? store.migrateFrom(join(homedir(), ".ctui")) : "";
  // --model names the model of a new session; without it, the models plugin's first.
  conversation.modelName = argValue("--model") ?? "";
  const w = composeWidecode(workspace, conversation);
  const host = w.host;
  const config = store !== null ? store.loadConfig(w.defaults()) : null;
  // The log: a file of this run's own under the store unless --log named one, config.json's "log" said otherwise or --no-log.
  if (logArg === null && store !== null && config !== null && config.log.enabled && !hasArg("--no-log")) {
    const dir = config.log.dir;
    openLogIn(dir.length === 0 ? join(store.root, "logs") : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(store.root, dir), config.log.keep);
    log(BUILD);
  }
  log("pid " + String(process.pid) + " · " + (process.argv.length > 2 ? process.argv.slice(2).join(" ") : "no flags") + " · store " + (store !== null ? store.root : "none"));
  await host.useStore(store);
  host.session.userPermissions = config !== null ? config.permissions : null;
  host.session.titler.executable = conversation.executable;
  // The peers daemon is this binary run again; a selftest runs none.
  host.peersLauncher = selftest.length > 0 ? "" : process.execPath;
  host.onLog = (text: string) => log(text);
  // JS plugins: the user's folder, and the project's own once the user trusts it.
  const projectPlugins = host.harness.pluginsDir();
  if (store !== null) {
    w.js.dirs.push(store.pluginsDir());
    if (store.trusted(folder)) w.js.dirs.push(projectPlugins);
  }
  // The agent: --agent, else config.json's "agent"; one a plugin brings is taken up when it registers.
  host.session.agentId.value = argValue("--agent") ?? (config !== null && config.agent.length > 0 ? config.agent : "claude");
  // The user's key bindings (keys.json), read again on /reload.
  if (store !== null) host.keys.onRead = () => store.readKeys();
  const keysNote = host.keys.applyUser();
  // The keymap: config.json's "keymap" (the one /keymap kept comes before it, read as the app starts).
  if (config !== null && config.keymap.length > 0) host.keys.keymap = config.keymap;
  w.start(config !== null ? config.plugins : null, store !== null ? store.stateFile() : new NoStateFile(), []);
  // --trust: the folder trusted for this run, nothing asked and nothing kept (scripts, selftests).
  // Its harness goes in use now: start loaded the plugins and config while the folder was untrusted.
  if (hasArg("--trust")) {
    const note = w.useHarnessNow();
    if (note.length > 0) host.screen.tell(note);
  }
  const agentNote = host.session.useAgent(host.session.agentId.peek());
  host.screen.clipboard.onWrite = (text: string) => term.write(text);
  host.screen.clipboard.configure(config !== null ? config.clipboard : "auto");
  const columnsNote = w.configureColumns(config !== null ? config.columns : null);
  /** Trust the folder from now on (compose.ts), saying so. */
  const trust = (): void => {
    if (store !== null) host.screen.tell(w.trust());
  };
  registerStoreCommands(w, store, trust);
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
  term.onResize(() => w.shell.resize(term.cols));
  // Every key is the shell's: the composer's editing is among its actions, so light's own editor and focus keys never run (runApp's Ctrl+C never reaches its own fallback).
  const renderer = runApp({ app: w.shell, term, focus: w.chat.pane.input, onKey: (_r: Renderer, e: KeyEvent): boolean => {
    w.shell.handleKey(e);
    return true;
  } });
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
  hooks.crashContext = () => "at the error: " + where() + "\nscreen at the error\n" + renderer.screenText() + "\nend screen";
  hooks.leaveScreen = () => renderer.stop();
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
      if (id.length > 0 && !hasArg("--ephemeral")) {
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
  log("started " + String(term.cols) + "x" + String(term.rows) + " in " + folder + " with " + (agent.owner.length === 0 ? conversation.executable : agent.name() + " (plugin " + agent.owner + ")"));
  await host.load();
  log("tree files=" + String(host.folder.paths().length) + " changed=" + String(host.folder.marks().size));
  const resumeId = argValue("--resume");
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
  if (config !== null && config.notice.length > 0) host.screen.tell(config.notice);
  if (host.kernel.settings.notice.length > 0) host.screen.tell(host.kernel.settings.notice);
  if (columnsNote.length > 0) host.screen.tell(columnsNote);
  if (agentNote.length > 0) host.screen.tell(agentNote);
  if (keysNote.length > 0) {
    log(keysNote);
    host.screen.tell(keysNote);
  }
  /** A harness plugin file as the trust question lists it: the ids it registers, or why it does not load (checked in a context of its own, nothing run). */
  const checkPlugin = (file: string): HarnessFile => {
    const current = host.workspace.folder;
    let code = "";
    try {
      code = readFileSync(file, "utf8");
    } catch (err) {
      return new HarnessFile(file.slice(current.length + 1), [], errorMessage(err, "cannot read"));
    }
    const c = checkSource(w.js, code, file);
    return new HarnessFile(file.slice(current.length + 1), c.ids, c.errors.length > 0 ? c.errors[0] : "");
  };
  /** The questions of the first run with this store and of a folder not yet trusted, one after the other. */
  const onboard = (firstRun: boolean): void => {
    if (store === null || (host.session.trusted.peek() && !firstRun)) return;
    const o = new Onboarding();
    o.firstRun = firstRun;
    o.trusted = host.session.trusted.peek();
    o.carries = host.session.trusted.peek() ? o.carries : folderCarries(host, checkPlugin);
    for (const a of host.session.agents) o.agents.push(new AgentChoice(a.id(), a.name()));
    const models = host.kernel.settings.section("models");
    const list = isRecord(models) ? (models as { list?: unknown }).list : null;
    if (Array.isArray(list) && host.kernel.commands.find("/model") !== null) for (const m of list as unknown[]) if (typeof m === "string" && m.trim().length > 0) o.models.push(m.trim());
    o.onAgent = (id: string) => host.kernel.commands.run("/agent " + id);
    o.onModel = (name: string) => host.kernel.commands.run("/model " + name);
    o.onTrust = trust;
    o.onLookOnly = () => host.screen.tell("looking only: /trust lets " + host.conversation.agent.name() + " work here");
    o.onExit = () => host.quit();
    runOnboarding(host, o);
  };
  // --trust is a run with nothing asked; the first-run questions wait for a normal launch.
  onboard(!hasArg("--trust") && store !== null && store.firstRun);
  // Another folder opened (/open): trusted already, or asked.
  host.folderOpened.add("onboarding", () => onboard(false));
  for (const e of w.js.errors) log("plugins: " + e);
  if (migrated.length > 0) {
    log(migrated);
    host.screen.tell(migrated);
  }
  const open = argValue("--open");
  if (open !== null) host.roles.code.open(open);
  if (selftest.length > 0) {
    const t = new Selftest(selftest, w);
    t.screen = () => renderer.screenText();
    t.start();
  }
};

