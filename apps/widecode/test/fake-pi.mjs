#!/usr/bin/env node
/**
 * @file A stand-in for pi (`pi --mode rpc`) in tests: JSONL commands on stdin, responses and session
 * events on stdout, as @earendil-works/pi-coding-agent 1.5.1 speaks them. It keeps a session file in
 * pi's folder for the current directory (~/.pi/agent/sessions/--<cwd>--/), so the plugin can list and
 * resume it. A prompt's first word picks what it does:
 *
 * - `hello`: a thought, then "Hello, world." in two chunks;
 * - `run`: a bash call with its output, then a message;
 * - `edit`: an edit of `a.txt` with a unified patch in its details, then a message;
 * - `work`: a bash call that runs a moment; a prompt sent while it runs is steered into the turn,
 *   and the reply says what was added ("Worked. Also: ...");
 * - `slow`: a chunk, then nothing until abort;
 * - `fail`: an error event and a turn that failed;
 * - `select`, `confirm`, `input`, `editor`: an extension dialog, answered (or cancelled) by the
 *   client, then a message saying what it got;
 * - `notify`: an extension notification;
 * - `status` and `status-clear`: setStatus with and without a text;
 * - `widget` and `widget-clear`: setWidget with and without lines;
 * - `title`: setTitle; `editor-text`: set_editor_text;
 * - anything else: "You said: <text>".
 *
 * With `--log <path>` every message it reads is appended there, after a first line naming its own
 * arguments. With `--session <path>` it opens that session file instead of making one. A session
 * made is `<timestamp>_pi-<n>.jsonl` under the folder pi uses for the working directory; a
 * `session_info` entry names it after `set_session_name`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const logAt = process.argv.indexOf("--log");
const log = logAt >= 0 ? process.argv[logAt + 1] : "";
const sessionAt = process.argv.indexOf("--session");
const givenSession = sessionAt >= 0 ? process.argv[sessionAt + 1] : "";

if (log.length > 0) appendFileSync(log, JSON.stringify({ type: "argv", args: process.argv.slice(2) }) + "\n");

const cwd = process.cwd();
const safe = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
const dir = join(homedir(), ".pi", "agent", "sessions", "--" + safe + "--");
mkdirSync(dir, { recursive: true });

const append = (path, value) => appendFileSync(path, JSON.stringify(value) + "\n");

const model = (id) => ({ id, name: "fake/" + id, provider: "fake", api: "fake", reasoning: true, contextWindow: 100000, maxTokens: 8000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } });
const state = {
  sessionId: "",
  sessionFile: "",
  model: model("small"),
  thinkingLevel: "default",
  sessionName: "",
  isStreaming: false,
};

const startSession = () => {
  if (givenSession.length > 0 && existsSync(givenSession)) {
    const first = readFileSync(givenSession, "utf8").split("\n")[0];
    const header = JSON.parse(first);
    state.sessionId = String(header.id);
    state.sessionFile = givenSession;
    return;
  }
  const existing = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  const n = existing.length + 1;
  state.sessionId = "pi-" + String(n);
  const when = new Date();
  state.sessionFile = join(dir, when.toISOString().replace(/[:.]/g, "-") + "_" + state.sessionId + ".jsonl");
  append(state.sessionFile, { type: "session", version: 3, id: state.sessionId, timestamp: when.toISOString(), cwd });
};
startSession();

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const respond = (id, command, data, error) => {
  const m = { id, type: "response", command };
  if (error !== undefined) {
    m.success = false;
    m.error = error;
  } else {
    m.success = true;
    if (data !== undefined) m.data = data;
  }
  out(m);
};
const event = (m) => out(m);
const usage = () => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
const textEvent = (kind, text) => textChunks(kind, [text]);
const textChunks = (kind, chunks) => {
  const contentIndex = 0;
  out({ type: "message_update", usage: usage(), assistantMessageEvent: { type: kind + "_start", contentIndex } });
  for (const delta of chunks) out({ type: "message_update", usage: usage(), assistantMessageEvent: { type: kind + "_delta", contentIndex, delta } });
  out({ type: "message_update", usage: usage(), assistantMessageEvent: { type: kind + "_end", contentIndex, content: chunks.join("") } });
};
const message = (text) => event({ type: "message_start", message: { role: "assistant", content: [], usage: usage(), timestamp: Date.now() } }) || out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: usage(), timestamp: Date.now() } });
const settle = (aborted = false) => {
  state.isStreaming = false;
  event({ type: "agent_end", messages: [], willRetry: false });
  event({ type: "agent_settled", aborted });
};
const userEntry = (text) => append(state.sessionFile, { type: "message", id: "u" + String(Date.now()), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: text, timestamp: Date.now() } });

const dialogs = new Map();
let working = null;
const askDialog = (request, then) => {
  dialogs.set(request.id, then);
  out(request);
};

const run = (text) => {
  const words = text.trim();
  const first = words.split(/\s+/)[0];
  event({ type: "agent_start" });
  if (first === "hello") {
    textEvent("thinking", "Thinking about it.");
    textChunks("text", ["Hello, ", "world."]);
    message("Hello, world.");
    settle();
  } else if (first === "run") {
    const args = { command: "ls -1" };
    event({ type: "tool_execution_start", toolCallId: "call_run", toolName: "bash", args });
    event({ type: "tool_execution_end", toolCallId: "call_run", toolName: "bash", result: { content: [{ type: "text", text: "a.txt\nb.txt" }], details: {} }, isError: false, durationMs: 5 });
    textEvent("text", "Two files.");
    message("Two files.");
    settle();
  } else if (first === "edit") {
    const args = { path: "a.txt", edits: [{ oldText: "one", newText: "one\ntwo" }] };
    event({ type: "tool_execution_start", toolCallId: "call_edit", toolName: "edit", args });
    const patch = "@@ -1,1 +1,2 @@\n-one\n+one\n+two";
    event({ type: "tool_execution_end", toolCallId: "call_edit", toolName: "edit", result: { content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.txt." }], details: { diff: "-one\n+one\n+two", patch, firstChangedLine: 1 } }, isError: false, durationMs: 5 });
    textEvent("text", "Edited.");
    message("Edited.");
    settle();
  } else if (first === "work") {
    working = { also: [], timer: null };
    event({ type: "tool_execution_start", toolCallId: "call_work", toolName: "bash", args: { command: "sleep 1" } });
    working.timer = setTimeout(() => {
      const w = working;
      working = null;
      event({ type: "tool_execution_end", toolCallId: "call_work", toolName: "bash", result: { content: [{ type: "text", text: "" }], details: {} }, isError: false, durationMs: 400 });
      textEvent("text", "Worked." + (w !== null && w.also.length > 0 ? " Also: " + w.also.join(" | ") : ""));
      settle();
    }, 400);
  } else if (first === "slow") {
    textEvent("text", "Working…");
  } else if (first === "fail") {
    out({ type: "message_update", usage: usage(), assistantMessageEvent: { type: "error", reason: "error", error: { role: "assistant", content: [], usage: usage(), stopReason: "error", errorMessage: "model unavailable", timestamp: Date.now() } } });
    settle();
  } else if (first === "select") {
    askDialog({ type: "extension_ui_request", id: "ui-select", method: "select", title: "Pick one", options: ["Allow", "Block"] }, (response) => {
      textEvent("text", response.cancelled ? "Select cancelled" : "Selected: " + response.value);
      settle();
    });
  } else if (first === "confirm") {
    askDialog({ type: "extension_ui_request", id: "ui-confirm", method: "confirm", title: "Clear it?", message: "All messages will be lost." }, (response) => {
      textEvent("text", response.cancelled ? "Confirm cancelled" : "Confirmed: " + String(response.confirmed));
      settle();
    });
  } else if (first === "input") {
    askDialog({ type: "extension_ui_request", id: "ui-input", method: "input", title: "Enter a value", placeholder: "type something" }, (response) => {
      textEvent("text", response.cancelled ? "Input cancelled" : "Input: " + response.value);
      settle();
    });
  } else if (first === "editor") {
    askDialog({ type: "extension_ui_request", id: "ui-editor", method: "editor", title: "Edit some text", prefill: "Line 1\nLine 2" }, (response) => {
      textEvent("text", response.cancelled ? "Editor cancelled" : "Editor: " + response.value);
      settle();
    });
  } else if (first === "notify") {
    out({ type: "extension_ui_request", id: "ui-notify", method: "notify", message: "pi says hi", notifyType: "info" });
    textEvent("text", "Notified.");
    settle();
  } else if (first === "status") {
    out({ type: "extension_ui_request", id: "ui-status", method: "setStatus", statusKey: "pi-test", statusText: "busy" });
    textEvent("text", "Status set.");
    settle();
  } else if (first === "status-clear") {
    out({ type: "extension_ui_request", id: "ui-status-clear", method: "setStatus", statusKey: "pi-test", statusText: undefined });
    textEvent("text", "Status cleared.");
    settle();
  } else if (first === "widget") {
    out({ type: "extension_ui_request", id: "ui-widget", method: "setWidget", widgetKey: "pi-widget", widgetLines: ["line one", "line two"], widgetPlacement: "aboveEditor" });
    textEvent("text", "Widget set.");
    settle();
  } else if (first === "widget-clear") {
    out({ type: "extension_ui_request", id: "ui-widget-clear", method: "setWidget", widgetKey: "pi-widget", widgetLines: undefined });
    textEvent("text", "Widget cleared.");
    settle();
  } else if (first === "title") {
    out({ type: "extension_ui_request", id: "ui-title", method: "setTitle", title: "pi session" });
    textEvent("text", "Title set.");
    settle();
  } else if (first === "editor-text") {
    out({ type: "extension_ui_request", id: "ui-editor-text", method: "set_editor_text", text: "draft from pi" });
    textEvent("text", "Editor text set.");
    settle();
  } else {
    textEvent("text", "You said: " + words);
    settle();
  }
};

const prompt = (id, p) => {
  if (state.isStreaming) {
    if (p.streamingBehavior !== "steer" && p.streamingBehavior !== "followUp") return respond(id, "prompt", undefined, "streaming: pass a streamingBehavior");
    if (working !== null) working.also.push(p.message);
    return respond(id, "prompt", { disposition: "queued" });
  }
  state.isStreaming = true;
  userEntry(p.message);
  respond(id, "prompt", { disposition: "started" });
  run(p.message);
};

const handle = (m) => {
  if (log.length > 0) appendFileSync(log, JSON.stringify(m) + "\n");
  if (m.type === "extension_ui_response") {
    const then = dialogs.get(m.id);
    if (then !== undefined) {
      dialogs.delete(m.id);
      then(m);
    }
    return;
  }
  const id = m.id;
  if (m.type === "get_state") {
    respond(id, "get_state", { model: state.model, thinkingLevel: state.thinkingLevel, isStreaming: state.isStreaming, isCompacting: false, steeringMode: "all", followUpMode: "all", sessionFile: state.sessionFile, sessionId: state.sessionId, sessionName: state.sessionName, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 });
  } else if (m.type === "get_available_models") {
    respond(id, "get_available_models", { models: [model("small"), model("large")] });
  } else if (m.type === "get_available_thinking_levels") {
    respond(id, "get_available_thinking_levels", { levels: ["low", "high", "default"] });
  } else if (m.type === "get_commands") {
    respond(id, "get_commands", { commands: [{ name: "init", description: "write AGENTS.md", source: "extension" }, { name: "review", description: "review the changes", source: "prompt" }, { name: "skill:alpha", description: "the alpha skill", source: "skill" }] });
  } else if (m.type === "set_model") {
    if (m.provider !== "fake" || !["small", "large"].includes(m.modelId)) respond(id, "set_model", undefined, "Model not found: " + m.provider + "/" + m.modelId);
    else {
      state.model = model(m.modelId);
      append(state.sessionFile, { type: "model_change", id: "m" + String(Date.now()), parentId: null, timestamp: new Date().toISOString(), provider: m.provider, modelId: m.modelId });
      respond(id, "set_model", state.model);
    }
  } else if (m.type === "set_thinking_level") {
    if (!["low", "high", "default"].includes(m.level)) respond(id, "set_thinking_level", undefined, "no level " + m.level);
    else {
      state.thinkingLevel = m.level;
      event({ type: "thinking_level_changed", level: m.level });
      respond(id, "set_thinking_level");
    }
  } else if (m.type === "prompt") prompt(id, m);
  else if (m.type === "abort") {
    if (working !== null) {
      clearTimeout(working.timer);
      working = null;
    }
    respond(id, "abort");
    if (state.isStreaming) {
      state.isStreaming = false;
      event({ type: "agent_end", messages: [], willRetry: false });
      event({ type: "agent_settled", aborted: true });
    }
  } else if (m.type === "new_session") {
    state.sessionId = "";
    state.sessionFile = "";
    startSession();
    respond(id, "new_session", { cancelled: false });
  } else if (m.type === "switch_session") {
    const header = JSON.parse(readFileSync(m.sessionPath, "utf8").split("\n")[0]);
    state.sessionId = String(header.id);
    state.sessionFile = m.sessionPath;
    respond(id, "switch_session", { cancelled: false });
  } else if (m.type === "set_session_name") {
    state.sessionName = String(m.name);
    append(state.sessionFile, { type: "session_info", id: "s" + String(Date.now()), parentId: null, timestamp: new Date().toISOString(), name: state.sessionName });
    event({ type: "session_info_changed", name: state.sessionName });
    respond(id, "set_session_name");
  } else if (m.type === "compact") {
    event({ type: "compaction_start", reason: "manual" });
    event({ type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false });
    respond(id, "compact", {});
  } else if (m.type === "get_messages") {
    respond(id, "get_messages", { messages: [] });
  } else if (m.type === "get_session_stats") {
    respond(id, "get_session_stats", {});
  } else {
    respond(id, m.type, undefined, "Unknown command: " + m.type);
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
    if (line.length > 0) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
