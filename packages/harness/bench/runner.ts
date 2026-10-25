// One benchmark run: a task's repository copied into a temp folder (a git repository with one
// commit, so the agent sees a project), the agent started there over ACP, the model and effort
// chosen through its config options, the task's prompt sent and the turn followed to its end (or
// cancelled past the task's time), then the task's check run against the folder: it passes or it
// does not. What the run measured goes in one record: the time to the first token and in all, the
// calls by tool and those that failed, the tokens, the context used, the cost the agent reported.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOf, num, objectText, recordOf, str } from "@light/lib/json.ts";
import { AcpClient, AgentNote, RpcReply } from "./acp-client.ts";

/** A task: its name, its prompt, the folder holding `repo/` and `check.mjs`, its time. */
export class BenchTask {
  readonly name: string;
  readonly dir: string;
  prompt = "";
  timeoutMs = 300000;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
  }
}

/** The tasks under `root`, those named in `only` when it names any, by name. */
export const loadTasks = (root: string, only: string[]): BenchTask[] => {
  const out: BenchTask[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (only.length > 0 && !only.includes(name)) continue;
    const file = join(root, name, "task.json");
    if (!existsSync(file)) continue;
    const spec = recordOf(JSON.parse(readFileSync(file, "utf8")));
    if (spec === null) continue;
    const t = new BenchTask(name, join(root, name));
    t.prompt = str(spec["prompt"]);
    t.timeoutMs = num(spec["timeoutMs"], t.timeoutMs);
    out.push(t);
  }
  return out;
};

/** How a run starts the agent and what it asks of it. */
export class RunSpec {
  /** A name for the agent in the records ("harness", "opencode", ...). */
  agent = "";
  command: string[] = [];
  /** Words run in the folder after the run to delete the session, `{session}` its id ([] for none). */
  forget: string[] = [];
  env: Record<string, string> = {};
  /** The model and effort to choose ("" keeps the agent's). */
  model = "";
  effort = "";
  /** Keep the folder after the run, for a look at what the agent did. */
  keep = false;
}

/** What one run measured. */
export class RunResult {
  task = "";
  agent = "";
  model = "";
  effort = "";
  passed = false;
  /** The check's output, cut. */
  checkOutput = "";
  stopReason = "";
  error = "";
  ms = 0;
  firstTokenMs = -1;
  calls = 0;
  failedCalls = 0;
  /** Calls by tool, as "Name=n" pairs in the order first seen. */
  tools: string[] = [];
  inputTokens = 0;
  outputTokens = 0;
  contextUsed = 0;
  costUsd = -1;
  /** The agent's last words. */
  reply = "";
  folder = "";

  line(): string {
    return objectText(
      ["task", "agent", "model", "effort", "passed", "checkOutput", "stopReason", "error", "ms", "firstTokenMs", "calls", "failedCalls", "tools", "inputTokens", "outputTokens", "contextUsed", "costUsd", "reply", "folder"],
      [JSON.stringify(this.task), JSON.stringify(this.agent), JSON.stringify(this.model), JSON.stringify(this.effort), this.passed ? "true" : "false", JSON.stringify(this.checkOutput), JSON.stringify(this.stopReason), JSON.stringify(this.error), String(this.ms), String(this.firstTokenMs), String(this.calls), String(this.failedCalls), "[" + this.tools.map((t) => JSON.stringify(t)).join(",") + "]", String(this.inputTokens), String(this.outputTokens), String(this.contextUsed), String(this.costUsd), JSON.stringify(this.reply), JSON.stringify(this.folder)],
    );
  }

  static parse(text: string): RunResult | null {
    let v: unknown = null;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
    const r = recordOf(v);
    if (r === null) return null;
    const o = new RunResult();
    o.task = str(r["task"]);
    o.agent = str(r["agent"]);
    o.model = str(r["model"]);
    o.effort = str(r["effort"]);
    o.passed = r["passed"] === true;
    o.checkOutput = str(r["checkOutput"]);
    o.stopReason = str(r["stopReason"]);
    o.error = str(r["error"]);
    o.ms = num(r["ms"], 0);
    o.firstTokenMs = num(r["firstTokenMs"], -1);
    o.calls = num(r["calls"], 0);
    o.failedCalls = num(r["failedCalls"], 0);
    for (const t of listOf(r["tools"])) o.tools.push(str(t));
    o.inputTokens = num(r["inputTokens"], 0);
    o.outputTokens = num(r["outputTokens"], 0);
    o.contextUsed = num(r["contextUsed"], 0);
    o.costUsd = num(r["costUsd"], -1);
    o.reply = str(r["reply"]);
    o.folder = str(r["folder"]);
    return o;
  }
}

const git = (dir: string, args: string[]): void => {
  spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
};

/** The option of `category` among a session's config options (JSON text of the answer): its id and its values. */
const optionOf = (resultJson: string, category: string): { id: string; values: string[]; current: string } | null => {
  const r = recordOf(JSON.parse(resultJson));
  for (const v of listOf(r !== null ? r["configOptions"] : null)) {
    const o = recordOf(v);
    if (o === null || str(o["category"]) !== category) continue;
    const values: string[] = [];
    for (const g of listOf(o["options"])) {
      const opt = recordOf(g);
      if (opt === null) continue;
      if (str(opt["value"]).length > 0) values.push(str(opt["value"]));
      for (const inner of listOf(opt["options"])) {
        const io = recordOf(inner);
        if (io !== null && str(io["value"]).length > 0) values.push(str(io["value"]));
      }
    }
    return { id: str(o["id"]), values, current: str(o["currentValue"]) };
  }
  return null;
};

const delay = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

/** The answer of `p`, or a timeout's after `ms`. */
const within = (p: Promise<RpcReply>, ms: number): Promise<RpcReply> =>
  new Promise<RpcReply>((settle) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const r = new RpcReply();
      r.error = "timed out";
      settle(r);
    }, ms);
    p.then((r: RpcReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(r);
    });
  });

/** Run `task` with `spec`. */
export const runTask = async (task: BenchTask, spec: RunSpec): Promise<RunResult> => {
  const result = new RunResult();
  result.task = task.name;
  result.agent = spec.agent;
  result.model = spec.model;
  result.effort = spec.effort;
  const work = mkdtempSync(join(tmpdir(), "harness-bench-" + task.name + "-"));
  result.folder = work;
  cpSync(join(task.dir, "repo"), work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["add", "-A"]);
  git(work, ["-c", "user.email=bench@widecode", "-c", "user.name=bench", "commit", "-qm", "the task"]);
  const client = new AcpClient();
  const started = Date.now();
  const seen = new Map<string, number>();
  const order: string[] = [];
  const replyParts: string[] = [];
  let sessionId = "";
  client.onNote = (n: AgentNote) => {
    if (n.method !== "session/update") return;
    const u = recordOf(n.params["update"]);
    if (u === null) return;
    const kind = str(u["sessionUpdate"]);
    if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && result.firstTokenMs < 0) result.firstTokenMs = Date.now() - started;
    if (kind === "agent_message_chunk") {
      const c = recordOf(u["content"]);
      if (c !== null) replyParts.push(str(c["text"]));
    } else if (kind === "tool_call") {
      result.calls++;
      const title = str(u["title"]).length > 0 ? str(u["title"]) : "?";
      if (!seen.has(title)) order.push(title);
      seen.set(title, (seen.get(title) ?? 0) + 1);
      if (str(u["status"]) === "failed") result.failedCalls++;
    } else if (kind === "tool_call_update" && str(u["status"]) === "failed") result.failedCalls++;
    else if (kind === "usage_update") {
      const used = num(u["used"], -1);
      if (used > 0) result.contextUsed = used;
      const cost = recordOf(u["cost"]);
      if (cost !== null && typeof cost["amount"] === "number") result.costUsd = cost["amount"] as number;
    }
  };
  client.start(spec.command, work, spec.env);
  const finish = async (): Promise<RunResult> => {
    result.ms = Date.now() - started;
    result.tools = order.map((t) => t + "=" + String(seen.get(t) ?? 0));
    result.reply = replyParts.join("").trim().slice(-600);
    const check = spawnSync("node", [join(task.dir, "check.mjs")], { cwd: work, encoding: "utf8", timeout: 60000 });
    result.passed = check.status === 0;
    result.checkOutput = ((check.stdout ?? "") + (check.stderr ?? "")).trim().slice(0, 600);
    if (sessionId.length > 0 && spec.forget.length > 0) {
      const words = spec.forget.map((w) => w.split("{session}").join(sessionId));
      spawnSync(words[0], words.slice(1), { cwd: work, stdio: "ignore", timeout: 15000 });
    }
    client.stop();
    await delay(200);
    if (!spec.keep) rmSync(work, { recursive: true, force: true });
    return result;
  };
  const init = await within(client.request("initialize", '{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}'), 30000);
  if (init.error.length > 0) {
    result.error = "initialize: " + init.error + (client.stderr.length > 0 ? " | " + client.stderr.trim().slice(-300) : "");
    return finish();
  }
  const made = await within(client.request("session/new", '{"cwd":' + JSON.stringify(work) + ',"mcpServers":[]}'), 30000);
  if (made.error.length > 0) {
    result.error = "session/new: " + made.error;
    return finish();
  }
  sessionId = str(recordOf(JSON.parse(made.resultJson))?.["sessionId"]);
  // The model, then the effort, through the session's config options (the effort's values depend on the model).
  const choose = async (category: string, wanted: string): Promise<string> => {
    if (wanted.length === 0) return "";
    const opt = optionOf(made.resultJson, category);
    if (opt === null) return "the agent offers no " + category + " option";
    if (opt.current === wanted) return "";
    if (category === "model" && !opt.values.includes(wanted)) return "no model " + wanted + " here; the agent offers " + opt.values.slice(0, 40).join(", ");
    const set = await within(client.request("session/set_config_option", '{"sessionId":' + JSON.stringify(sessionId) + ',"configId":' + JSON.stringify(opt.id) + ',"value":' + JSON.stringify(wanted) + "}"), 30000);
    if (set.error.length > 0) return "set " + category + ": " + set.error;
    made.resultJson = set.resultJson;
    return "";
  };
  const modelError = await choose("model", spec.model);
  const effortError = modelError.length > 0 ? "" : await choose("thought_level", spec.effort);
  if (modelError.length > 0 || effortError.length > 0) {
    result.error = modelError.length > 0 ? modelError : effortError;
    return finish();
  }
  const turn = await within(client.request("session/prompt", '{"sessionId":' + JSON.stringify(sessionId) + ',"prompt":[{"type":"text","text":' + JSON.stringify(task.prompt) + "}]}"), task.timeoutMs);
  if (turn.error === "timed out") {
    client.notify("session/cancel", '{"sessionId":' + JSON.stringify(sessionId) + "}");
    result.error = "the turn took longer than " + String(Math.round(task.timeoutMs / 1000)) + " s";
    result.stopReason = "timeout";
    await delay(3000);
    return finish();
  }
  if (turn.error.length > 0) {
    result.error = turn.error;
    result.stopReason = "error";
    return finish();
  }
  const answer = recordOf(JSON.parse(turn.resultJson));
  result.stopReason = answer !== null ? str(answer["stopReason"]) : "";
  const usage = answer !== null ? recordOf(answer["usage"]) : null;
  if (usage !== null) {
    result.inputTokens = num(usage["inputTokens"], 0);
    result.outputTokens = num(usage["outputTokens"], 0);
  }
  return finish();
};
