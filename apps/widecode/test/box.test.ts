// ffi: @light/plugins/native/ffi.json
// Host actions (the box plugin): commands a project configures for agents to ask the host to run.
// HostAction is offered only while one is configured, its call opens the question under the call
// with the command and the agent's reason, "Run it" runs it in the session's folder and answers its
// exit code and output, "Don't run" answers an error and runs nothing, an unknown action is
// refused, and /box lists the actions. A plugin switched off or a section with no actions offers no
// tool.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { TOOL } from "@widecode/conversation/model.ts";
import { Answer, Reply } from "@widecode/conversation/requests.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

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

const callBody = (id: number, arguments_: unknown, toolUseId: string): string => {
  const meta: unknown = toolUseId.length > 0 ? { "claudecode/toolUseId": toolUseId } : {};
  const params: unknown = { name: "HostAction", arguments: arguments_, _meta: meta };
  return JSON.stringify({ jsonrpc: "2.0", id: id, method: "tools/call", params: params });
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-box-"));
  const marker = join(folder, "marker.txt");
  const run = "printf 'hello\\n' > marker.txt; echo done; echo err >&2";
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const w = composeWidecode(ws, c);
  w.start({ box: { hostActions: { install: { run: run, description: "install the build", timeoutMs: 5000 } } } }, new NoStateFile(), []);
  await w.host.load();
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);

  const listed = await post('{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("the tool is listed with its configured action", listed.includes('"name":"HostAction"') && listed.includes('"enum":["install"]') && listed.includes("install the build"));

  c.model.openTurn("main", 0, true);
  const call = c.model.block("", "tc", TOOL, "toolu-box", "HostAction", "");
  ok("the HostAction call is made", call !== null);
  if (call === null) return;
  const pending = post(callBody(1, { action: "install", reason: "the build is ready" }, "toolu-box"));
  ok("a call opens the question", await until(() => c.model.openRequests().length > 0, 5000));
  const asked = c.model.openRequests()[0];
  eq("under the call", String(asked !== undefined && asked.turn === call.turn && call.children.includes(asked)), "true");
  const question = asked !== undefined ? asked.questions[0] : null;
  eq("the question carries the header", question !== null ? question.header : "none", "Host action");
  ok("the command and the reason", question !== null && question.question.includes("Run on the host: install (" + run + ")?") && question.question.includes("the build is ready"));
  eq("the two choices", question !== null ? question.options.map((o) => o.label).join(",") : "none", "Run it,Don't run");
  const allow = new Reply("answered");
  const yes = new Answer(question !== null ? question.question : "", false);
  yes.labels.push("Run it");
  allow.answers.push(yes);
  c.respond(asked, allow);
  const answer = await pending;
  eq("the marker was written", existsSync(marker) ? readFileSync(marker, "utf8") : "none", "hello\n");
  ok("the answer has the exit code and the output", answer.includes("exit code 0") && answer.includes("done") && answer.includes("err"));
  c.model.closeTurn(null);

  c.model.openTurn("main", 0, true);
  const refusedCall = c.model.block("", "tcrefused", TOOL, "toolu-refused", "HostAction", "");
  ok("the refused call is made", refusedCall !== null);
  rmSync(marker, { force: true });
  const refusedPending = post(callBody(2, { action: "install", reason: "again" }, "toolu-refused"));
  ok("its question opens", await until(() => c.model.openRequests().length > 0, 5000));
  const refusedAsked = c.model.openRequests()[0];
  const deny = new Reply("answered");
  const no = new Answer(refusedAsked !== undefined ? refusedAsked.questions[0].question : "", false);
  no.labels.push("Don't run");
  deny.answers.push(no);
  c.respond(refusedAsked, deny);
  const refused = await refusedPending;
  ok("refused: an error naming the action", refused.includes("the user did not approve install"));
  ok("and nothing ran", !existsSync(marker));
  c.model.closeTurn(null);

  const unknown = await post(callBody(3, { action: "deploy", reason: "ship it" }, "toolu-unknown"));
  ok("an unknown action is refused with the valid ones", unknown.includes("no host action deploy") && unknown.includes("install"));

  w.host.roles.chat.submit("/box");
  eq("/box lists the actions", w.host.screen.message.peek(), "host actions: install");

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });

  const emptyFolder = mkdtempSync(join(tmpdir(), "widecode-box-empty-"));
  const emptyWs = await openWorkspace(emptyFolder, 100);
  const emptyC = new Conversation(emptyWs.folder);
  const empty = composeWidecode(emptyWs, emptyC);
  empty.start({ box: { hostActions: {} } }, new NoStateFile(), []);
  await empty.host.load();
  const emptyUrl = await empty.js.mcp.start();
  const emptyListed = await send(emptyUrl, empty.js.mcp.tokenFor("claude"), '{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("no actions configured: no tool", !emptyListed.includes('"name":"HostAction"'));
  empty.host.roles.chat.submit("/box");
  eq("/box says there are none", empty.host.screen.message.peek(), "no host actions configured");
  empty.host.kernel.stop();
  empty.js.killProcesses();
  emptyWs.close();
  rmSync(emptyFolder, { recursive: true, force: true });

  const offFolder = mkdtempSync(join(tmpdir(), "widecode-box-off-"));
  const offWs = await openWorkspace(offFolder, 100);
  const offC = new Conversation(offWs.folder);
  const off = composeWidecode(offWs, offC);
  off.start({ box: false }, new NoStateFile(), []);
  await off.host.load();
  const offUrl = await off.js.mcp.start();
  const offListed = await send(offUrl, off.js.mcp.tokenFor("claude"), '{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("the plugin switched off offers no tool", !offListed.includes('"name":"HostAction"'));
  off.host.kernel.stop();
  off.js.killProcesses();
  offWs.close();
  rmSync(offFolder, { recursive: true, force: true });

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
