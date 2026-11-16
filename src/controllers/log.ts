// The run's log and what watches the process, the real app's alone and once a process whatever the
// restarts: the log opened (--log, else a file of the run's own under the store as config.json's
// "log" says, --no-log for none), the uncaught-exception monitor with the trail of what ran last and
// the screen, the signals and the exit, and a native crash's report. The widecode controller sets
// what they read: the crash context, how to put the screen back, what to stop on exit.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errorMessage } from "@lightstart/lib/json.ts";
import { log, logPath, nameLog, openLog, openLogIn, trail } from "@lightstart/lib/log.ts";
import { installCrash, noteCrash } from "@lightstart/lib/crash.ts";
import { Controller } from "@lightstart/light/controller/class.ts";
import app from "../app.ts";
import { BUILD } from "../build.ts";
import type { Config, Store } from "../services/store.ts";
import run from "./run.ts";

export class LogController extends Controller {
  /** The trail's context at an error (the session, the turn, the screen), and how to put the screen back; once mounted. */
  crashContext: (() => string) | null = null;
  leaveScreen: (() => void) | null = null;
  /** What to stop when the process exits (the agent's CLI, the plugins' processes). */
  onExit: (() => void) | null = null;
  private opened = false;
  private storeChecked = false;

  constructor() {
    super("log");
  }

  override connected(): Promise<void> | null {
    if (!run.current.real || this.opened) return null;
    this.opened = true;
    nameLog("widecode");
    openLog(app.args.string("log") ?? null);
    log(BUILD);
    this.watchProcess();
    return null;
  }

  /** The log in the store, once: unless --log named one, config.json's "log" said otherwise or --no-log; then the native crash report. */
  useStore(store: Store | null, config: Config | null): void {
    if (!run.current.real || this.storeChecked) return;
    this.storeChecked = true;
    if (app.args.string("log") === undefined && store !== null && config !== null && config.log.enabled && !app.args.flag("no-log")) {
      const dir = config.log.dir;
      openLogIn(dir.length === 0 ? join(store.root, "logs") : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(store.root, dir), config.log.keep);
      log(BUILD);
    }
    log("pid " + String(process.pid) + " · " + (process.argv.length > 2 ? process.argv.slice(2).join(" ") : "no flags") + " · store " + (store !== null ? store.root : "none"));
    // A native crash reports itself to this log and puts the terminal back; before the TUI saves raw mode.
    installCrash(logPath(), "widecode");
    trail.onChange = (text: string) => noteCrash(text);
  }

  private watchProcess(): void {
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
    // However the program ends (Ctrl+C, a signal, a crash), the CLI and its turn end with it.
    process.on("exit", () => {
      const stop = this.onExit;
      if (stop !== null) stop();
    });
  }
}

export default new LogController();
