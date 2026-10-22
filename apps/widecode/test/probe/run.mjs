/**
 * @file The M0 protocol probe: drives the real `claude` CLI in print mode with stream-json through
 * one scenario in a fresh temporary git repository, answers its host prompts the way the
 * scenario says, and records every line in both directions to
 * `test/fixtures/<scenario>.ndjson` as `{"dir":"out"|"in","t":ms,"raw":"<line>"}`.
 * Prints what the scenario observed. Costs a few cheap model turns per scenario.
 *
 * Usage: node test/probe/run.mjs <scenario> [--model haiku] [--effort low]
 * Scenarios: turn, edit, ask, ask-multi, plan, interrupt, model, image, atfile, subagent,
 * protected, resume, midturn, midtool, compact.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const args = process.argv.slice(2);
const scenario = args[0] ?? "turn";
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] ?? fallback : fallback;
};
const model = option("model", "haiku");
const effort = option("effort", "low");
const claudeBin = [option("claude", ""), join(homedir(), ".local", "bin", "claude")].find((p) => p && existsSync(p)) ?? "claude";

const repo = mkdtempSync(join(tmpdir(), "code-probe-"));
const git = (/** @type {string[]} */ ...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "probe@example.com");
git("config", "user.name", "probe");
writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\ngamma\n");
writeFileSync(join(repo, "README.md"), "# probe\n\nA scratch repository.\n");
git("add", ".");
git("commit", "-qm", "start");

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

/** @type {{ dir: string, t: number, raw: string }[]} */
const record = [];
const t0 = Date.now();
/** @type {string[]} */
const notes = [];
const note = (/** @type {string} */ text) => {
  notes.push(text);
  console.log("  " + text);
};

/**
 * @param {string[]} extra
 */
const launch = (extra) => {
  const flags = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--forward-subagent-text",
    "--permission-mode", "bypassPermissions", "--permission-prompt-tool", "stdio",
    "--model", model, "--effort", effort, ...extra,
  ];
  const child = spawn(claudeBin, flags, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  /** @type {((msg: any) => void)[]} */
  const listeners = [];
  /** @type {any[]} */
  const seen = [];
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      record.push({ dir: "out", t: Date.now() - t0, raw: line });
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        note("non-JSON line: " + line.slice(0, 120));
        continue;
      }
      seen.push(msg);
      for (const fn of listeners.slice()) fn(msg);
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  /** @param {object} obj */
  const write = (obj) => {
    const line = JSON.stringify(obj);
    record.push({ dir: "in", t: Date.now() - t0, raw: line });
    child.stdin.write(line + "\n");
  };
  /**
   * @param {(msg: any) => boolean} pred
   * @param {number} [ms]
   * @returns {Promise<any>}
   */
  const waitFor = (pred, ms = 120000) =>
    new Promise((resolve, reject) => {
      const hit = seen.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error("timeout waiting")), ms);
      const fn = (/** @type {any} */ msg) => {
        if (!pred(msg)) return;
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(fn), 1);
        resolve(msg);
      };
      listeners.push(fn);
    });
  let nextId = 1;
  /**
   * @param {string} subtype
   * @param {object} [extra]
   */
  const control = async (subtype, extra = {}) => {
    const id = `probe-${nextId++}`;
    write({ type: "control_request", request_id: id, request: { subtype, ...extra } });
    return waitFor((m) => m.type === "control_response" && m.response?.request_id === id, 30000);
  };
  /** @param {string | object[]} content */
  const say = (content) =>
    write({ type: "user", session_id: "", message: { role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content }, parent_tool_use_id: null });
  /** @param {any} req @param {object} response */
  const answer = (req, response) => write({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } });
  const results = () => seen.filter((m) => m.type === "result");
  /** @param {number} n */
  const waitResults = (n, ms = 180000) => waitFor(() => results().length >= n, ms);
  /** @param {(req: any) => void} fn */
  const onRequest = (fn) => listeners.push((m) => {
    if (m.type === "control_request") fn(m);
  });
  const end = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
    const r = await exited;
    clearTimeout(timer);
    return r;
  };
  return { child, write, say, control, answer, waitFor, waitResults, onRequest, results, seen, end, exited, stderr: () => stderr };
};

/** Default host: allow anything with its own input, noting what asked. */
const allowAll = (/** @type {ReturnType<typeof launch>} */ s) =>
  s.onRequest((req) => {
    const r = req.request;
    if (r.subtype !== "can_use_tool") return;
    note(`can_use_tool ${r.tool_name}${r.decision_reason ? " (" + r.decision_reason + ")" : ""} → allow`);
    s.answer(req, { behavior: "allow", updatedInput: r.input });
  });

const summarize = (/** @type {ReturnType<typeof launch>} */ s) => {
  const init = s.seen.find((m) => m.type === "system" && m.subtype === "init");
  if (init) note(`init: session ${init.session_id}, model ${init.model}, permissionMode ${init.permissionMode}, AskUserQuestion in tools: ${init.tools.includes("AskUserQuestion")}, ExitPlanMode in tools: ${init.tools.includes("ExitPlanMode")}`);
  for (const r of s.results()) note(`result: ${r.subtype}, terminal_reason ${r.terminal_reason}, turns ${r.num_turns}, cost ${r.total_cost_usd}, denials ${JSON.stringify(r.permission_denials ?? [])}`);
  const types = new Map();
  for (const m of s.seen) {
    const k = m.type === "stream_event" ? `stream_event/${m.event?.type}${m.parent_tool_use_id ? " (sub)" : ""}` : `${m.type}${m.subtype ? "/" + m.subtype : ""}${m.parent_tool_use_id ? " (sub)" : ""}`;
    types.set(k, (types.get(k) ?? 0) + 1);
  }
  note("types: " + [...types].map(([k, n]) => `${k}×${n}`).join(", "));
  const biggest = record.filter((r) => r.dir === "out").reduce((a, r) => Math.max(a, r.raw.length), 0);
  note(`largest stdout line: ${biggest} bytes`);
};

const scenarios = {
  async turn() {
    const s = launch([]);
    allowAll(s);
    s.say("Reply with exactly the word PONG and nothing else.");
    await s.waitResults(1);
    summarize(s);
    return s;
  },
  async edit() {
    const s = launch([]);
    allowAll(s);
    s.say("Create a file called list.txt containing the lines one, two, three (one per line) with the Write tool, then use the Edit tool to change two into TWO. Then say done.");
    await s.waitResults(1);
    const tools = s.seen.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((c) => c.type === "tool_use").map((c) => c.name);
    note("tool calls: " + tools.join(", "));
    const results = s.seen.filter((m) => m.type === "user").map((m) => Object.keys(m.tool_use_result ?? {}).join("|"));
    note("tool_use_result keys: " + results.join(" ; "));
    summarize(s);
    return s;
  },
  async ask() {
    const s = launch([]);
    s.onRequest((req) => {
      const r = req.request;
      if (r.subtype !== "can_use_tool") return;
      if (r.tool_name === "AskUserQuestion") {
        note("AskUserQuestion request: " + JSON.stringify(r).slice(0, 600));
        const q = r.input.questions[0];
        s.answer(req, { behavior: "allow", updatedInput: { ...r.input, answers: { [q.question]: q.options[1].label } } });
        note("answered: " + q.options[1].label);
        return;
      }
      note(`can_use_tool ${r.tool_name} → allow`);
      s.answer(req, { behavior: "allow", updatedInput: r.input });
    });
    s.say("Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with just the color I chose.");
    await s.waitResults(1);
    const last = s.results().at(-1);
    note("final text: " + (last?.result ?? "").slice(0, 200));
    summarize(s);
    return s;
  },
  async "ask-multi"() {
    const s = launch([]);
    s.onRequest((req) => {
      const r = req.request;
      if (r.subtype !== "can_use_tool") return;
      if (r.tool_name === "AskUserQuestion") {
        note("AskUserQuestion input: " + JSON.stringify(r.input).slice(0, 800));
        /** @type {Record<string, unknown>} */
        const answers = {};
        for (const q of r.input.questions) answers[q.question] = q.multiSelect ? q.options.slice(0, 2).map((o) => o.label) : "my own words: purple";
        s.answer(req, { behavior: "allow", updatedInput: { ...r.input, answers } });
        note("answered: " + JSON.stringify(answers));
        return;
      }
      s.answer(req, { behavior: "allow", updatedInput: r.input });
    });
    s.say("Use the AskUserQuestion tool once with two questions: first, which fruits I like (multiSelect true, options Apple, Pear, Plum); second, my favourite color (options Red, Blue). Then repeat my answers back in one line.");
    await s.waitResults(1);
    note("final text: " + (s.results().at(-1)?.result ?? "").slice(0, 300));
    summarize(s);
    return s;
  },
  async plan() {
    const s = launch([]);
    s.onRequest((req) => {
      const r = req.request;
      if (r.subtype !== "can_use_tool") return;
      if (r.tool_name === "ExitPlanMode") {
        note("ExitPlanMode request: " + JSON.stringify(r).slice(0, 500));
        s.answer(req, { behavior: "allow", updatedInput: r.input, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
        note("approved with setMode bypassPermissions");
        return;
      }
      note(`can_use_tool ${r.tool_name} → allow`);
      s.answer(req, { behavior: "allow", updatedInput: r.input });
    });
    const r1 = await s.control("set_permission_mode", { mode: "plan" });
    note("set_permission_mode plan → " + JSON.stringify(r1.response));
    s.say("Plan how to add a line 'delta' to notes.txt. Keep the plan to two sentences, then present it with ExitPlanMode. After approval, make the change and say done.");
    await s.waitResults(1);
    const modes = s.seen.filter((m) => m.type === "system" && (m.permissionMode || m.subtype === "status")).map((m) => `${m.subtype}:${m.permissionMode ?? m.status ?? ""}`);
    note("mode signals: " + modes.join(", "));
    const { readFileSync } = await import("node:fs");
    note("notes.txt now: " + JSON.stringify(readFileSync(join(repo, "notes.txt"), "utf8")));
    summarize(s);
    return s;
  },
  async interrupt() {
    const s = launch([]);
    allowAll(s);
    s.say("Run the shell command `sleep 30` with the Bash tool, then say finished.");
    await s.waitFor((m) => m.type === "assistant" && m.message.content.some((c) => c.type === "tool_use" && c.name === "Bash"));
    await new Promise((r) => setTimeout(r, 1500));
    const ack = await s.control("interrupt");
    note("interrupt ack: " + JSON.stringify(ack.response));
    await s.waitResults(1, 60000);
    note("process alive after interrupt: " + (s.child.exitCode === null));
    s.say("Reply with exactly OK.");
    await s.waitResults(2, 120000);
    note("second turn: " + (s.results()[1]?.result ?? "").slice(0, 80));
    summarize(s);
    return s;
  },
  async model() {
    const s = launch([]);
    allowAll(s);
    s.say("Reply with exactly ONE.");
    await s.waitResults(1);
    const m = await s.control("set_model", { model: "sonnet" });
    note("set_model sonnet → " + JSON.stringify(m.response ?? m));
    const e = await s.control("apply_flag_settings", { settings: { effortLevel: "medium" } }).catch((err) => ({ error: String(err) }));
    note("apply_flag_settings effortLevel → " + JSON.stringify(e.response ?? e).slice(0, 300));
    s.say("Reply with exactly TWO.");
    await s.waitResults(2);
    const models = s.seen.filter((x) => x.type === "assistant").map((x) => x.message.model);
    note("assistant models: " + models.join(", "));
    summarize(s);
    return s;
  },
  async image() {
    const s = launch([]);
    allowAll(s);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
    s.say([{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "What single color fills this image? Answer with one word." }]);
    await s.waitResults(1);
    note("answer: " + (s.results()[0]?.result ?? "").slice(0, 80));
    summarize(s);
    return s;
  },
  async atfile() {
    const s = launch([]);
    allowAll(s);
    s.say("What is the second line of @notes.txt ? Answer with the word only.");
    await s.waitResults(1);
    const tools = s.seen.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((c) => c.type === "tool_use").map((c) => c.name);
    note("tool calls: " + (tools.join(", ") || "none (the mention was expanded or ignored)"));
    note("answer: " + (s.results()[0]?.result ?? "").slice(0, 80));
    summarize(s);
    return s;
  },
  async subagent() {
    const s = launch([]);
    allowAll(s);
    s.say("Use the Agent tool (subagent_type general-purpose) to have a subagent read notes.txt and report its first line. Then tell me what it reported.");
    await s.waitResults(1, 240000);
    const sub = s.seen.filter((m) => m.parent_tool_use_id);
    note(`subagent-tagged messages: ${sub.length}, types: ${[...new Set(sub.map((m) => m.type + (m.event ? "/" + m.event.type : "")))].join(", ")}`);
    summarize(s);
    return s;
  },
  async protected() {
    const s = launch([]);
    allowAll(s);
    s.say("Create the file .claude/settings.json containing exactly {} using the Write tool, then say done.");
    await s.waitResults(1);
    note(".claude/settings.json exists: " + existsSync(join(repo, ".claude", "settings.json")));
    summarize(s);
    return s;
  },
  async resume() {
    const first = launch([]);
    allowAll(first);
    first.say("Remember the word KIWI. Reply with exactly NOTED.");
    await first.waitResults(1);
    const id = first.results()[0].session_id;
    await first.end();
    note("first session: " + id);
    const before = record.length;
    const s = launch(["--resume", id]);
    allowAll(s);
    await new Promise((r) => setTimeout(r, 1500));
    note("lines emitted on resume before any input: " + (record.length - before));
    s.say("What word did I ask you to remember? One word.");
    await s.waitResults(1);
    note("answer: " + (s.results()[0]?.result ?? "").slice(0, 60) + ", session " + s.results()[0]?.session_id);
    summarize(s);
    return s;
  },
  async compact() {
    const s = launch([]);
    allowAll(s);
    s.say("Reply with exactly the word PONG and nothing else.");
    await s.waitResults(1);
    s.say("/compact");
    await s.waitResults(2, 240000);
    const kinds = s.seen.filter((m) => m.type === "system" && (m.subtype === "status" || m.subtype === "compact_boundary")).map((m) => m.subtype + (m.status ? ":" + m.status : "") + (m.compact_metadata ? " " + JSON.stringify(m.compact_metadata) : ""));
    note("compaction records: " + kinds.join(" | "));
    summarize(s);
    return s;
  },
  async midturn() {
    const s = launch(["--replay-user-messages"]);
    allowAll(s);
    s.say("Count from 1 to 40, one number per line.");
    await s.waitFor((m) => m.type === "stream_event" && m.event?.type === "content_block_delta");
    s.say("Also, after that, say the word BANANA.");
    await s.waitResults(1, 180000);
    await s.waitResults(2, 60000).catch(() => note("no second result"));
    const replays = s.seen.filter((m) => m.type === "user" && !m.message?.content?.some?.((c) => c.type === "tool_result"));
    note(`user replays: ${replays.length} ${JSON.stringify(replays.map((r) => Object.keys(r))).slice(0, 300)}`);
    note("results: " + s.results().map((r) => (r.result ?? "").slice(-40).replace(/\n/g, " ")).join(" | "));
    summarize(s);
    return s;
  },
  async midtool() {
    // A message sent while a tool runs: the CLI hands it to the model with the tool's result.
    const s = launch(["--replay-user-messages"]);
    allowAll(s);
    s.say("Run the shell command `sleep 6; echo STEP-ONE` with the Bash tool, then run `echo STEP-TWO` with the Bash tool, then reply DONE.");
    await s.waitFor((m) => m.type === "assistant" && m.message?.content?.some?.((c) => c.type === "tool_use"));
    await new Promise((r) => setTimeout(r, 1000));
    s.say("Also, at the end, say the word BANANA.");
    await s.waitResults(1, 180000);
    await s.waitResults(2, 30000).catch(() => note("no second result"));
    const users = s.seen.filter((m) => m.type === "user" && !m.message?.content?.some?.((c) => c.type === "tool_result"));
    note(`user records without a tool result: ${users.length} ${JSON.stringify(users.map((r) => Object.keys(r))).slice(0, 400)}`);
    const other = s.seen.filter((m) => !["stream_event", "assistant", "user", "result", "system", "rate_limit_event"].includes(m.type));
    note("other record types: " + JSON.stringify(other.map((m) => m.type)));
    note("results: " + s.results().map((r) => (r.result ?? "").slice(-40).replace(/\n/g, " ")).join(" | "));
    summarize(s);
    return s;
  },
};

const run = scenarios[/** @type {keyof typeof scenarios} */ (scenario)];
if (!run) {
  console.error("unknown scenario " + scenario + "; one of " + Object.keys(scenarios).join(", "));
  process.exit(2);
}
console.log(`scenario ${scenario} (model ${model}, effort ${effort}) in ${repo}`);
let failed = false;
try {
  const s = await Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("scenario timeout")), 300000))]);
  const exit = await s.end();
  note("exit: " + JSON.stringify(exit));
  if (s.stderr().trim()) note("stderr: " + s.stderr().trim().slice(0, 300));
} catch (err) {
  failed = true;
  note("FAILED: " + (err instanceof Error ? err.message : String(err)));
}
mkdirSync(fixtures, { recursive: true });
writeFileSync(join(fixtures, `${scenario}.ndjson`), record.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(fixtures, `${scenario}.notes.txt`), notes.join("\n") + "\n");
process.exit(failed ? 1 : 0);
