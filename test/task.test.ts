// ffi: @lightstart/plugins/native/ffi.json
// widecode's Task tool (the acp plugin): a Claude call with its tool-use id starts an ACP subagent
// on a target's agent and model, its thought and words stream under the call, the call shows as a
// subagent and the Agents tab follows it, and the MCP result is its last words. Cancelling the MCP
// call stops the subagent and marks it stopped.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT, NOTICE, TEXT, THINKING, TOOL } from "../src/conversation/model.ts";
import { itemLines, RenderContext } from "../src/conversation/render.ts";
import { agentsOf } from "../src/conversation/agents.ts";
import { Answer, Reply } from "../src/conversation/requests.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { Store } from "../src/services/store.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

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

const lastSessionCwd = (file: string): string => {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = JSON.parse(lines[i]) as { method?: unknown; params?: { cwd?: unknown } };
    if (m.method === "session/new" && typeof m.params?.cwd === "string") return m.params.cwd;
  }
  return "";
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-task-"));
  const log = join(folder, "fake.log");
  const config: unknown = {
    acp: {
      agents: { fake: { name: "Fake", command: ["node", fake, "--log", log] } },
      tasks: { targets: { deepseek: { agent: "fake", model: "fake/large", description: "a test subagent" } }, maxConcurrent: 1 },
    },
  };
  const w = await openWidecode({ folder, plugins: config, load: true });
  const c = w.host.conversation;
  const url = await w.js.mcp.start();
  const token = w.js.mcp.tokenFor("claude");
  const post = (body: string): Promise<string> => send(url, token, body);
  const listed = await post('{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
  ok("Claude sees the Task tools", listed.includes('"name":"Task"') && listed.includes('"name":"TaskStop"') && listed.includes('"name":"SendMessage"'));

  c.model.openTurn("main", 0, true);
  const call = c.model.block("", "tc", TOOL, "toolu-task", "Task", "");
  ok("the Task call is made", call !== null);
  if (call === null) return;
  call.category = "other";
  const reply = await post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"say hello","prompt":"hello","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-task"}}}');
  ok("the subagent's last words are the result", reply.includes("Hello, world."));
  ok("its thought and words stream under the call", call.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world.")) && call.children.some((i) => i.kind === THINKING));
  eq("the call is a subagent, done", call.category + " " + (call.task !== null ? call.task.status : "none"), AGENT + " done");
  eq("the Agents tab lists the run", String(agentsOf(c.model).length), "1");
  ok("the target's model was chosen", readFileSync(log, "utf8").includes('"configId":"model","value":"fake/large"'));

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const logsCall = c.model.block("", "tclogs", TOOL, "toolu-logs", "Task", "");
  ok("the logs call is made", logsCall !== null);
  if (logsCall === null) return;
  const logsReply = await post('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"Task","arguments":{"description":"write logs","prompt":"logs","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-logs"}}}');
  const logs = logsCall.children.filter((i) => i.kind === NOTICE && i.tone === "log");
  eq("its stderr lines are kept under the call, in order, the last 200", String(logs.length) + " " + (logs.length > 0 ? logs[0].text : "") + " " + (logs.length > 0 ? logs[logs.length - 1].text : ""), "200 line 2 line 201");
  const drawn = logs.length > 0 ? itemLines(logs[logs.length - 1], new RenderContext(), [], 80).map((l) => l.runs.map((r) => r.text).join("")).join("") : "";
  ok("and its view draws one with a log marker", logsReply.includes("Logged.") && drawn.startsWith("log line 201"));

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const slash = c.model.block("", "tcslash", TOOL, "toolu-slash", "Task", "");
  ok("the trailing slash call is made", slash !== null);
  if (slash === null) return;
  const slashReply = await post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"Task","arguments":{"description":"slash","prompt":"hello","subagent_type":"deepseek","cwd":"' + folder + '/"},"_meta":{"claudecode/toolUseId":"toolu-slash"}}}');
  ok("a folder with a trailing slash is the session's folder", slashReply.includes("Hello, world."));

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const elsewhere = mkdtempSync(join(tmpdir(), "widecode-task-elsewhere-"));
  c.model.block("", "tcexternal", TOOL, "toolu-external", "Task", "");
  const externalReply = await post('{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"Task","arguments":{"description":"another folder","prompt":"hello","subagent_type":"deepseek","cwd":"' + elsewhere + '"},"_meta":{"claudecode/toolUseId":"toolu-external"}}}');
  ok("a Task with cwd runs there", externalReply.includes("Hello, world.") && lastSessionCwd(log) === elsewhere);
  rmSync(elsewhere, { recursive: true, force: true });

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  mkdirSync(join(folder, "sub"));
  c.model.block("", "tcrelative", TOOL, "toolu-relative", "Task", "");
  const relativeReply = await post('{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"Task","arguments":{"description":"a relative folder","prompt":"hello","subagent_type":"deepseek","cwd":"sub"},"_meta":{"claudecode/toolUseId":"toolu-relative"}}}');
  ok("a relative cwd is under the session's folder", relativeReply.includes("Hello, world.") && lastSessionCwd(log) === folder + "/sub");

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  c.model.block("", "tcdot", TOOL, "toolu-dot", "Task", "");
  const dotReply = await post('{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"Task","arguments":{"description":"this folder","prompt":"hello","subagent_type":"deepseek","cwd":"."},"_meta":{"claudecode/toolUseId":"toolu-dot"}}}');
  ok("a cwd of . is the session's folder", dotReply.includes("Hello, world.") && lastSessionCwd(log) === folder);

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  c.model.block("", "tcdotdot", TOOL, "toolu-dotdot", "Task", "");
  const dotdotReply = await post('{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"Task","arguments":{"description":"a parent folder","prompt":"hello","subagent_type":"deepseek","cwd":"../outside"},"_meta":{"claudecode/toolUseId":"toolu-dotdot"}}}');
  ok("a cwd with .. is refused", dotdotReply.includes("a subagent's folder is a path without .."));

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const slow = c.model.block("", "tc2", TOOL, "toolu-slow", "Task", "");
  ok("the slow call is made", slow !== null);
  if (slow === null) return;
  const held = post('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"Task","arguments":{"description":"wait","prompt":"slow","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-slow"}}}');
  ok("a running subagent's words show before it ends", await until(() => slow.children.some((i) => i.kind === TEXT), 5000));
  await post('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}');
  await held;
  eq("cancelling stops the subagent", slow.task !== null ? slow.task.status : "none", "stopped");

  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const unknown = c.model.block("", "tcunknown", TOOL, "toolu-unknown", "Task", "");
  ok("the unknown-request call is made", unknown !== null);
  if (unknown === null) return;
  const unknownReply = await post('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"Task","arguments":{"description":"unknown","prompt":"unknown","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-unknown"}}}');
  ok("an unknown request is answered with an error", unknownReply.includes("-32601") && unknownReply.includes("session/unknown_thing is not supported"));

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
  // A subagent's permission is a permission's request: no answer in the user's own words.
  ok("it is marked as a permission", request.permission);
  w.chat.pane.panel.open(request);
  w.chat.typed("let it run");
  eq("free words are refused, the request still open", request.state + " " + String(w.chat.pane.panel.active) + " " + w.host.screen.message.peek(), "open true Choose one of the options: a permission has no answer in your own words.");
  w.chat.pane.panel.close();
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

  // A background run outlives its turn, can be messaged and stopped.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const bg = c.model.block("", "tcbg", TOOL, "toolu-bg", "Task", "");
  ok("the background call is made", bg !== null);
  if (bg === null) return;
  const started = await post('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"Task","arguments":{"description":"later","prompt":"work","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-bg"}}}');
  ok("a background run starts at once", started.includes("subagent started: toolu-bg"));
  c.model.closeTurn(null);
  ok("and goes on after the turn", await until(() => bg.task !== null && bg.task.status === "done" && bg.children.some((i) => i.kind === TEXT && i.text.includes("Worked.")), 15000));
  // An idle background run holds no place: with one at a time, another run starts beside it.
  c.model.openTurn("main", 0, true);
  const beside = c.model.block("", "tcnext", TOOL, "toolu-next", "Task", "");
  ok("the next call is made", beside !== null);
  const next = await post('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"Task","arguments":{"description":"beside","prompt":"hello","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-next"}}}');
  ok("a run starts beside an idle background one", next.includes("Hello, world."));
  c.model.closeTurn(null);
  const sent = await post('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"SendMessage","arguments":{"task_id":"toolu-bg","message":"hello"}}}');
  ok("a message reaches the idle run", sent.includes("sent to toolu-bg"));
  ok("and its answer lands in the same card", await until(() => bg.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world.")), 15000));
  const stopped = await post('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"TaskStop","arguments":{"task_id":"toolu-bg"}}}');
  ok("a background run can be stopped", stopped.includes("stopped toolu-bg") && bg.task !== null && bg.task.status === "stopped");

  // A background run asks permission after the turn its card is in has closed and another opened,
  // as a message sent mid-turn does: the question is still put to the user, under its card.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const late = c.model.block("", "tclate", TOOL, "toolu-late", "Task", "");
  ok("the late call is made", late !== null);
  if (late === null) return;
  const lateStarted = await post('{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"Task","arguments":{"description":"late permission","prompt":"ask","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-late"}}}');
  ok("the late background run starts at once", lateStarted.includes("subagent started: toolu-late"));
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  ok("its permission is still open after its turn closed", await until(() => c.model.openRequests().length > 0, 10000));
  const lateRequest = c.model.openRequests()[0];
  eq("under the late Task call", String(lateRequest !== undefined && lateRequest.turn === late.turn && late.children.includes(lateRequest)), "true");
  if (lateRequest !== undefined) {
    const reply = new Reply("answered");
    const a = new Answer(lateRequest.questions[0].question, false);
    a.labels.push("Allow once");
    reply.answers.push(a);
    c.respond(lateRequest, reply);
  }
  ok("the allowed call ran", await until(() => late.children.some((i) => i.kind === TOOL && i.result !== null && i.result.text === "removed"), 10000));
  ok("and its run is done", await until(() => late.task !== null && late.task.status === "done", 10000));

  // A question asked while the card's turn is open survives that turn closing for a message.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const across = c.model.block("", "tcacross", TOOL, "toolu-across", "Task", "");
  ok("the across-turn call is made", across !== null);
  if (across === null) return;
  const acrossStarted = await post('{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"Task","arguments":{"description":"across turns","prompt":"ask","subagent_type":"deepseek","run_in_background":true},"_meta":{"claudecode/toolUseId":"toolu-across"}}}');
  ok("the across-turn background run starts", acrossStarted.includes("subagent started: toolu-across"));
  ok("its permission is asked", await until(() => c.model.openRequests().length > 0, 10000));
  const acrossRequest = c.model.openRequests()[0];
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  eq("the question is still open after its turn closed", acrossRequest !== undefined ? acrossRequest.state : "none", "open");
  ok("and it is under the call", acrossRequest !== undefined && across.children.includes(acrossRequest));
  if (acrossRequest !== undefined) {
    const reply = new Reply("answered");
    const a = new Answer(acrossRequest.questions[0].question, false);
    a.labels.push("Allow once");
    reply.answers.push(a);
    c.respond(acrossRequest, reply);
  }
  ok("the answer reaches the run", await until(() => across.children.some((i) => i.kind === TOOL && i.result !== null && i.result.text === "removed"), 10000));
  ok("and the run is done", await until(() => across.task !== null && across.task.status === "done", 10000));

  // A refused permission, then the run's own end, is in its answer and its card.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  const refusedCall = c.model.block("", "tcrefused", TOOL, "toolu-refused", "Task", "");
  ok("the refused call is made", refusedCall !== null);
  if (refusedCall === null) return;
  const refusedReply = post('{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"Task","arguments":{"description":"refused","prompt":"ask","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-refused"}}}');
  ok("its permission is asked", await until(() => c.model.openRequests().length > 0, 10000));
  const refusedRequest = c.model.openRequests()[0];
  if (refusedRequest !== undefined) {
    const reply = new Reply("answered");
    const a = new Answer(refusedRequest.questions[0].question, false);
    a.labels.push("Reject");
    reply.answers.push(a);
    c.respond(refusedRequest, reply);
  }
  const refusedAnswer = await refusedReply;
  ok("the answer says the permission was refused", refusedAnswer.includes("[a permission was refused: rm a.txt]"));
  eq("and its card says so", refusedCall.task !== null ? refusedCall.task.summary : "none", "a permission was refused: rm a.txt");

  // Full access answers a subagent's permission at once, with no request in the panel.
  c.model.closeTurn(null);
  c.model.openTurn("main", 0, true);
  w.host.approval.set("full");
  const fullCall = c.model.block("", "tcfull", TOOL, "toolu-full", "Task", "");
  ok("the full-access call is made", fullCall !== null);
  if (fullCall === null) return;
  await post('{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"Task","arguments":{"description":"allowed","prompt":"ask","subagent_type":"deepseek"},"_meta":{"claudecode/toolUseId":"toolu-full"}}}');
  ok("the permission was allowed without a request", c.model.openRequests().length === 0);
  ok("the allowed call ran", fullCall.children.some((i) => i.kind === TOOL && i.result !== null && i.result.text === "removed"));
  w.host.approval.set("ask");
  c.model.closeTurn(null);

  // An ACP main agent names no tool-use id: the Task tool makes the card itself, or runs under the
  // card the main announced. A store keeps the runs' transcripts.
  const folder3 = mkdtempSync(join(tmpdir(), "widecode-task-acp-"));
  const home3 = mkdtempSync(join(tmpdir(), "widecode-task-acp-home-"));
  execFileSync("git", ["init", "-q"], { cwd: folder3 });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: folder3 });
  const setupLines = [
    'if [ -f "$WIDECODE_FOLDER/setup" ]; then printf "%s" "$WIDECODE_FOLDER" > setup.txt; fi',
    'if [ -f "$WIDECODE_FOLDER/fail-setup" ]; then echo "setup broke" >&2; exit 1; fi',
  ];
  const w3 = await openWidecode({
    folder: folder3,
    plugins: { acp: { agents: { fake: { name: "Fake", command: ["node", fake] } }, tasks: { targets: { deepseek: { agent: "fake" } }, worktreeSetup: setupLines } } },
    load: true,
    before: async (w: Widecode) => {
      const store3 = new Store(home3);
      store3.trust(folder3);
      await w.host.useStore(store3);
    },
  });
  const c3 = w3.host.conversation;
  w3.host.session.useAgent("fake");
  const url3 = await w3.js.mcp.start();
  const acp = w3.js.mcp.tokenFor("acp");
  c3.model.openTurn("main", 0, true);
  const acpReply = await send(url3, acp, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Task","arguments":{"description":"acp main","prompt":"hello","subagent_type":"deepseek"}}}');
  ok("an ACP main gets the subagent's answer", acpReply.includes("Hello, world."));
  const acpCard = agentsOf(c3.model).find((i) => i.agentTask === "acp main") ?? null;
  ok("and a subagent card it made itself", acpCard !== null && acpCard.category === "agent" && acpCard.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world.")));
  c3.model.closeTurn(null);
  w3.host.roles.chat.submit("go");
  ok("the ACP main runs", await until(() => !c3.model.running && c3.model.turns.length > 0, 10000));
  c3.model.openTurn("main", 0, true);
  const bgAcp = await send(url3, acp, '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"Task","arguments":{"description":"acp background","prompt":"hello","subagent_type":"deepseek","run_in_background":true}}}');
  const bgId = (/subagent started: ([^\s"]+)/.exec(bgAcp) ?? [])[1] ?? "";
  ok("an ACP main starts a background run", bgId.length > 0);
  c3.model.closeTurn(null);
  ok("its card finishes", await until(() => {
    const card = c3.model.tool(bgId);
    return card !== null && card.task !== null && card.task.status === "done" && card.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world."));
  }, 15000));
  ok("and the main agent hears about it", await until(() => c3.model.turns.some((t) => t.prompt !== null && t.prompt.text.includes("background subagent " + bgId + " finished")), 15000));
  c3.model.openTurn("main", 0, true);
  const unchanged = await send(url3, acp, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Task","arguments":{"description":"in a worktree","prompt":"hello","subagent_type":"deepseek","isolation":"worktree"}}}');
  ok("a worktree run with no change removes its worktree", unchanged.includes("Hello, world.") && unchanged.includes("worktree removed: no changes") && !unchanged.includes("[worktree:"));
  const worktrees = join(folder3, ".worktrees");
  const branches = (pattern: string): string => spawnSync("git", ["-C", folder3, "branch", "--list", pattern], { encoding: "utf8" }).stdout;
  eq("its worktree folder is gone", existsSync(worktrees) ? String(readdirSync(worktrees).length) : "0", "0");
  eq("its branch is gone", branches("widecode/*").trim(), "");
  c3.model.closeTurn(null);

  c3.model.openTurn("main", 0, true);
  writeFileSync(join(folder3, "fail-setup"), "");
  const failed = await send(url3, acp, '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"Task","arguments":{"description":"setup fails","prompt":"hello","subagent_type":"deepseek","isolation":"worktree"}}}');
  ok("a failing setup line fails the call", failed.includes("worktree setup failed") && failed.includes("setup broke"));
  eq("and leaves no worktree", existsSync(worktrees) ? String(readdirSync(worktrees).length) : "0", "0");
  eq("nor its branch", branches("widecode/*").trim(), "");
  rmSync(join(folder3, "fail-setup"));
  c3.model.closeTurn(null);

  c3.model.openTurn("main", 0, true);
  const changed = await send(url3, acp, '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"Task","arguments":{"description":"with a change","prompt":"change","subagent_type":"deepseek","isolation":"worktree"}}}');
  const changedPath = (/\[worktree: (.+?) \(branch /.exec(changed) ?? [])[1] ?? "";
  const changedBranch = (/\(branch (.+?)\)/.exec(changed) ?? [])[1] ?? "";
  ok("a worktree run with a change keeps it", changed.includes("Changed.") && changedPath.length > 0 && changedBranch.length > 0 && existsSync(join(changedPath, "changed.txt")) && branches(changedBranch).trim().length > 0);
  c3.model.closeTurn(null);

  c3.model.openTurn("main", 0, true);
  writeFileSync(join(folder3, "setup"), "");
  const withSetup = await send(url3, acp, '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"Task","arguments":{"description":"with setup","prompt":"change","subagent_type":"deepseek","isolation":"worktree"}}}');
  const setupPath = (/\[worktree: (.+?) \(branch /.exec(withSetup) ?? [])[1] ?? "";
  ok("setup runs in the new worktree with both folders", setupPath.length > 0 && readFileSync(join(setupPath, "setup.txt"), "utf8") === folder3);
  rmSync(join(folder3, "setup"));
  c3.model.closeTurn(null);

  // A worktree of another repository lives under that repository's .worktrees/ and, since the
  // setup lines are the session folder's, runs none of them there.
  c3.model.openTurn("main", 0, true);
  writeFileSync(join(folder3, "setup"), "");
  const repo3 = mkdtempSync(join(tmpdir(), "widecode-task-other-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo3 });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: repo3 });
  const otherWorktree = await send(url3, acp, '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"Task","arguments":{"description":"another repository","prompt":"change","subagent_type":"deepseek","cwd":"' + repo3 + '","isolation":"worktree"}}}');
  const otherPath = (/\[worktree: (.+?) \(branch /.exec(otherWorktree) ?? [])[1] ?? "";
  ok("a worktree of another folder is under that folder's .worktrees", otherWorktree.includes("Changed.") && otherPath.startsWith(repo3 + "/.worktrees/") && existsSync(join(otherPath, "changed.txt")));
  ok("and runs none of the session's setup lines", otherPath.length > 0 && !existsSync(join(otherPath, "setup.txt")));
  rmSync(join(folder3, "setup"));
  rmSync(repo3, { recursive: true, force: true });
  c3.model.closeTurn(null);

  // An ACP main announces widecode's Task call: the run goes under that call's card, not a new one.
  w3.host.roles.chat.submit("taskcall");
  ok("the ACP main announces a Task call", await until(() => c3.model.tool("call_widecode_task") !== null, 10000));
  const announced = c3.model.tool("call_widecode_task");
  const announcedReply = await send(url3, acp, '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"Task","arguments":{"description":"announced run","prompt":"hello","subagent_type":"deepseek"}}}');
  ok("the announced run answers", announcedReply.includes("Hello, world."));
  ok("its steps go under the announced card", announced !== null && announced.children.some((i) => i.kind === TEXT && i.text.includes("Hello, world.")));
  ok("no synthetic card is made", agentsOf(c3.model).filter((i) => i.agentTask === "announced run").length === 1);
  const taskFile = join(folder3, ".widecode", "tasks", c3.model.sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"), "call_widecode_task.jsonl");
  ok("the transcript is kept under the announced id", existsSync(taskFile));
  if (announced !== null) {
    announced.children = [];
    announced.blocks.clear();
    ok("the adapter reads the kept transcript back", c3.loadSubagent(announced) && announced.children.length > 0);
  }
  c3.interrupt();
  ok("the announced turn ends", await until(() => !c3.model.running, 10000));
  closeWidecode(w3);
  rmSync(folder3, { recursive: true, force: true });
  rmSync(home3, { recursive: true, force: true });

  // Claude's own subagent tools step aside when widecode offers Task.
  const folder2 = mkdtempSync(join(tmpdir(), "widecode-task-claude-"));
  const argsFile = join(folder2, "args.txt");
  const w2 = await openWidecode({ folder: folder2, plugins: { acp: { agents: { fake: { name: "Fake", command: ["node", fake] } }, tasks: { replaceClaudeSubagents: true, targets: { deepseek: { agent: "fake", model: "fake/large" } } } } }, load: true });
  const c2 = w2.host.conversation;
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
  closeWidecode(w2);
  rmSync(folder2, { recursive: true, force: true });

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exitCode = 1;
});
