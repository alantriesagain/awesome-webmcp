// A session's side of the daemon: the state file says where it listens and with which token; a
// request goes to the control API; `ensure` starts the daemon detached when none answers (the
// sessions plugin's recipe: setsid where there is one, a subshell elsewhere, every stream closed).
import { spawnCapped, SpawnOptions } from "@light/lib/process.ts";
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

export class DaemonClient {
  readonly paths: DaemonPaths;
  state: DaemonState | null = null;

  constructor(storeRoot: string) {
    this.paths = new DaemonPaths(storeRoot);
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

  /** A daemon answering: the one running, or one started now (`executable --peers-daemon`), waited for up to five seconds. */
  async ensure(executable: string, extra: string[]): Promise<boolean> {
    if (await this.probe()) return true;
    const o = new SpawnOptions();
    o.timeoutMs = 5000;
    const run = await spawnCapped("sh", ["-c", DaemonClient.launchLine(executable, extra)], o);
    if (!run.ok) return false;
    for (let i = 0; i < 25; i++) {
      await wait(200);
      if (await this.probe()) return true;
    }
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
