// One benchmark run: a task's repository copied into a temp folder (a git repository with one
// commit, so the agent sees a project), the agent started there over ACP, the model and effort
// chosen through its config options, the task's prompt sent and the turn followed to its end (or
// cancelled past the task's time), then the task's check run against the folder: it passes or it
// does not. What the run measured goes in one record: the time to the first token and in all, the
// calls by tool and those that failed, the tokens, the context used, the cost the agent reported,
// and the diagnosis the stream gives (the first request's input, the requests, a compaction, the
// peak context), with the cost computed from a price table.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOf, num, objectText, recordOf, str } from "@light/lib/json.ts";
import { HarnessConfig } from "../config.ts";
import { ModelRegistry } from "../model/registry.ts";
import { AcpClient, AgentNote, RpcReply } from "./acp-client.ts";
import { PiClient } from "./pi-client.ts";

/** A model's prices per million tokens (below 0: unknown). */
export class ModelPrice {
  input = -1;
  output = -1;
  cacheRead = -1;

  constructor(input: number, output: number, cacheRead: number) {
    this.input = input;
    this.output = output;
    this.cacheRead = cacheRead;
  }
}

/** What a run costs on a model: its tokens applied to the model's prices. */
export class PriceTable {
  private readonly keys: string[] = [];
  private readonly prices: ModelPrice[] = [];

  /** The price of `key`, replacing one already there. */
  add(key: string, price: ModelPrice): void {
    const at = this.keys.indexOf(key);
    if (at >= 0) this.prices[at] = price;
    else {
      this.keys.push(key);
      this.prices.push(price);
    }
  }

  of(model: string): ModelPrice | null {
    const at = this.keys.indexOf(model);
    return at >= 0 ? this.prices[at] : null;
  }

  /**
   * The cost in dollars on `model` (below 0 when its price is unknown): `input` counts every input
   * token, the cache's included, as ACP's `inputTokens` does; `cacheRead` of them are read from the
   * cache at its price, the rest at the input's.
   */
  cost(model: string, input: number, cacheRead: number, output: number): number {
    const p = this.of(model);
    if (p === null || p.input < 0 || p.output < 0) return -1;
    const read = Math.min(Math.max(cacheRead, 0), input);
    return ((input - read) * p.input + read * (p.cacheRead >= 0 ? p.cacheRead : p.input) + output * p.output) / 1000000;
  }
}

const priceOf = (value: unknown): ModelPrice | null => {
  const list = listOf(value);
  if (list.length >= 2) return new ModelPrice(num(list[0], -1), num(list[1], -1), list.length > 2 ? num(list[2], -1) : num(list[0], -1));
  const r = recordOf(value);
  if (r === null) return null;
  const input = num(r["input"], -1);
  return new ModelPrice(input, num(r["output"], -1), num(r["cacheRead"], input));
};

/** The prices in a JSON file: `{ "<model>": [input, output, cacheRead] }`, under `models` or at the top. */
export const pricesFromFile = (path: string): PriceTable => {
  const table = new PriceTable();
  const root = recordOf(JSON.parse(readFileSync(path, "utf8")));
  if (root === null) return table;
  const models = recordOf(root["models"]) ?? root;
  for (const key of Object.keys(models)) {
    const price = priceOf(models[key]);
    if (price !== null) table.add(key, price);
  }
  return table;
};

/**
 * The prices of the models the harness's registry knows, each as `provider/id`: the built-in
 * models and those config.json at `path` adds, with their input, output and cache-read prices.
 */
export const pricesFromConfig = (path: string): PriceTable => {
  const table = new PriceTable();
  const registry = ModelRegistry.builtIn();
  HarnessConfig.read(path).addProviders(registry);
  for (const m of registry.models) {
    if (m.inputPrice < 0 || m.outputPrice < 0) continue;
    table.add(m.modelValue(), new ModelPrice(m.inputPrice, m.outputPrice, m.cacheReadPrice));
  }
  return table;
};

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
  /**
   * Words run in the folder before the session is forgotten, `{session}` its id, whose JSON answer
   * holds the run's exact usage (`opencode export`); [] for none.
   */
  usage: string[] = [];
  /** Words run in the folder after the run to delete the session, `{session}` its id ([] for none). */
  forget: string[] = [];
  env: Record<string, string> = {};
  /** The model and effort to choose ("" keeps the agent's). */
  model = "";
  effort = "";
  /** Keep the folder after the run, for a look at what the agent did. */
  keep = false;
  /** The prices to compute a run's cost from (null: none). */
  prices: PriceTable | null = null;
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
  /** Of the input, the tokens read from the cache, when the agent reports them (`cachedReadTokens`). */
  cacheReadTokens = 0;
  outputTokens = 0;
  contextUsed = 0;
  /** The context the first usage update reported (below 0: the agent reported none). */
  firstInputTokens = -1;
  /** The requests the agent reported usage after (below 0: it reported none). */
  requests = -1;
  /** Whether the context was compacted: 1 yes, 0 no, -1 the stream does not tell. */
  compacted = -1;
  /** The largest context the agent reported (below 0: it reported none). */
  peakContext = -1;
  costUsd = -1;
  /** The cost from the price table (below 0: no price or no tokens known). */
  computedCostUsd = -1;
  /** The last context an update reported, to count requests and spot a compaction. */
  lastContext = -1;
  /** The agent's last words. */
  reply = "";
  folder = "";

  line(): string {
    return objectText(
      ["task", "agent", "model", "effort", "passed", "checkOutput", "stopReason", "error", "ms", "firstTokenMs", "calls", "failedCalls", "tools", "inputTokens", "cacheReadTokens", "outputTokens", "contextUsed", "firstInputTokens", "requests", "compacted", "peakContext", "costUsd", "computedCostUsd", "reply", "folder"],
      [JSON.stringify(this.task), JSON.stringify(this.agent), JSON.stringify(this.model), JSON.stringify(this.effort), this.passed ? "true" : "false", JSON.stringify(this.checkOutput), JSON.stringify(this.stopReason), JSON.stringify(this.error), String(this.ms), String(this.firstTokenMs), String(this.calls), String(this.failedCalls), "[" + this.tools.map((t) => JSON.stringify(t)).join(",") + "]", String(this.inputTokens), String(this.cacheReadTokens), String(this.outputTokens), String(this.contextUsed), String(this.firstInputTokens), String(this.requests), String(this.compacted), String(this.peakContext), String(this.costUsd), String(this.computedCostUsd), JSON.stringify(this.reply), JSON.stringify(this.folder)],
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
    o.cacheReadTokens = num(r["cacheReadTokens"], 0);
    o.outputTokens = num(r["outputTokens"], 0);
    o.contextUsed = num(r["contextUsed"], 0);
    o.firstInputTokens = num(r["firstInputTokens"], -1);
    o.requests = num(r["requests"], -1);
    o.compacted = num(r["compacted"], -1);
    o.peakContext = num(r["peakContext"], -1);
    o.costUsd = num(r["costUsd"], -1);
    o.computedCostUsd = num(r["computedCostUsd"], -1);
    o.reply = str(r["reply"]);
    o.folder = str(r["folder"]);
    return o;
  }
}

/** A run's usage, as an agent's per-request records give it (the input includes the cache). */
export class UsageTotals {
  requests = 0;
  inputTokens = 0;
  cacheReadTokens = 0;
  outputTokens = 0;
  firstInputTokens = -1;
  peakContext = -1;
  costUsd = -1;
}

/**
 * The usage in `opencode export`'s JSON: each assistant message's tokens (`input` without the
 * cache) and cost (null when there is no assistant message).
 */
export const opencodeUsage = (text: string): UsageTotals | null => {
  let root: Record<string, unknown> | null = null;
  try {
    root = recordOf(JSON.parse(text));
  } catch {
    return null;
  }
  if (root === null) return null;
  const totals = new UsageTotals();
  totals.costUsd = 0;
  for (const v of listOf(root["messages"])) {
    const m = recordOf(v);
    if (m === null) continue;
    const info = recordOf(m["info"]);
    if (info === null || str(info["role"]) !== "assistant") continue;
    const tokens = recordOf(info["tokens"]);
    const cache = tokens !== null ? recordOf(tokens["cache"]) : null;
    const input = tokens !== null ? num(tokens["input"], 0) : 0;
    const cacheRead = cache !== null ? num(cache["read"], 0) : 0;
    const cacheWrite = cache !== null ? num(cache["write"], 0) : 0;
    const output = tokens !== null ? num(tokens["output"], 0) : 0;
    const reasoning = tokens !== null ? num(tokens["reasoning"], 0) : 0;
    const whole = input + cacheRead + cacheWrite;
    totals.requests++;
    totals.inputTokens += whole;
    totals.cacheReadTokens += cacheRead;
    totals.outputTokens += output + (reasoning !== 0 ? reasoning : 0);
    if (totals.firstInputTokens < 0) totals.firstInputTokens = whole;
    if (whole > totals.peakContext) totals.peakContext = whole;
    totals.costUsd += num(info["cost"], 0);
  }
  return totals.requests > 0 ? totals : null;
};

/** Replace a run's usage with an export's exact per-request numbers. */
export const applyUsage = (result: RunResult, u: UsageTotals): void => {
  result.requests = u.requests;
  result.inputTokens = u.inputTokens;
  result.cacheReadTokens = u.cacheReadTokens;
  result.outputTokens = u.outputTokens;
  result.firstInputTokens = u.firstInputTokens;
  result.peakContext = u.peakContext;
  result.costUsd = u.costUsd;
};

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

/** `p`'s value, or `late` after `ms`, the timer cleared once `p` settles (so it keeps no process alive). */
const orAfter = <T>(p: Promise<T>, ms: number, late: T): Promise<T> =>
  new Promise<T>((settle) => {
    const timer = setTimeout(() => settle(late), ms);
    p.then((v: T) => {
      clearTimeout(timer);
      settle(v);
    });
  });

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

/** Finish a run: its exact usage, then its check and the session's end. */
const finishRun = async (
  task: BenchTask,
  spec: RunSpec,
  result: RunResult,
  work: string,
  started: number,
  sessionId: string,
  stop: () => void,
): Promise<RunResult> => {
  result.ms = Date.now() - started;
  if (sessionId.length > 0 && spec.usage.length > 0) {
    const words = spec.usage.map((w) => w.split("{session}").join(sessionId));
    const exported = spawnSync(words[0], words.slice(1), { cwd: work, encoding: "utf8", timeout: 30000 });
    if (exported.status === 0 && typeof exported.stdout === "string" && exported.stdout.trim().length > 0) {
      const usage = opencodeUsage(exported.stdout);
      if (usage !== null) applyUsage(result, usage);
    }
  }
  if (spec.prices !== null && (result.inputTokens > 0 || result.outputTokens > 0))
    result.computedCostUsd = spec.prices.cost(spec.model, result.inputTokens, result.cacheReadTokens, result.outputTokens);
  const check = spawnSync("node", [join(task.dir, "check.mjs")], { cwd: work, encoding: "utf8", timeout: 60000 });
  result.passed = check.status === 0;
  result.checkOutput = ((check.stdout ?? "") + (check.stderr ?? "")).trim().slice(0, 600);
  if (sessionId.length > 0 && spec.forget.length > 0) {
    const words = spec.forget.map((w) => w.split("{session}").join(sessionId));
    spawnSync(words[0], words.slice(1), { cwd: work, stdio: "ignore", timeout: 15000 });
  }
  stop();
  await delay(200);
  if (!spec.keep) rmSync(work, { recursive: true, force: true });
  return result;
};

/** Run `task` with `spec` on pi's RPC mode, whose records give the run's requests and usage. */
const runPiTask = async (task: BenchTask, spec: RunSpec): Promise<RunResult> => {
  const result = new RunResult();
  result.task = task.name;
  result.agent = spec.agent;
  result.model = spec.model;
  result.effort = spec.effort;
  result.compacted = 0;
  result.requests = 0;
  result.costUsd = 0;
  const work = mkdtempSync(join(tmpdir(), "harness-bench-" + task.name + "-"));
  result.folder = work;
  cpSync(join(task.dir, "repo"), work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["add", "-A"]);
  git(work, ["-c", "user.email=bench@widecode", "-c", "user.name=bench", "commit", "-qm", "the task"]);
  // A folder of its own, so the user's pi settings and extensions never load; the key is pi's to run.
  const agentDir = mkdtempSync(join(tmpdir(), "harness-bench-pi-"));
  const home = process.env["HOME"] ?? "";
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ opencode: { type: "api_key", key: "!jq -r .opencode.key " + join(home, ".widecode", "auth.json") } }),
  );
  const env: Record<string, string> = {};
  for (const k of Object.keys(spec.env)) env[k] = spec.env[k];
  env["PI_CODING_AGENT_DIR"] = agentDir;
  const command = spec.command.length > 0 ? spec.command.slice() : ["pi"];
  command.push("--mode", "rpc", "--no-session");
  if (spec.model.length > 0) command.push("--model", spec.model);
  if (spec.effort.length > 0) command.push("--thinking", spec.effort);
  const client = new PiClient();
  const started = Date.now();
  const seen = new Map<string, number>();
  const order: string[] = [];
  const replyParts: string[] = [];
  let lastStop = "";
  let aborted = false;
  client.onRecord = (r: Record<string, unknown>) => {
    const kind = str(r["type"]);
    if (kind === "message_update") {
      const event = recordOf(r["assistantMessageEvent"]);
      const type = event !== null ? str(event["type"]) : "";
      if ((type === "text_delta" || type === "thinking_delta") && result.firstTokenMs < 0) result.firstTokenMs = Date.now() - started;
      if (type === "text_delta" && event !== null) replyParts.push(str(event["delta"]));
    } else if (kind === "tool_execution_start") {
      result.calls++;
      const name = str(r["toolName"]).length > 0 ? str(r["toolName"]) : "?";
      if (!seen.has(name)) order.push(name);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    } else if (kind === "tool_execution_end" && r["isError"] === true) result.failedCalls++;
    else if (kind === "message_end") {
      const message = recordOf(r["message"]);
      if (message === null || str(message["role"]) !== "assistant") return;
      result.requests++;
      const usage = recordOf(message["usage"]);
      const input = usage !== null ? num(usage["input"], 0) : 0;
      const cacheRead = usage !== null ? num(usage["cacheRead"], 0) : 0;
      const cacheWrite = usage !== null ? num(usage["cacheWrite"], 0) : 0;
      const output = usage !== null ? num(usage["output"], 0) : 0;
      const reasoning = usage !== null ? num(usage["reasoning"], 0) : 0;
      const whole = input + cacheRead + cacheWrite;
      result.inputTokens += whole;
      result.cacheReadTokens += cacheRead;
      result.outputTokens += output + (reasoning !== 0 ? reasoning : 0);
      if (result.firstInputTokens < 0) result.firstInputTokens = whole;
      if (whole > result.peakContext) result.peakContext = whole;
      const cost = usage !== null ? recordOf(usage["cost"]) : null;
      result.costUsd += cost !== null ? num(cost["total"], 0) : 0;
      lastStop = str(message["stopReason"]);
    } else if (kind === "compaction_start" || kind === "compaction_end") result.compacted = 1;
    else if (kind === "agent_settled" && r["aborted"] === true) aborted = true;
  };
  const finish = async (): Promise<RunResult> => {
    result.tools = order.map((t) => t + "=" + String(seen.get(t) ?? 0));
    result.reply = replyParts.join("").trim().slice(-600);
    rmSync(agentDir, { recursive: true, force: true });
    return finishRun(task, spec, result, work, started, "", () => client.stop());
  };
  client.start(command, work, env);
  const settled = client.waitSettled();
  client.send({ id: "p1", type: "prompt", message: task.prompt });
  const first = await orAfter(settled.then(() => "settled"), task.timeoutMs, "timeout");
  if (first === "timeout") {
    client.send({ id: "a", type: "abort" });
    result.error = "the turn took longer than " + String(Math.round(task.timeoutMs / 1000)) + " s";
    result.stopReason = "timeout";
    await orAfter(settled, 5000, undefined);
  } else result.stopReason = aborted ? "cancelled" : lastStop;
  const answer = client.waitResponse("s");
  client.send({ id: "s", type: "get_session_stats" });
  const stats = await orAfter(answer, 10000, null);
  if (stats !== null) {
    const data = recordOf(stats["data"]);
    const cost = data !== null ? num(data["cost"], -1) : -1;
    if (cost >= 0) result.costUsd = cost;
  }
  return finish();
};

/** Run `task` with `spec`. */
export const runTask = async (task: BenchTask, spec: RunSpec): Promise<RunResult> => {
  if (spec.agent === "pi") return runPiTask(task, spec);
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
  // Usage updates count once the prompt is sent (an agent may report its empty context when the
  // session is made).
  let prompted = false;
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
      // An update whose context did not change is no request of the session's (a subagent's cost).
      if (used >= 0 && prompted && used !== result.lastContext) {
        if (result.firstInputTokens < 0) result.firstInputTokens = used;
        if (used > result.peakContext) result.peakContext = used;
        // A usage update after each request: a smaller context than the last means the agent
        // compacted it (the update reports the summary's size, not another request's).
        if (result.lastContext < 0) {
          result.requests = 1;
          result.compacted = 0;
        } else if (used < result.lastContext) result.compacted = 1;
        else result.requests++;
        result.lastContext = used;
        result.contextUsed = used;
      }
      const cost = recordOf(u["cost"]);
      if (cost !== null && typeof cost["amount"] === "number") result.costUsd = cost["amount"] as number;
    }
  };
  client.start(spec.command, work, spec.env);
  const finish = async (): Promise<RunResult> => {
    result.tools = order.map((t) => t + "=" + String(seen.get(t) ?? 0));
    result.reply = replyParts.join("").trim().slice(-600);
    return finishRun(task, spec, result, work, started, sessionId, () => client.stop());
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
  prompted = true;
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
    result.cacheReadTokens = num(usage["cachedReadTokens"], 0);
    result.outputTokens = num(usage["outputTokens"], 0);
  }
  return finish();
};
