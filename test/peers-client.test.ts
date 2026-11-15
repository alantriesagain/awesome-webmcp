// The session's client never runs away: with no program named it only looks for a daemon; given a
// program that ignores the flag (here /bin/false), it starts it once, waits, answers false, and
// refuses to start it again within the wait or past the lifetime cap. The regression this guards:
// the app once started `process.execPath --peers-daemon`, which under the test runner was the test
// itself, running the app again, whose plugin started another, detached, without end.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, LAUNCHES_MAX, LAUNCH_WAIT_MS } from "../src/peers/index.ts";
import { done, eqn, ok } from "@lightstart/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "widecode-peers-client-"));

const main = async (): Promise<void> => {
  const c = new DaemonClient(root);
  const notes: string[] = [];
  c.onLog = (line: string) => {
    notes.push(line);
  };
  c.pollMs = 400;
  ok("no daemon, no program: false", !(await c.ensure("", [])));
  eqn("and nothing started", c.launches, 0);
  const t0 = Date.now();
  ok("a program that ignores the flag: false", !(await c.ensure("/bin/false", [])));
  eqn("started once", c.launches, 1);
  ok("after waiting for it", Date.now() - t0 >= 400 && notes.some((n: string) => n.includes("did not answer")));
  ok("asked again at once: false without a start", !(await c.ensure("/bin/false", [])) && c.launches === 1);
  c.launchedMs = Date.now() - LAUNCH_WAIT_MS - 1;
  ok("past the wait: one more start", !(await c.ensure("/bin/false", [])) && c.launches === 2);
  c.launches = LAUNCHES_MAX;
  c.launchedMs = 0;
  ok("past the lifetime cap: never again", !(await c.ensure("/bin/false", [])) && c.launches === LAUNCHES_MAX && notes.some((n: string) => n.includes("not trying again")));
  ok("no state file appeared", !existsSync(join(root, "peers", "daemon.json")));
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
