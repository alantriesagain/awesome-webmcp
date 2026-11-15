// The sidecar's process: a CLI that does not exist is an error and one exit, not a run that
// stays alive; a real process's lines reach the caller and its exit is said once.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOptions, ClaudeAgent, ExitEvent } from "../src/agent/index.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const main = async (): Promise<void> => {
  const missing = new ClaudeAgent();
  const kinds: string[] = [];
  missing.onEvent = (e) => kinds.push(e.kind);
  const o = new AgentOptions();
  o.executable = join(tmpdir(), "widecode-no-such-claude");
  missing.start(o);
  for (let i = 0; i < 100 && missing.running; i++) await wait(20);
  ok("a missing CLI is not running", !missing.running);
  eq("one error and one exit", kinds.filter((k) => k === "error").length + "/" + kinds.filter((k) => k === "exit").length, "1/1");

  const dir = mkdtempSync(join(tmpdir(), "widecode-agent-process-"));
  try {
    const script = join(dir, "say.sh");
    writeFileSync(script, "#!/bin/sh\nprintf 'one\\ntwo\\n'\n");
    chmodSync(script, 0o755);
    const run = new ClaudeAgent();
    const lines: string[] = [];
    let exit = -2;
    run.onLine = (line) => lines.push(line);
    run.onEvent = (e) => {
      if (e instanceof ExitEvent) exit = e.code;
    };
    const args = new AgentOptions();
    args.executable = script;
    run.start(args);
    for (let i = 0; i < 100 && run.running; i++) await wait(20);
    eq("the process's lines", lines.join("|"), "one|two");
    eq("its exit once", String(exit), "0");

    const sleeper = join(dir, "sleep.sh");
    writeFileSync(sleeper, "#!/bin/sh\nexec sleep 10\n");
    chmodSync(sleeper, 0o755);
    const stopping = new ClaudeAgent();
    let stopped = -2;
    stopping.onEvent = (e) => {
      if (e instanceof ExitEvent) stopped = e.code;
    };
    const stopArgs = new AgentOptions();
    stopArgs.executable = sleeper;
    stopping.start(stopArgs);
    for (let i = 0; i < 100 && !stopping.running; i++) await wait(20);
    await wait(100);
    stopping.stop(10);
    for (let i = 0; i < 100 && stopping.running; i++) await wait(20);
    ok("stop ends the process", !stopping.running && stopped !== -2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
