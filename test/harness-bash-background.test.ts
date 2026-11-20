// Bash's whole output: every call writes it under the harness store, a long one says where, and
// a session's output folder goes when the session is forgotten. A background command answers at
// once, BashOutput reads it while it runs and after, BashStop ends it with its process group, at
// most eight run together, its end reaches an idle session as a new turn and a running turn as
// steering, and a subagent's background command stops when the subagent ends.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../src/harness/acp/agent.ts";
import { AcpServer, Incoming } from "../src/harness/acp/server.ts";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { LoopListener } from "../src/harness/loop/listener.ts";
import { AgentLoop, LoopSession } from "../src/harness/loop/loop.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { HarnessPaths } from "../src/harness/paths.ts";
import { SessionStore } from "../src/harness/session/store.ts";
import { BashJobs } from "../src/harness/tools/proc.ts";
import { ToolOutcome, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { ToolContext } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

const wait = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(settle, ms));

const IDLE_FIXTURE = [
  '{"match":"startbg","text":"Started.","tools":[{"name":"Bash","input":{"command":"sleep 0.4; echo idle-done","run_in_background":true}}]}',
  '{"match":"result","text":"Waiting for it."}',
  '{"match":"[background","text":"Heard the background command."}',
].join("\n");

const STEER_FIXTURE = [
  '{"match":"bgsteer","text":"Starting.","tools":[{"name":"Bash","input":{"command":"sleep 0.3; echo steer-done","run_in_background":true}}]}',
  '{"match":"result","text":"Working slowly.","chunks":20,"delayMs":100}',
  '{"match":"[background","text":"Heard it while working."}',
].join("\n");

const SUBAGENT_FIXTURE = [
  '{"match":"subbg","text":"Delegating.","tools":[{"name":"Task","input":{"description":"Start it","prompt":"subtask run it"}}]}',
  '{"match":"subtask","text":"Starting it.","tools":[{"name":"Bash","input":{"command":"sleep 1; echo late > late.txt","run_in_background":true}}]}',
  '{"match":"result","text":"Started it."}',
  '{"match":"result","text":"The subagent started it."}',
].join("\n");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-bg-"));
  const paths = new HarnessPaths(join(folder, "store"));
  const tools = new ToolSet(builtInTools());
  const abort = new Abort();
  const jobs = new BashJobs();
  const ctx = new ToolContext(folder, "build", new Set<string>());
  ctx.outputDir = paths.outputDir("h-test");
  ctx.jobs = jobs;
  ctx.callId = "call_1";
  const run = async (name: string, input: unknown): Promise<ToolOutcome> => tools.run(name, JSON.stringify(input), ctx, abort, null);

  const long = await run("Bash", { command: "for i in $(seq 1 4000); do echo line-$i; done" });
  const longPath = join(ctx.outputDir, "call_1.log");
  ok("a long output's result names the file with all of it", long.text.includes("the whole output is in " + longPath) && existsSync(longPath));
  const whole = readFileSync(longPath, "utf8");
  ok("the file holds what the inline result left out", whole.includes("line-1\n") && whole.includes("line-2500\n") && whole.includes("line-4000\n") && !long.text.includes("line-2500"));

  const started = await run("Bash", { command: "sleep 0.4; echo background-done", run_in_background: true });
  ok("a background command answers at once with its id and file", started.text.includes("bash-1") && started.text.includes(join(ctx.outputDir, "bash-1.log")));
  const first = await run("BashOutput", { id: "bash-1" });
  ok("BashOutput while it runs", first.text.includes("bash-1 is running"));
  await wait(800);
  const after = await run("BashOutput", { id: "bash-1" });
  ok("BashOutput after it ends: the exit code and the output", after.text.includes("bash-1 exited 0") && after.text.includes("background-done") && readFileSync(join(ctx.outputDir, "bash-1.log"), "utf8").includes("background-done"));
  const tailed = await run("BashOutput", { id: "bash-1", tail: 1 });
  ok("a tail reads the last line", tailed.text.includes("\nbackground-done\nFile: "));

  const stopping = await run("Bash", { command: "sleep 5; echo late", run_in_background: true });
  const stopId = /bash-\d+/.exec(stopping.text)?.[0] ?? "";
  const stopped = await run("BashStop", { id: stopId });
  ok("BashStop ends it", stopped.text === "Stopped " + stopId + ".");
  await until(() => {
    const job = jobs.find(stopId);
    return job !== null && !job.isRunning();
  });
  const stopRead = await run("BashOutput", { id: stopId });
  ok("and BashOutput says it was stopped", stopRead.text.includes(stopId + " was stopped"));
  eq("an unknown background command is refused", (await run("BashStop", { id: "bash-99" })).text, "no background command named bash-99");

  const capped: string[] = [];
  for (let i = 0; i < 8; i++) {
    const one = await run("Bash", { command: "sleep 5", run_in_background: true });
    capped.push(/bash-\d+/.exec(one.text)?.[0] ?? "");
  }
  const ninth = await run("Bash", { command: "sleep 5", run_in_background: true });
  ok("a ninth background command is refused at the cap of eight", ninth.isError && ninth.text.includes("8 background commands running"));
  jobs.stopAll();

  const sid = "h-forget";
  const store = new SessionStore(paths.sessionsDir(folder));
  mkdirSync(paths.sessionsDir(folder), { recursive: true });
  writeFileSync(store.pathOf(sid), "");
  mkdirSync(paths.outputDir(sid), { recursive: true });
  writeFileSync(join(paths.outputDir(sid), "bash-1.log"), "x");
  ok("forgetting a session removes its output folder", store.remove(sid) && !existsSync(paths.outputDir(sid)) && !existsSync(store.pathOf(sid)));

  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const served = (fixture: string): { agent: AcpAgent; out: string[]; send: (method: string, params: unknown) => string } => {
    const server = new AcpServer();
    const out: string[] = [];
    server.sink = (line: string) => out.push(line);
    const agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(fixture)), new ToolSet(builtInTools()), registry, config, "test", "linux", paths);
    let n = 0;
    const send = (method: string, params: unknown): string => {
      const id = String(++n);
      agent.receive(new Incoming(method, params, id));
      return id;
    };
    return { agent, out, send };
  };

  // An idle session hears a finished background command as a new turn.
  const idle = served(IDLE_FIXTURE);
  idle.send("session/new", { cwd: folder, mcpServers: [] });
  const idleSid = /"sessionId":"([^"]+)"/.exec(idle.out[0])?.[1] ?? "";
  idle.send("session/prompt", { sessionId: idleSid, prompt: [{ type: "text", text: "startbg now" }] });
  await until(() => idle.agent.messagesOf(idleSid).some((m) => m.role === "assistant" && m.text().includes("Heard the background command.")));
  const idleMessages = idle.agent.messagesOf(idleSid);
  const heard = idleMessages.find((m) => m.role === "user" && m.text().startsWith("[background command bash-1 exited 0]"));
  ok("the end arrives as a user message with the command, output and file", heard !== undefined && heard.text().includes("sleep 0.4; echo idle-done") && heard.text().includes("idle-done") && heard.text().includes("File: " + paths.outputDir(idleSid) + "/bash-1.log"));
  ok("and starts a turn answered by the model", idleMessages.some((m) => m.role === "assistant" && m.text().includes("Heard the background command.")));

  // A running turn hears it as steering.
  const live = served(STEER_FIXTURE);
  live.send("session/new", { cwd: folder, mcpServers: [] });
  const liveSid = /"sessionId":"([^"]+)"/.exec(live.out[0])?.[1] ?? "";
  const livePrompt = live.send("session/prompt", { sessionId: liveSid, prompt: [{ type: "text", text: "bgsteer now" }] });
  await until(() => live.out.some((l) => l.includes('"id":' + livePrompt + ',"result"')));
  const liveMessages = live.agent.messagesOf(liveSid);
  ok("a running turn hears the end as a steering message", liveMessages.some((m) => m.role === "user" && m.text().startsWith("[background command bash-1 exited 0]")));
  ok("the same turn goes on with it", liveMessages.some((m) => m.role === "assistant" && m.text().includes("Heard it while working.")));
  eq("the prompt is answered once, at the turn's end", String(live.out.filter((l) => l.includes('"id":' + livePrompt + ',"result"')).length), "1");

  // A subagent's background command stops with the subagent.
  const loop = new AgentLoop(new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(SUBAGENT_FIXTURE)), new ToolSet(builtInTools()));
  const s = new LoopSession();
  s.model = "fake/fake";
  s.cwd = folder;
  s.system = ["Be brief."];
  s.outputDir = paths.outputDir("h-sub");
  const ends: string[] = [];
  const listener = new LoopListener();
  listener.onToolEnd = (id: string, o: ToolOutcome) => ends.push(id + " " + o.text);
  await loop.run(s, "subbg it", listener, new Abort());
  eq("the subagent's report reaches the parent", ends.join(" | "), "call_1 Started it.");
  await wait(1500);
  ok("its background command was stopped when it ended", !existsSync(join(folder, "late.txt")) && !existsSync(join(paths.outputDir("h-sub") + "-task1")));

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
