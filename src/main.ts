// ffi: @light/plugins/native/ffi.json
// widecode, a Claude frontend for wide terminals: chat | files | code over one folder. Build and run:
// light-native run widecode. Flags:
//   --dir <path>        the folder (default: where it was launched)
//   --agent <id>        the agent to talk to: claude (default, Claude Code), or one a plugin brings
//   --claude <path>     the CLI (default: `claude` on PATH, then ~/.local/bin/claude)
//   --model <name>      the model for new sessions (default: the models plugin's first, opus[1m]);
//   --effort <level>    the effort
//   --resume <id>       open a session of this folder
//   --open <path>       a file to show at start, relative to the folder
//   --log <path>        the log's file (default: one of this run's own in ~/.widecode/logs, as
//                       config.json's "log" says; stdout is the screen); --no-log for none
//   --version           the build (its version and time), then exit
//   --selftest <name>   a scripted check (selftest.ts); --fake-fixture <file> for the fake CLI,
//   --ephemeral         sessions are not saved (--no-session-persistence)
//   --peers-daemon      run the LAN git bridge's daemon instead of the app (src/peers cli.ts;
//                       --port, --name, --bind), with no terminal; the peers plugin starts it
//   --harness           run widecode's own agent, the harness, speaking ACP on stdio instead of the
//                       app (src/harness cli.ts; the acp plugin starts it); --harness-tools,
//                       --harness-skills, --harness-sessions and --harness-forget are its side commands
// F12 writes the screen's text to the log, and /log says where it is. The log follows the run: its
// start, sessions and turns, every few minutes that it is alive, how it ended (quit, a signal, the
// exit code), and an uncaught error with the trail of what ran last and the screen as it was. A native
// crash (SIGSEGV and friends) writes that trail, a backtrace and its symbolized frames to the log,
// puts the terminal back and names the log on stderr. The terminal's title is the session's, or the
// folder's name while it has none, with "widecode" after it; the title the terminal had comes back on exit.
//
// This file is the entry: flags, the log, signals and the terminal checks. The app's startup pipeline
// is in startup.ts.
import { existsSync, statSync } from "node:fs";
import { errorMessage } from "@light/lib/json.ts";
import { resolve } from "node:path";
import { argValue, hasArg, log, logPath, nameLog, openLog } from "@light/lib/log.ts";
import { Terminal } from "@lightstart/light/native/tui";
import { peersDaemonMain } from "./peers/cli.ts";
import { harnessMain, isHarnessArgs } from "./harness/cli.ts";
import { BUILTIN_PLUGINS } from "./runtime/builtin.ts";
import { Store } from "./services/store.ts";
import { BUILD, StartupHooks, startWidecode } from "./startup.ts";

if (hasArg("--version")) {
  console.log(BUILD);
  process.exit(0);
}

// A daemon shares nothing with the app below: no terminal, no folder, its own log.
if (hasArg("--peers-daemon")) void peersDaemonMain(Store.defaultRoot(), process.argv.slice(2), BUILD).then((code: number) => process.exit(code));
else if (isHarnessArgs(process.argv.slice(2))) void harnessMain(Store.defaultRoot(), process.argv.slice(2), BUILD, BUILTIN_PLUGINS).then((code: number) => process.exit(code));
else runApp();

function runApp(): void {

const logArg = argValue("--log");
nameLog("widecode");
openLog(logArg);
log(BUILD);

/** What the pipeline sets once it runs, for the crash monitor below. */
const hooks = new StartupHooks();
// Natively an error has no stack: the trail of what ran last is what places it. The runtime prints
// the error and exits after this, the exit listeners running (the agent's CLI stopped with it).
process.on("uncaughtExceptionMonitor", (err: Error, origin: string) => {
  log((origin === "unhandledRejection" ? "unhandled rejection: " : "uncaught exception: ") + (err instanceof Error ? err.name + ": " + err.message : String(err)));
  const context = hooks.crashContext;
  if (context !== null)
    try {
      log(context());
    } catch (e) {
      log("the context could not be read: " + errorMessage(e, "error"));
    }
  const leave = hooks.leaveScreen;
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

const selftest = argValue("--selftest") ?? "";
const folder = resolve(argValue("--dir") ?? process.cwd());
const term = new Terminal();
if (!term.isTTY) {
  console.error("widecode: needs an interactive terminal");
  process.exit(2);
}
if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error("widecode: not a folder: " + folder);
  process.exit(2);
}

startWidecode(term, folder, selftest, logArg, hooks).catch((err: unknown) => {
  log("cannot start: " + (errorMessage(err, "error")));
  process.exit(1);
});
}
