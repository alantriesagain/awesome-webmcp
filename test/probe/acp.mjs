/**
 * @file The ACP probe: drives a real ACP agent (`opencode acp` by default) through the scenarios
 * the acp plugin relies on, in a fresh temporary git repository, and records every line in both
 * directions to `test/fixtures/acp-<agent>.ndjson` as
 * `{"dir":"out"|"in","t":ms,"raw":"<line>"}` (the repository's path written as /tmp/PROJECT, the
 * home folder as ~), with what it observed in `acp-<agent>.notes.txt`. It talks to a model, so it
 * runs only with LIGHTCODE_LIVE=1, on the model named by --model, else a free one (opencode's
 * big-pickle, or one whose id says free; the list is printed).
 *
 * Scenarios, one process: a plain turn; a bash call; an edit; a cancel during a long bash call;
 * session/list; then a second process loading the first session (its replay). Permissions asked
 * are allowed once. Last, the agent's own session listing (`--sessions`, default
 * `opencode session list --format json`).
 *
 * Usage: LIGHTCODE_LIVE=1 node test/probe/acp.mjs [--agent opencode] [--command "opencode acp"]
 *        [--sessions "opencode session list --format json"] [--model <provider/model>] [--models]
 * With --models it prints the agent's models and modes and stops (no prompt is sent).
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.LIGHTCODE_LIVE !== "1") {
  console.log("skip: the ACP probe talks to a model (set LIGHTCODE_LIVE=1)");
  process.exit(0);
}
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] ?? fallback : fallback;
};
const agent = option("agent", "opencode");
const command = option("command", "opencode acp").split(" ");
const sessionsCommand = option("sessions", "opencode session list --format json");
const wanted = option("model", "");

const repo = mkdtempSync(join(tmpdir(), "acp-probe-"));
const git = (/** @type {string[]} */ ...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "probe@example.com");
git("config", "user.name", "probe");
writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\ngamma\n");
git("add", ".");
git("commit", "-qm", "start");

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

/** @type {{ dir: string, t: number, raw: string }[]} */
const record = [];
/** @type {string[]} */
const notes = [];
const t0 = Date.now();
const scrub = (/** @type {string} */ s) => s.split(repo).join("/tmp/PROJECT").split(homedir()).join("~");
const note = (/** @type {string} */ text) => {
  notes.push(text);
  console.log(text);
};

/** One agent process: requests answered by promise, updates and requests from it to `onMessage`. */
const start = () => {
  const child = spawn(command[0], command.slice(1), { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let seq = 0;
  /** @type {Map<number, (m: any) => void>} */
  const answers = new Map();
  /** @type {(m: any) => void} */
  let onMessage = () => {};
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim().length === 0) continue;
      record.push({ dir: "in", t: Date.now() - t0, raw: scrub(line) });
      const m = JSON.parse(line);
      if (m.method === undefined && answers.has(m.id)) {
        const then = answers.get(m.id);
        answers.delete(m.id);
        then?.(m);
      } else onMessage(m);
    }
  });
  child.stderr.on("data", () => {});
  const write = (/** @type {object} */ m) => {
    const line = JSON.stringify({ jsonrpc: "2.0", ...m });
    record.push({ dir: "out", t: Date.now() - t0, raw: scrub(line) });
    child.stdin.write(line + "\n");
  };
  return {
    child,
    write,
    /** @param {(m: any) => void} f */
    listen: (f) => {
      onMessage = f;
    },
    /** @param {string} method @param {object} params @returns {Promise<any>} */
    call: (method, params) =>
      new Promise((resolve) => {
        const id = ++seq;
        answers.set(id, resolve);
        write({ id, method, params });
      }),
  };
};

/** Allow a permission once; note every update kind seen. */
const kinds = new Set();
const handle = (/** @type {ReturnType<typeof start>} */ a) => (/** @type {any} */ m) => {
  if (m.method === "session/update") kinds.add(m.params.update.sessionUpdate);
  else if (m.method === "session/request_permission") {
    note("permission asked: " + m.params.toolCall.title + " options " + m.params.options.map((/** @type {any} */ o) => o.optionId).join(","));
    a.write({ id: m.id, result: { outcome: { outcome: "selected", optionId: "once" } } });
  } else if (m.id !== undefined && m.method !== undefined) {
    note("request from the agent: " + m.method);
    a.write({ id: m.id, error: { code: -32601, message: "not offered" } });
  }
};

const init = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "lightcode-probe", version: "1" } };
const a = start();
a.listen(handle(a));
const hello = await a.call("initialize", init);
note("initialize: " + JSON.stringify(hello.result?.agentCapabilities));
const made = await a.call("session/new", { cwd: repo, mcpServers: [] });
if (made.error !== undefined) {
  note("session/new failed: " + JSON.stringify(made.error));
  process.exit(1);
}
const sessionId = made.result.sessionId;
/** A config option's values (groups flattened), or the older lists. */
const values = (/** @type {any[]} */ options) => options.flatMap((/** @type {any} */ o) => (typeof o.value === "string" ? [o.value] : values(o.options ?? [])));
const option_ = (/** @type {string} */ category) => (made.result.configOptions ?? []).find((/** @type {any} */ o) => o.category === category);
const models = option_("model") ? values(option_("model").options) : (made.result.models?.availableModels ?? []).map((/** @type {any} */ m) => m.modelId);
note("models (" + String(models.length) + "): " + models.slice(0, 12).join(", ") + (models.length > 12 ? ", …" : ""));
note("modes: " + (option_("mode") ? values(option_("mode").options) : (made.result.modes?.availableModes ?? []).map((/** @type {any} */ m) => m.id)).join(", "));
note("effort: " + (option_("thought_level") ? values(option_("thought_level").options).join(", ") : "none"));
if (args.includes("--models")) {
  console.log(scrub(JSON.stringify(made.result, null, 1)));
  a.child.stdin.end();
  process.exit(0);
}
const cheap = wanted || models.find((/** @type {string} */ m) => m === "opencode/big-pickle") || models.find((/** @type {string} */ m) => /free/i.test(m)) || "";
if (cheap.length === 0) {
  note("no model named or found that looks cheap: pass --model");
  a.child.kill();
  process.exit(1);
}
const set = option_("model") ? await a.call("session/set_config_option", { sessionId, configId: option_("model").id, value: cheap }) : await a.call("session/set_model", { sessionId, modelId: cheap });
note("model " + cheap + ": " + (set.error !== undefined ? JSON.stringify(set.error) : "set"));

const prompt = async (/** @type {string} */ text) => {
  const r = await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  note("prompt " + JSON.stringify(text.slice(0, 40)) + ": " + JSON.stringify(r.result ?? r.error));
};
await prompt("Reply with exactly the word PONG and nothing else.");
await prompt("Use the bash tool to run exactly: ls -1. Then say done.");
await prompt("Use the edit tool to change the line beta to BETA in notes.txt. Then say done.");
// A cancel once the long call runs.
const long = a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the bash tool to run exactly: sleep 30. Then say done." }] });
let cancelSent = false;
a.listen((m) => {
  handle(a)(m);
  if (cancelSent || m.method !== "session/update" || m.params.update.sessionUpdate !== "tool_call_update" || m.params.update.status !== "in_progress") return;
  cancelSent = true;
  a.write({ method: "session/cancel", params: { sessionId } });
});
const cancelled = await long;
note("cancelled prompt: " + JSON.stringify(cancelled.result ?? cancelled.error));
a.listen(handle(a));
const listed = await a.call("session/list", { cwd: repo });
note("session/list: " + JSON.stringify(listed.result ?? listed.error).slice(0, 300));
a.child.stdin.end();
await new Promise((resolve) => a.child.on("exit", resolve));

// A second process loads the session: its replay.
const b = start();
b.listen(handle(b));
await b.call("initialize", init);
const loaded = await b.call("session/load", { sessionId, cwd: repo, mcpServers: [] });
note("session/load: " + (loaded.error !== undefined ? JSON.stringify(loaded.error) : "ok"));
b.child.stdin.end();
await new Promise((resolve) => b.child.on("exit", resolve));

note("updates seen: " + [...kinds].sort().join(", "));
let own = "";
try {
  own = execSync(sessionsCommand, { cwd: repo, env, encoding: "utf8" });
} catch (err) {
  own = "failed: " + String(err);
}
note("own listing: " + scrub(own).slice(0, 300));
writeFileSync(join(fixtures, `acp-${agent}.ndjson`), record.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(fixtures, `acp-${agent}.notes.txt`), scrub(notes.join("\n")) + "\n");
console.log("recorded " + String(record.length) + " lines to fixtures/acp-" + agent + ".ndjson");
