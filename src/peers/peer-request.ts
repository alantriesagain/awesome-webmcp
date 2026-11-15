// A request from this machine's daemon to another's, through the curl binary. The runtime's own
// fetch, in a daemon that had been running a while on macOS, failed against a peer that curl, git and
// a fresh process reached at once; git speaks to peers through curl anyway.
import { ProcessRun, SpawnOptions, spawnCapped } from "@lightstart/lib/process.ts";

/** What another machine's daemon answered: the status (0 when nothing did) and the body. */
export class PeerAnswer {
  readonly status: number;
  readonly text: string;
  readonly error: string;

  constructor(status: number, text: string, error: string) {
    this.status = status;
    this.text = text;
    this.error = error;
  }

  get ok(): boolean {
    return this.status === 200;
  }
}

/**
 * A request to another machine's daemon, through the curl binary: the runtime's own fetch, in a
 * daemon that has been running a while on macOS, failed against a peer that curl, git and a fresh
 * process reached at once (the plan's milestone I has the record), and git speaks to peers through
 * curl anyway. One connection per request, `timeoutMs` for the whole of it.
 */
export const peerRequest = async (method: string, url: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<PeerAnswer> => {
  const argv = ["-s", "-S", "-m", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-X", method, "-o", "-", "-w", "\n%{http_code}"];
  for (const name of Object.keys(headers)) argv.push("-H", name + ": " + headers[name]);
  if (body !== null) argv.push("-H", "content-type: application/json", "--data-binary", "@-");
  argv.push(url);
  const o = new SpawnOptions();
  o.timeoutMs = timeoutMs + 2000;
  o.input = body;
  const run: ProcessRun = await spawnCapped("curl", argv, o);
  if (run.error.length > 0) return new PeerAnswer(0, "", run.error);
  const text = run.text;
  const nl = text.lastIndexOf("\n");
  const status = Number(nl >= 0 ? text.slice(nl + 1).trim() : text.trim());
  if (run.code !== 0 || !Number.isInteger(status)) return new PeerAnswer(0, "", run.err.length > 0 ? run.err.split("\n")[0] : "curl exit " + String(run.code));
  return new PeerAnswer(status, nl >= 0 ? text.slice(0, nl) : "", "");
};

