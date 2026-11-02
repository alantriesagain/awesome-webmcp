// ffi: @light/plugins/native/ffi.json
// A Task run settles once: an exception while its updates are handled fails the call and reaches
// the parent, a background run finished before its process exits reports only that finish, and a
// session left since its run started stops the run's process.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { TOOL } from "@widecode/conversation/model.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

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

const startedId = (text: string): string => (/subagent started: ([^\s"]+)/.exec(text) ?? [])[1] ?? "";

/** An app whose main agent and subagents are the fake ACP agent; `agentArgs` reach the subagent's process, and `home` gives it a store. */
const open = async (folder: string, log: string, agentArgs: string[], home = "") => {
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  if (home.length > 0) {
    const store = new Store(home);
    store.trust(folder);
    await w.host.useStore(store);
  }
  w.start({ acp: { agents: { main: { name: "Main", command: ["node", fake, "--log", log] }, fake: { name: "Fake", command: ["node", fake, "--log", log, ...agentArgs] } }, tasks: { targets: { deepseek: { agent: "fake" } }, maxConcurrent: 2 } } }, new NoStateFile(), []);
  await w.host.load();
  w.host.session.useAgent("main");
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("acp");
  return { ws, c, w, post: (body: string): Promise<string> => send(url, token, body) };
};

const main = async (): Promise<void> => {
  // An update handler's exception fails the call, and the parent hears the failure.
  const folderA = mkdtempSync(join(tmpdir(), "widecode-task-settle-a-"));
  const logA = join(folderA, "fake.log");
  process.env.WIDECODE_ACP_TEST_CRASH = "update";
  const a = await open(folderA, logA, []);
  await a.w.host.roles.chat.submit("go");
  ok("the main agent runs", await until(() => !a.c.model.running && a.c.model.turns.length > 0, 10000));
  a.c.model.openTurn("main", 0, true);
  const broken = a.c.model.block("", "tcbroken", TOOL, "toolu-broken", "Task", "");
  ok("the broken call is made", broken !== null);
  if (broken === null) return;
  const brokenStarted = await a.post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"breaks","prompt":"broken","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-broken"}}}');
  const brokenId = startedId(brokenStarted);
  ok("the broken run starts in the background", brokenId.length > 0 && brokenStarted.includes("subagent started"));
  a.c.model.closeTurn(null);
  ok("its card fails", await until(() => broken.task !== null && broken.task.status === "failed", 15000));
  ok("the failure names the error", broken.task !== null && broken.task.summary.includes("injected update failure"));
  ok("the parent hears that the background subagent failed", await until(() => a.c.model.turns.some((t) => t.prompt !== null && t.prompt.text.includes("background subagent " + brokenId + " failed")), 15000));
  a.w.host.kernel.stop();
  a.w.js.killProcesses();
  a.ws.close();
  rmSync(folderA, { recursive: true, force: true });
  delete process.env.WIDECODE_ACP_TEST_CRASH;

  // A finished background run whose process exits later reports exactly one result.
  const folderB = mkdtempSync(join(tmpdir(), "widecode-task-settle-b-"));
  const logB = join(folderB, "fake.log");
  const exitLog = join(folderB, "exit.log");
  const b = await open(folderB, logB, ["--exit-log", exitLog]);
  await b.w.host.roles.chat.submit("go");
  ok("the main agent runs for the leaving run", await until(() => !b.c.model.running && b.c.model.turns.length > 0, 10000));
  b.c.model.openTurn("main", 0, true);
  const leaving = b.c.model.block("", "tcleave", TOOL, "toolu-leave", "Task", "");
  ok("the leaving call is made", leaving !== null);
  if (leaving === null) return;
  const leftStarted = await b.post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"leaves","prompt":"leave","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-leave"}}}');
  const leftId = startedId(leftStarted);
  ok("the leaving run starts", leftId.length > 0);
  b.c.model.closeTurn(null);
  ok("it finishes first", await until(() => leaving.task !== null && leaving.task.status === "done", 15000));
  ok("the parent hears it finished", await until(() => b.c.model.turns.some((t) => t.prompt !== null && t.prompt.text.includes("background subagent " + leftId + " finished")), 15000));
  ok("its process exits afterwards", await until(() => existsSync(exitLog), 15000));
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  const heard = b.c.model.turns.filter((t) => t.prompt !== null && t.prompt.text.includes("background subagent " + leftId + " "));
  eq("only one result is reported", String(heard.length), "1");
  ok("and it is the finish", heard[0] !== undefined && heard[0].prompt !== null && heard[0].prompt.text.includes("finished"));
  eq("the card still says done", leaving.task !== null ? leaving.task.status : "none", "done");
  b.w.host.kernel.stop();
  b.w.js.killProcesses();
  b.ws.close();
  rmSync(folderB, { recursive: true, force: true });

  // A run of a session left since it started stops its process.
  const folderC = mkdtempSync(join(tmpdir(), "widecode-task-settle-c-"));
  const homeC = mkdtempSync(join(tmpdir(), "widecode-task-settle-c-home-"));
  const logC = join(folderC, "fake.log");
  const pidFile = join(folderC, "fake.pid");
  writeFileSync(pidFile, "");
  const c3 = await open(folderC, logC, ["--pid-file", pidFile], homeC);
  await c3.w.host.roles.chat.submit("go");
  ok("the main agent runs before the slow run", await until(() => !c3.c.model.running && c3.c.model.turns.length > 0, 10000));
  c3.c.model.openTurn("main", 0, true);
  const slow = c3.c.model.block("", "tcslow", TOOL, "toolu-slow", "Task", "");
  ok("the slow call is made", slow !== null);
  if (slow === null) return;
  const slowStarted = await c3.post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"waits","prompt":"slow","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-slow"}}}');
  ok("the slow run starts", startedId(slowStarted).length > 0);
  c3.c.model.closeTurn(null);
  ok("its process is recorded", await until(() => readFileSync(pidFile, "utf8").trim().length > 0, 10000));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  ok("the slow run's process is alive", alive(pid));
  const taskFile = join(folderC, ".widecode", "tasks", c3.c.model.sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"), "toolu-slow.jsonl");
  c3.c.reset();
  ok("leaving the session stops its run's process", await until(() => !alive(pid), 10000));
  ok("its kept transcript says it stopped because its session was left", existsSync(taskFile) && readFileSync(taskFile, "utf8").includes('"status":"stopped"') && readFileSync(taskFile, "utf8").includes('"summary":"stopped: its session was left"'));
  c3.w.host.kernel.stop();
  c3.w.js.killProcesses();
  c3.ws.close();
  rmSync(folderC, { recursive: true, force: true });
  rmSync(homeC, { recursive: true, force: true });

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
