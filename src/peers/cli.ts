// `widecode --peers-daemon [--port <n>] [--name <name>] [--bind <address>] [--no-discovery] [--sync-ms <n>]`: the daemon as a
// process. Its log is a file of its own under the store's logs; SIGTERM and a state file that went
// away (a `/peers stop`, or a daemon that replaced this one) end it; the servers keep it alive.
import { join } from "node:path";
import { log, nameLog, openLogIn } from "@light/lib/log.ts";
import { DEFAULT_PORT, Daemon, DaemonOptions, startDaemon } from "./daemon.ts";

const argValue = (args: string[], name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
};

/** Run the daemon over the store at `storeRoot` with the process's `args`; settles with the exit code when it stops. */
export const peersDaemonMain = (storeRoot: string, args: string[], build: string): Promise<number> =>
  new Promise((resolve) => {
    nameLog("widecode-peers");
    openLogIn(join(storeRoot, "logs"), 5);
    log(build + " peers daemon");
    const o = new DaemonOptions();
    const port = argValue(args, "--port");
    if (port !== null && Number.isInteger(Number(port)) && Number(port) >= 0) o.port = Number(port);
    else o.port = DEFAULT_PORT;
    const name = argValue(args, "--name");
    if (name !== null) o.name = name;
    const bind = argValue(args, "--bind");
    if (bind !== null) o.bind = bind;
    if (args.includes("--no-discovery")) o.discovery = false;
    const syncMs = argValue(args, "--sync-ms");
    if (syncMs !== null && Number.isInteger(Number(syncMs)) && Number(syncMs) >= 0) o.syncMs = Number(syncMs);
    void startDaemon(storeRoot, o, (line: string) => log(line)).then((r: Daemon | string) => {
      if (typeof r === "string") {
        log("not started: " + r);
        console.error("widecode peers: " + r);
        resolve(1);
        return;
      }
      const daemon = r;
      let stopped = false;
      const end = (why: string, code: number): void => {
        if (stopped) return;
        stopped = true;
        log(why);
        clearInterval(watch);
        daemon.stop();
        resolve(code);
      };
      daemon.onStop = () => end("stopped", 0);
      const watch = setInterval(() => {
        if (!daemon.ownsState()) end("the state file went away: stopping", 0);
      }, 5000);
      process.on("SIGTERM", () => end("signal SIGTERM", 0));
      process.on("SIGINT", () => end("signal SIGINT", 0));
      process.on("SIGHUP", () => log("signal SIGHUP ignored: the daemon outlives its terminal"));
    });
  });
