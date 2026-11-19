// ffi: @lightstart/plugins/native/ffi.json
// Every end of a Task run stops the ACP agent process it started: the final answer, a failure, the
// timeout and TaskStop, and an idle background run's process goes after its idle time.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL } from "../src/conversation/model.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

const fake = join(process.cwd(), "test/fake-acp.mjs");

const send = (url: string, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const port = Number(url.slice(url.lastIndexOf(":") + 1, url.lastIndexOf("/")));
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token };
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: headers }, (res: IncomingMessage) => {
      const parts: string[] = [];
      res.on("data", (c: Buffer) => parts.push(c.toString("utf8")));
      res.on("end", () => resolve(String(res.statusCode) + " " + parts.join("")));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const main = async (): Promise<void> => {
  process.env.WIDECODE_ACP_TEST_IDLE_MS = "2000";
  const folder = mkdtempSync(join(tmpdir(), "widecode-task-process-"));
  const log = join(folder, "fake.log");
  const pidFile = join(folder, "fake.pid");
  writeFileSync(pidFile, "");
  const config: unknown = {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake, "--log", log, "--pid-file", pidFile] } },
      tasks: { targets: { deepseek: { agent: "fake" } }, maxConcurrent: 2, timeoutMs: 1000 },
    },
  };
  const w = await openWidecode({ folder, plugins: config, load: true });
  const c = w.host.conversation;
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);
  const pid = (): number => Number(readFileSync(pidFile, "utf8").trim());
  const gone = async (): Promise<void> => {
    ok("the run's process is recorded", await until(() => readFileSync(pidFile, "utf8").trim().length > 0, 10000));
    const p = pid();
    ok("the run's process exited when the run ended", await until(() => !alive(p), 10000));
  };
  let n = 0;
  const task = (id: string, description: string, prompt: string, extra: string): Promise<string> => {
    c.model.openTurn("main", 0, true);
    c.model.block("", "tc" + id, TOOL, "toolu-" + id, "Task", "");
    const body = '{"jsonrpc":"2.0","id":' + String(++n) + ',"method":"tools/call","params":{"name":"Task","arguments":{"description":"' + description + '","prompt":"' + prompt + '","subagent_type":"deepseek"' + extra + '},"_meta":{"claudecode/toolUseId":"toolu-' + id + '"}}}';
    return post(body).then((r) => {
      c.model.closeTurn(null);
      return r;
    });
  };

  const answered = await task("answered", "say hello", "hello", "");
  ok("an answered run returns its words", answered.includes("Hello, world."));
  await gone();

  writeFileSync(pidFile, "");
  const failed = await task("failed", "fail", "fail", "");
  ok("a failed run reports the failure", failed.toLowerCase().includes("model unavailable"));
  await gone();

  writeFileSync(pidFile, "");
  const timed = await task("timed", "time out", "slow", "");
  ok("a timed out run reports it", timed.includes("took too long"));
  await gone();

  writeFileSync(pidFile, "");
  const started = await task("stopped", "stop it", "slow", ',"run_in_background":true');
  ok("a background run starts", started.includes("subagent started: toolu-stopped"));
  ok("its process is recorded", await until(() => readFileSync(pidFile, "utf8").trim().length > 0, 10000));
  const stoppedPid = pid();
  ok("its process runs", alive(stoppedPid));
  const stopped = await post('{"jsonrpc":"2.0","id":' + String(++n) + ',"method":"tools/call","params":{"name":"TaskStop","arguments":{"task_id":"toolu-stopped"}}}');
  ok("TaskStop stops the run", stopped.includes("stopped toolu-stopped"));
  ok("and its process exits", await until(() => !alive(stoppedPid), 10000));

  writeFileSync(pidFile, "");
  const idle = await task("idle", "idle later", "hello", ',"run_in_background":true');
  ok("an idle background run starts", idle.includes("subagent started: toolu-idle"));
  ok("its process is recorded", await until(() => readFileSync(pidFile, "utf8").trim().length > 0, 10000));
  const idlePid = pid();
  ok("its process runs while it waits", alive(idlePid));
  ok("its process exits once it idles", await until(() => !alive(idlePid), 10000));

  closeWidecode(w);
  delete process.env.WIDECODE_ACP_TEST_IDLE_MS;
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
