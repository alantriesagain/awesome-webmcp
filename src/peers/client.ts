// A session's side of the daemon: the state file says where it listens and with which token; a
// request goes to the control API; `ensure` starts the daemon detached when none answers (the
// sessions plugin's recipe: setsid where there is one, a subshell elsewhere, every stream closed),
// a bounded number of times, and only when given the program to start.
import { spawnCapped, SpawnOptions } from "@lightstart/lib/process.ts";
import { DaemonPaths, DaemonState, daemonAnswers, readDaemonState } from "./daemon.ts";

export class ClientAnswer {
  readonly status: number;
  readonly text: string;

  constructor(status: number, text: string) {
    this.status = status;
    this.text = text;
  }

  get ok(): boolean {
    return this.status === 200;
  }
}

const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/** How long a started daemon gets to answer, and how long before another start is tried. */
export const LAUNCH_POLL_MS = 5000;
export const LAUNCH_WAIT_MS = 30000;
/** How many times one client starts a daemon in its life: past this, something is wrong and it stops trying. */
export const LAUNCHES_MAX = 3;

export class DaemonClient {
  readonly paths: DaemonPaths;
  state: DaemonState | null = null;
  /** How many daemons this client started, and when the last one was. */
  launches = 0;
  launchedMs = 0;
  /** How long `ensure` waits for a started daemon (tests shorten it). */
  pollMs = LAUNCH_POLL_MS;
  /** Hears a line for the log. */
  onLog: ((line: string) => void) | null = null;

  constructor(storeRoot: string) {
    this.paths = new DaemonPaths(storeRoot);
  }

  private note(line: string): void {
    const fn = this.onLog;
    if (fn !== null) fn(line);
  }

  /** Read the state file and ask the daemon it names; false when none answers. */
  async probe(): Promise<boolean> {
    const s = readDaemonState(this.paths);
    this.state = s;
    return s !== null && (await daemonAnswers(s));
  }

  /** The shell line that starts the daemon detached from this process. */
  static launchLine(executable: string, extra: string[]): string {
    const run = [executable, "--peers-daemon", ...extra].map(q).join(" ") + " </dev/null >/dev/null 2>&1";
    return "if command -v setsid >/dev/null 2>&1; then setsid -f " + run + "; else (" + run + " &); fi";
  }

  /**
   * A daemon answering: the one running, or one started now (`executable --peers-daemon`) and waited
   * for. With no `executable` nothing is started. A start is tried at most LAUNCHES_MAX times in this
   * client's life and never twice within LAUNCH_WAIT_MS, so a program that is not widecode (one that
   * ignores the flag) is run a bounded number of times, not once per refresh.
   */
  async ensure(executable: string, extra: string[]): Promise<boolean> {
    if (await this.probe()) return true;
    if (executable.length === 0) return false;
    const now = Date.now();
    if (this.launches >= LAUNCHES_MAX) {
      this.note("peers: the daemon was started " + String(this.launches) + " times and never answered; not trying again");
      return false;
    }
    if (now - this.launchedMs < LAUNCH_WAIT_MS) return false;
    this.launches++;
    this.launchedMs = now;
    const o = new SpawnOptions();
    o.timeoutMs = 5000;
    const run = await spawnCapped("sh", ["-c", DaemonClient.launchLine(executable, extra)], o);
    if (!run.ok) {
      this.note("peers: could not start the daemon: " + (run.error.length > 0 ? run.error : run.err));
      return false;
    }
    const steps = Math.max(1, Math.round(this.pollMs / 200));
    for (let i = 0; i < steps; i++) {
      await wait(200);
      if (await this.probe()) return true;
    }
    this.note("peers: the daemon started from " + executable + " did not answer within " + String(this.pollMs) + " ms");
    return false;
  }

  /** `method` `path` on the control API, with `body` as JSON when given. */
  async request(method: string, path: string, body: unknown | null): Promise<ClientAnswer> {
    const s = this.state;
    if (s === null) return new ClientAnswer(0, "no daemon");
    try {
      const res = await fetch("http://127.0.0.1:" + String(s.localPort) + path, {
        method,
        headers: { authorization: "Bearer " + s.token, "content-type": "application/json" },
        body: body === null ? undefined : JSON.stringify(body),
      });
      return new ClientAnswer(res.status, await res.text());
    } catch (err) {
      return new ClientAnswer(0, err instanceof Error ? err.message : "no answer");
    }
  }
}
