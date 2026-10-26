#!/usr/bin/env node
/**
 * @file A stand-in for an ACP agent (`opencode acp`) in tests: JSON-RPC 2.0 on stdin and stdout,
 * as the Agent Client Protocol has it (agentclientprotocol.com) and opencode 1.19 speaks it. It
 * answers initialize (sessions can be loaded and listed, prompts take images), session/new and
 * session/load with config options (model fake/small or fake/large, effort low, high or default,
 * mode build or plan; a model switched to starts on effort default), session/set_config_option, session/list ("past-1" and the sessions it made)
 * and session/cancel; session/load replays one exchange for "past-1" and nothing for another. With
 * `--legacy` it answers as opencode 1.2 did: modes and models in place of config options, set with
 * session/set_mode and session/set_model, and a todo list as a plan update. A prompt's first word
 * picks what it does:
 *
 * - `hello`: a thought, then "Hello, world." in two chunks of one message;
 * - `two`: two messages, "First." and "Second.";
 * - `run`: an execute call titled with its command, in the folder (pending, in progress, completed
 *   with its output and title, the kind left out);
 * - `edit`: an edit of `a.txt`, its diff the snippet changed and the whole file before and after
 *   in its raw output's metadata, as opencode gives them (the file is not written);
 * - `ask`: a call that asks permission first; it completes when allowed, fails when rejected
 *   (`ask quietly`: the call is not announced before the request);
 * - `plan`: a todo list of three entries, as a `todowrite` call's input (a plan update with
 *   `--legacy`);
 * - `task`: a subagent's call (`subagent_type`, `description`, `prompt` in its input);
 * - `skill`: a `skill` tool call loading the skill "alpha" (its `name` in the input), then a command
 *   and a message, as a skill's run goes on;
 * - `slow`: a chunk, then nothing until session/cancel ends the turn as cancelled;
 * - `work`: a call that runs 800 ms, then "Worked."; a prompt sent while it runs is taken into the
 *   turn, as opencode takes one (the reply adds "Also: <its text>"), and every prompt of the turn is
 *   answered when it ends;
 * - `question` and `present`: a call of widecode's tool for questions or plans (the first listed
 *   whose name has "ask" or "plan") over the MCP server session/new or session/load named
 *   (initialize, the initialized notification, tools/list, then tools/call with a progress token,
 *   its event stream read to the end), titled as opencode titles it (`widecode_<tool>`); the call's
 *   update carries the tool's answer, and a message says the tools listed, whether progress came
 *   and the answer (session/cancel aborts the call and ends the turn as cancelled);
 * - `fail`: the prompt answers an error;
 * - `exit`: the process exits with code 3 mid-turn;
 * - anything else: "You said: <text>".
 *
 * It takes MCP servers over HTTP and forks a session (session/fork: the copy's prompt is answered
 * "Side answer to: <its last line> (in <mode>)"); with `--legacy`, neither. With `--forget <session>
 * --forgotten <path>` it appends the session to the file and exits, as `opencode session delete`.
 *
 * With `--tools <mode>` it prints the mode's tools as opencode's `debug agent <mode>` does (JSON, its
 * `tools` an object of names, `invalid` and `question` among them, and its permission rules: in
 * plan mode edit only on plans, bash asked for, glob denied) and exits. With `--skills` it prints
 * its skills as opencode's `debug skill` does (a JSON list of `name`, `description`, `location` and
 * `content`: one of the folder's, two built in, one with a body of 240 KB, as long as opencode's
 * listing and more) and exits.
 *
 * With `--dsh` it speaks as the DeepSeek Harness (`dsh --profile acp`) does: initialize
 * advertises session/list and session/resume but no loadSession, no fork and no modes; the config
 * options are `model` (category `model`, opaque `["provider","model"]` values in one provider group)
 * and `reasoning_effort` (category `thought_level`, the values "", off, low, high and max);
 * session/resume reopens a persisted session without replaying it (session/load is not a method).
 *
 * With `--log <path>` every message it reads is appended there, one per line, and sessions are
 * numbered across its runs from the session/new requests logged (fake-1, fake-2, …). With
 * `--sessions` it prints "past-1" as an agent's own listing would (JSON, in the folder it runs in)
 * and exits.
 *
 * With `--replay <fixture>` it plays a recording of a real agent instead (test/probe/acp.mjs
 * writes them): each process plays the part of the recording its run made (the Nth process from
 * the Nth `initialize`, counted in the --log), a message from widecode takes the next recorded one
 * of its method within the turn (one it does not find is answered with an error), and the agent's
 * recorded lines up to the next of widecode's are written, a response with the id widecode used and
 * /tmp/PROJECT as the folder widecode named.
 */
import { appendFileSync, readFileSync } from "node:fs";

const PAST = { title: "An earlier session", updated: Date.parse("2026-10-14T10:00:00Z") };
if (process.argv.includes("--sessions")) {
  process.stdout.write(JSON.stringify([{ id: "past-1", title: PAST.title, directory: process.cwd(), time: { created: PAST.updated, updated: PAST.updated } }]) + "\n");
  process.exit(0);
}

const forgetAt = process.argv.indexOf("--forget");
if (forgetAt >= 0) {
  appendFileSync(process.argv[process.argv.indexOf("--forgotten") + 1], process.argv[forgetAt + 1] + "\n");
  process.exit(0);
}

const toolsAt = process.argv.indexOf("--tools");
if (toolsAt >= 0) {
  const mode = process.argv[toolsAt + 1];
  const tools = { invalid: true, question: true, bash: true, read: true, edit: true, write: true, glob: true, webfetch: false };
  const permission = [{ permission: "*", action: "allow", pattern: "*" }, { permission: "read", pattern: "*.env", action: "ask" }];
  if (mode === "plan")
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "glob", pattern: "*", action: "deny" },
    );
  process.stdout.write(JSON.stringify({ name: mode, mode: "primary", permission, tools }, null, 2) + "\n");
  process.exit(0);
}

if (process.argv.includes("--skills")) {
  const skills = [
    { name: "alpha", description: "The first skill: use it when asked for alpha.", location: process.cwd() + "/.claude/skills/alpha/SKILL.md", content: "# Alpha\n\nDo the alpha thing." },
    { name: "customize", description: "Built into the agent.", location: "<built-in>", content: "" },
    // Its content as long as opencode's built-in one and more: the listing passes 64 KB, what a pipe holds.
    { name: "zeta", description: "A skill with a long body.", location: "<built-in>", content: "Step.\n".repeat(40000) },
  ];
  process.stdout.write(JSON.stringify(skills, null, 2) + "\n");
  process.exit(0);
}

const logAt = process.argv.indexOf("--log");
const log = logAt >= 0 ? process.argv[logAt + 1] : "";

const legacy = process.argv.includes("--legacy");
const dsh = process.argv.includes("--dsh");

/** The DeepSeek Harness's opaque model values (["provider","model"], as dsh encodes them) and its efforts. */
const DMODELS = [["deepseek-official", "deepseek-flash"], ["deepseek-official", "deepseek-v4-pro"]];
const DEFFORTS = ["", "off", "low", "high", "max"];
const dvalue = (pair) => JSON.stringify(pair);

/** Each session's folder and settings. */
const state = new Map();
const settingsOf = (sessionId, cwd) => {
  if (!state.has(sessionId)) state.set(sessionId, dsh ? { cwd, model: dvalue(DMODELS[0]), effort: "high" } : { cwd, mode: "build", model: "fake/small", effort: "default" });
  return state.get(sessionId);
};
const VALUES = { model: ["fake/small", "fake/large"], effort: ["low", "high", "default"], mode: ["build", "plan"] };
/** The session's config options as opencode 1.19 gives them, as the DeepSeek Harness gives them, or its modes and models as 1.2 did. */
const answerOf = (s) =>
  dsh
    ? {
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [{ group: "deepseek-official", name: "DeepSeek", options: DMODELS.map((pair) => ({ value: dvalue(pair), name: pair[1] })) }] },
          { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: s.effort, options: DEFFORTS.map((value) => ({ value, name: value.length > 0 ? value : "Provider default" })) },
        ],
      }
    : legacy
    ? {
        modes: { currentModeId: s.mode, availableModes: VALUES.mode.map((id) => ({ id, name: id })) },
        models: { currentModelId: s.model, availableModels: VALUES.model.map((modelId) => ({ modelId, name: modelId })) },
      }
    : {
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: VALUES.model.map((value) => ({ value, name: value })) },
          { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort, options: VALUES.effort.map((value) => ({ value, name: value })) },
          { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: s.mode, options: [{ group: "agents", name: "Agents", options: VALUES.mode.map((value) => ({ value, name: value })) }] },
        ],
      };

let sessions = 0;
let nextId = 1;
/** The prompt waiting on a cancel, and the call to abort then. */
/** @type {{ id: unknown, session: string, abort?: AbortController } | null} */
let slow = null;
/** The MCP servers each session was given. */
const servers = new Map();
/** The `work` turn running: its prompt's id, its session, and the prompts sent into it. */
/** @type {{ ids: unknown[], session: string, also: string[] } | null} */
let working = null;
/** The sessions made by session/fork. */
const forks = new Set();
/** @type {Map<number, (result: { outcome: { outcome: string, optionId?: string } }) => void>} */
const answers = new Map();

const write = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => write({ method: "session/update", params: { sessionId, update: u } });
const text = (t) => ({ type: "text", text: t });
const ask = (method, params, then) => {
  const id = nextId++;
  answers.set(id, then);
  write({ id, method, params });
};

/** A JSON-RPC message POSTed to MCP server `server`: its status and the messages it answered (a stream's, in order). */
const mcp = async (server, body, signal) => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const h of server.headers ?? []) headers[h.name] = h.value;
  const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const messages = type.startsWith("text/event-stream")
    ? raw.split("\n\n").filter((e) => e.includes("data: ")).map((e) => JSON.parse(e.split("\n").find((l) => l.startsWith("data: ")).slice(6)))
    : raw.length > 0 && type.startsWith("application/json") ? [JSON.parse(raw)] : [];
  return { status: res.status, messages };
};

/** Call widecode's tool whose name matches `pattern` with `args` over the session's server, as opencode does. */
const callTool = async (id, sessionId, pattern, args) => {
  const server = (servers.get(sessionId) ?? []).find((s) => s.name === "widecode");
  if (server === undefined) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("No widecode server.") });
    return write({ id, result: { stopReason: "end_turn" } });
  }
  const abort = new AbortController();
  slow = { id, session: sessionId, abort };
  try {
    const init = await mcp(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "1" } } }, abort.signal);
    await mcp(server, { jsonrpc: "2.0", method: "notifications/initialized" }, abort.signal);
    const listed = await mcp(server, { jsonrpc: "2.0", id: 2, method: "tools/list" }, abort.signal);
    const names = listed.messages[0].result.tools.map((t) => t.name);
    const tool = names.find((n) => pattern.test(n)) ?? "none";
    const callId = "call_" + tool;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: "widecode_" + tool, kind: "other", status: "pending", rawInput: {} });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress", title: "widecode_" + tool, kind: "other", rawInput: args });
    const called = await mcp(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args, _meta: { progressToken: 7 } } }, abort.signal);
    const progress = called.messages.some((m) => m.method === "notifications/progress" && m.params.progressToken === 7);
    const last = called.messages[called.messages.length - 1];
    const out = last.result.content.map((c) => c.text).join("");
    slow = null;
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: last.result.isError ? "failed" : "completed", content: [{ type: "content", content: text(out) }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Tools: " + names.join(",") + "; progress: " + (progress ? "yes" : "no") + "; " + init.messages[0].result.serverInfo.name + " " + init.messages[0].result.protocolVersion + " answered: " + out) });
    write({ id, result: { stopReason: "end_turn" } });
  } catch (e) {
    if (abort.signal.aborted) return;
    slow = null;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("The call failed: " + e.message) });
    write({ id, result: { stopReason: "end_turn" } });
  }
};

const prompt = (id, sessionId, params) => {
  const words = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const first = words.trim().split(/\s+/)[0];
  if (working !== null && working.session === sessionId) {
    working.ids.push(id);
    working.also.push(words);
    return;
  }
  if (forks.has(sessionId)) {
    const lines = words.trim().split("\n");
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Side answer to: " + lines[lines.length - 1]) });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(" (in " + settingsOf(sessionId, process.cwd()).mode + ")") });
    return write({ id, result: { stopReason: "end_turn" } });
  }
  const end = (stopReason) => write({ id, result: { stopReason } });
  const cwd = settingsOf(sessionId, process.cwd()).cwd;
  /** A message's id, as opencode 1.19 names them (1.2 did not). */
  const id_ = (m) => (legacy ? {} : { messageId: m });
  if (first === "hello") {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", ...id_("prt_think"), content: text("Thinking about it.") });
    update(sessionId, { sessionUpdate: "agent_message_chunk", ...id_("msg_hello"), content: text("Hello, ") });
    update(sessionId, { sessionUpdate: "agent_message_chunk", ...id_("msg_hello"), content: text("world.") });
    end("end_turn");
  } else if (first === "two") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "msg_first", content: text("First.") });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "msg_second", content: text("Second.") });
    end("end_turn");
  } else if (first === "run") {
    const input = { command: "ls -1", description: "List files", cwd };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_run", title: "ls -1", kind: "execute", status: "pending", locations: [{ path: cwd }], rawInput: input });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_run", status: "in_progress", kind: "execute", title: "ls -1", locations: [{ path: cwd }], rawInput: input });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_run", status: "completed", title: "List files", content: [{ type: "content", content: text("a.txt\nb.txt") }], rawOutput: { output: "a.txt\nb.txt\n" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Two files.") });
    end("end_turn");
  } else if (first === "edit") {
    const path = cwd + "/a.txt";
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_edit", title: "edit", kind: "edit", status: "in_progress", locations: [{ path }], rawInput: { filePath: path, oldString: "one", newString: "one\ntwo" } });
    const before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\none\nl9\nl10\n";
    const after = before.replace("one\n", "one\ntwo\n");
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_edit",
      status: "completed",
      title: "a.txt",
      content: [{ type: "content", content: text("Edit applied successfully.") }, { type: "diff", path, oldText: "one", newText: "one\ntwo" }],
      rawOutput: { output: "Edit applied successfully.", metadata: { filediff: { file: path, before, after, additions: 1, deletions: 0 } } },
    });
    end("end_turn");
  } else if (first === "ask") {
    const call = { toolCallId: "call_ask", title: "rm a.txt", kind: "execute", rawInput: { command: "rm a.txt" } };
    if (!words.includes("quietly")) update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
    const options = [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];
    ask("session/request_permission", { sessionId, toolCall: call, options }, (result) => {
      const outcome = result.outcome;
      if (outcome.outcome === "cancelled") return end("cancelled");
      const allowed = outcome.optionId === "once" || outcome.optionId === "always";
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_ask", status: allowed ? "completed" : "failed", content: [{ type: "content", content: text(allowed ? "removed" : "rejected by the user") }] });
      end("end_turn");
    });
  } else if (first === "plan") {
    const entries = [
      { content: "read the code", priority: "high", status: "completed" },
      { content: "write the test", priority: "medium", status: "in_progress" },
      { content: "run it", priority: "low", status: "pending" },
    ];
    if (legacy) update(sessionId, { sessionUpdate: "plan", entries });
    else {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_todo", title: "todowrite", kind: "other", status: "pending", rawInput: { todos: entries } });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_todo", status: "completed", title: "2 todos", content: [{ type: "content", content: text(JSON.stringify(entries)) }], rawOutput: { output: JSON.stringify(entries) } });
    }
    end("end_turn");
  } else if (first === "task") {
    const input = { description: "find the tests", prompt: "Look for the test files and list them.", subagent_type: "explore" };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_task", title: "task", kind: "think", status: "pending", rawInput: input });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_task", status: "completed", title: "find the tests", content: [{ type: "content", content: text("test/a.test.ts") }], rawOutput: { output: "test/a.test.ts" } });
    end("end_turn");
  } else if (first === "skill") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_skill", title: "skill", kind: "other", status: "pending", rawInput: { name: "alpha" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_skill", status: "completed", title: "alpha", content: [{ type: "content", content: text("# Alpha\n\nDo the alpha thing.") }], rawOutput: { output: "# Alpha" } });
    const input = { command: "ls -1", description: "List files", cwd };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_skill_run", title: "ls -1", kind: "execute", status: "completed", locations: [{ path: cwd }], rawInput: input, content: [{ type: "content", content: text("a.txt") }], rawOutput: { output: "a.txt\n" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Alpha done.") });
    end("end_turn");
  } else if (first === "question") callTool(id, sessionId, /ask/i, { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }] });
  else if (first === "present") callTool(id, sessionId, /plan/i, { plan: "1. Write the test\n2. Make it pass" });
  else if (first === "call") {
    const rest = words.trim().split(/\s+/);
    callTool(id, sessionId, new RegExp("^" + rest[1] + "$"), rest.length > 2 ? JSON.parse(rest.slice(2).join(" ")) : {});
  }
  else if (first === "work") {
    working = { ids: [id], session: sessionId, also: [] };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_work", title: "bash", kind: "execute", status: "pending", rawInput: { command: "sleep 1" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_work", status: "in_progress", kind: "execute", title: "sleep 1", rawInput: { command: "sleep 1" } });
    setTimeout(() => {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_work", status: "completed", title: "sleep 1", content: [{ type: "content", content: text("") }], rawOutput: { output: "" } });
      // The next step reads what was sent meanwhile.
      setTimeout(() => {
        const w = working;
        working = null;
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Worked." + (w.also.length > 0 ? " Also: " + w.also.join(" | ") : "")) });
        for (const pid of w.ids) write({ id: pid, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
      }, 200);
    }, 800);
  } else if (first === "slow") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Working…") });
    slow = { id, session: sessionId };
  } else if (first === "fail") write({ id, error: { code: -32603, message: "model unavailable" } });
  else if (first === "exit") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("Leaving.") });
    process.exit(3);
  } else {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("You said: " + words) });
    end("end_turn");
  }
};

const handle = (m) => {
  if (log.length > 0) appendFileSync(log, JSON.stringify(m) + "\n");
  if (m.method === undefined) {
    const then = answers.get(m.id);
    answers.delete(m.id);
    if (then !== undefined) then(m.result);
    return;
  }
  const p = m.params ?? {};
  if (m.method === "initialize")
    write({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: dsh
          ? { mcpCapabilities: { http: true }, promptCapabilities: { image: false }, sessionCapabilities: { list: {}, resume: {} } }
          : { loadSession: true, ...(legacy ? {} : { mcpCapabilities: { http: true, sse: true } }), promptCapabilities: { image: true }, sessionCapabilities: { list: {}, ...(legacy ? {} : { fork: {} }) } },
        authMethods: [],
        agentInfo: { name: dsh ? "deepseek-harness-acp" : "fake-acp", version: "1" },
      },
    });
  else if (m.method === "session/fork") {
    const sessionId = "fork-" + String(forks.size + 1);
    forks.add(sessionId);
    const from = settingsOf(p.sessionId, p.cwd);
    state.set(sessionId, { ...from });
    write({ id: m.id, result: { sessionId, ...answerOf(state.get(sessionId)) } });
  }
  else if (m.method === "session/new") {
    const made = log.length > 0 ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"method":"session/new"')).length : ++sessions;
    const sessionId = "fake-" + String(made);
    servers.set(sessionId, p.mcpServers ?? []);
    write({ id: m.id, result: { sessionId, ...answerOf(settingsOf(sessionId, p.cwd)) } });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "write AGENTS.md" }, { name: "review", description: "review the changes" }] });
  } else if (m.method === "session/resume") {
    // The DeepSeek Harness reopens a persisted session without replaying it; the fake as opencode has no such method.
    if (!dsh) return write({ id: m.id, error: { code: -32601, message: "no method session/resume" } });
    const s = settingsOf(p.sessionId, p.cwd);
    servers.set(p.sessionId, p.mcpServers ?? []);
    write({ id: m.id, result: { configOptions: answerOf(s).configOptions } });
  } else if (m.method === "session/load") {
    // The DeepSeek Harness has no session/load (it resumes without replay); it is not a method there.
    if (dsh) return write({ id: m.id, error: { code: -32601, message: "no method session/load" } });
    const s = settingsOf(p.sessionId, p.cwd);
    servers.set(p.sessionId, p.mcpServers ?? []);
    if (p.sessionId === "past-1") {
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: text("earlier ") });
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: text("question") });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: text("earlier answer") });
      update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "past_read", title: "read", kind: "read", status: "completed", locations: [{ path: p.cwd + "/a.txt" }], rawInput: { filePath: p.cwd + "/a.txt" }, content: [{ type: "content", content: text("one") }] });
    }
    write({ id: m.id, result: answerOf(s) });
  } else if (m.method === "session/list") {
    const made = [...state.keys()].filter((id) => id !== "past-1" && state.get(id).cwd === p.cwd).map((sessionId) => ({ sessionId, cwd: p.cwd, title: "Session " + sessionId, updatedAt: new Date().toISOString() }));
    write({ id: m.id, result: { sessions: [{ sessionId: "past-1", cwd: p.cwd, title: PAST.title, updatedAt: new Date(PAST.updated).toISOString() }, ...made] } });
  } else if (m.method === "session/prompt") prompt(m.id, p.sessionId, p);
  else if (m.method === "session/set_config_option" && !legacy) {
    const s = settingsOf(p.sessionId, process.cwd());
    if (dsh) {
      const ok = p.configId === "model" ? DMODELS.map(dvalue).includes(p.value) : p.configId === "reasoning_effort" && DEFFORTS.includes(p.value);
      if (!ok) return write({ id: m.id, error: { code: -32602, message: "no " + p.configId + " " + p.value } });
      if (p.configId === "model") s.model = p.value;
      else s.effort = p.value;
      write({ id: m.id, result: answerOf(s) });
    } else if (!(p.configId in VALUES) || !VALUES[p.configId].includes(p.value)) write({ id: m.id, error: { code: -32602, message: "no " + p.configId + " " + p.value } });
    else {
      s[p.configId] = p.value;
      // The efforts are a model's: one switched to starts on its default.
      if (p.configId === "model") s.effort = "default";
      write({ id: m.id, result: answerOf(s) });
    }
  } else if (m.method === "session/set_mode") {
    settingsOf(p.sessionId, process.cwd()).mode = p.modeId;
    update(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.modeId });
    write({ id: m.id, result: {} });
  } else if (m.method === "session/set_model") {
    settingsOf(p.sessionId, process.cwd()).model = p.modelId;
    write({ id: m.id, result: {} });
  }
  else if (m.method === "session/cancel") {
    if (slow !== null && slow.session === p.sessionId) {
      if (slow.abort !== undefined) slow.abort.abort();
      write({ id: slow.id, result: { stopReason: "cancelled" } });
      slow = null;
    }
  } else if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: "no method " + m.method } });
};

const replayAt = process.argv.indexOf("--replay");
/** The recording, its position (the last of widecode's messages taken), the ids widecode used for the recorded ones, the folder. */
const records = replayAt >= 0 ? readFileSync(process.argv[replayAt + 1], "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => ({ dir: r.dir, raw: r.raw, m: JSON.parse(r.raw) })) : [];
let at = -1;
const ids = new Map();
let folder = "/tmp/PROJECT";
/** Where a search for widecode's next message stops: the next turn, load or process. */
const BOUNDARIES = ["session/prompt", "session/load", "initialize"];

const replay = (m) => {
  if (log.length > 0) appendFileSync(log, JSON.stringify(m) + "\n");
  if (m.params?.cwd !== undefined) folder = m.params.cwd;
  let found = -1;
  if (m.method === "initialize") {
    const nth = log.length > 0 ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"method":"initialize"')).length : 1;
    let seen = 0;
    for (let i = 0; i < records.length && found < 0; i++) if (records[i].dir === "out" && records[i].m.method === "initialize" && ++seen === nth) found = i;
  } else
    for (let i = at + 1; i < records.length && found < 0; i++) {
      const r = records[i];
      if (r.dir !== "out") continue;
      if (r.m.method === m.method) found = i;
      else if (BOUNDARIES.includes(r.m.method) && !BOUNDARIES.includes(m.method)) break;
    }
  if (found < 0) {
    if (m.id !== undefined && m.method !== undefined) write({ id: m.id, error: { code: -32601, message: "not in the recording: " + m.method } });
    return;
  }
  at = found;
  if (records[found].m.id !== undefined && m.method !== undefined) ids.set(records[found].m.id, m.id);
  for (let i = found + 1; i < records.length && records[i].dir === "in"; i++) {
    const r = records[i];
    const raw = r.raw.split("/tmp/PROJECT").join(folder);
    if (r.m.method === undefined && r.m.id !== undefined) {
      // A response: to the request widecode made in its place, else to one it did not make.
      if (!ids.has(r.m.id)) continue;
      process.stdout.write(JSON.stringify({ ...JSON.parse(raw), id: ids.get(r.m.id) }) + "\n");
    } else process.stdout.write(raw + "\n");
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) (replayAt >= 0 ? replay : handle)(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
