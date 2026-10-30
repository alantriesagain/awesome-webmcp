// ffi: @light/plugins/native/ffi.json
// widecode's Task tool (the acp plugin): a Claude call with its tool-use id starts an ACP subagent
// on a target's agent and model, its thought and words stream under the call, the call shows as a
// subagent and the Agents tab follows it, and the MCP result is its last words. Cancelling the MCP
// call stops the subagent and marks it stopped.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { AGENT, TEXT, THINKING, TOOL } from "@widecode/conversation/model.ts";
import { Answer, Reply } from "@widecode/conversation/requests.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

const fake = join(process.cwd(), "test/fake-acp.mjs");
const fakeClaude = join(process.cwd(), "test/fake-claude.mjs");

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

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-task-"));
  const log = join(folder, "fake.log");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  const config: unknown = {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake, "--log", log] } },
      tasks: { targets: { deepseek: { agent: "fake", model: "fake/large", description: "a test subagent" } } },
    },
  };
  w.start(config, new NoStateFile(), []);
  await w.host.load();
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);
  const listed = await post('{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("Claude sees the Task tool", listed.includes('"name":"Task"'));

  c.model.openTurn("main", 0, true);
  const call = c.model.block("", "tc", TOOL, "toolu-task", "Task", "");
  ok("the Task call is made", call !== null);
  if (call === null) return;
  call.category = "other";
  const reply = await post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"say hello","prompt":"hello","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-task"}}}');
  ok("the subagent's last words are the result", reply.includes("Hello, world."));
  ok("its thought and words stream under the call", call.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world.")) && call.children.some((i) => i.kind === THINKING));
  eq("the call is a subagent, done", call.category + " " + (call.task !== null ? call.task.status : "none"), AGENT + " done");
  ok("the target's model was chosen", readFileSync(log, "utf8").includes('"configId":"model","value":"fake/large"'));

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const slow = c.model.block("", "tc2", TOOL, "toolu-slow", "Task", "");
  ok("the slow call is made", slow !== null);
  if (slow === null) return;
  const held = post('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"Task","arguments":{"description":"wait","prompt":"slow","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-slow"}}}');
  await until(() => slow.children.length > 0);
  await post('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}');
  await held;
  eq("cancelling stops the subagent", slow.task !== null ? slow.task.status : "none", "stopped");

  // A permission the subagent asks for is under its call, and the answer reaches the agent.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const askCall = c.model.block("", "tc3", TOOL, "toolu-ask", "Task", "");
  ok("the asking call is made", askCall !== null);
  if (askCall === null) return;
  const asking = post('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Task","arguments":{"description":"remove","prompt":"ask","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-ask"}}}');
  ok("the subagent's permission is asked", await until(() => c.model.openRequests().length > 0, 10000));
  const request = c.model.openRequests()[0];
  eq("under the Task call", String(request !== undefined && request.turn === askCall.turn && askCall.children.includes(request)), "true");
  if (request !== undefined) {
    const reply = new Reply("answered");
    const a = new Answer(request.questions[0].question, false);
    a.labels.push("Allow once");
    reply.answers.push(a);
    c.respond(request, reply);
  }
  await asking;
  ok("the allowed call ran", askCall.children.some((i) => i.kind === TOOL && i.result !== null && i.result.text === "removed"));
  eq("and the subagent is done", askCall.task !== null ? askCall.task.status : "none", "done");

  // Claude's own subagent tools step aside when widecode offers Task.
  const folder2 = mkdtempSync(join(tmpdir(), "widecode-task-claude-"));
  const argsFile = join(folder2, "args.txt");
  const ws2 = await openWorkspace(folder2, 100);
  const c2 = new Conversation(ws2.folder);
  const w2 = composeWidecode(ws2, c2);
  w2.start({ acp: { agents: { fake: { name: "Fake", command: ["node", fake] } }, tasks: { replaceClaudeSubagents: true, targets: { deepseek: { agent: "fake", model: "fake/large" } } } } }, new NoStateFile(), []);
  await w2.host.load();
  await until(() => w2.js.mcp.url.length > 0, 5000);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  c2.executable = fakeClaude;
  c2.extraArgs.push("--fixture", join(process.cwd(), "test/fixtures/edit.ndjson"), "--record-args", argsFile);
  c2.send("go", []);
  const disallowed = await until(() => {
    try {
      return readFileSync(argsFile, "utf8").includes("--disallowedTools") && readFileSync(argsFile, "utf8").includes("Task");
    } catch {
      return false;
    }
  }, 10000);
  ok("Claude starts without its own subagent tools", disallowed);
  c2.kill();
  w2.host.kernel.stop();
  w2.js.killProcesses();
  ws2.close();
  rmSync(folder2, { recursive: true, force: true });

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
