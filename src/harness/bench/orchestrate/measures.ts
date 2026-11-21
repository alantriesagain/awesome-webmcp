// What an orchestration run measured, read from the files each orchestrator keeps. The harness keeps
// one session file per session under `<store>/harness/sessions/<folder>/<id>.jsonl`: message entries
// with their parts (a tool call's name and input JSON, a tool result's text) and usage entries. Claude
// Code keeps its own transcript under `<projects>/<folder, non-alphanumerics as '-'>/<id>.jsonl`:
// assistant messages carry the request's usage, a result event carries `total_cost_usd`, and a tool
// call is a tool_use block. A subagent on an opencode target is a session of its own, read with
// `opencode export` after `opencode session list --format json` names it. The app's log says when a
// turn starts and ends and when a background subagent finishes; that is the done signal.
import { listOf, num, recordOf, str } from "@lightstart/lib/json.ts";
import { UsageTotals, opencodeUsage } from "../runner.ts";

/** The tokens a run or a request used, and its cost when one is known (below 0: unknown). */
export class TokenUse {
  requests = 0;
  input = 0;
  cacheRead = 0;
  cacheWrite = 0;
  output = 0;
  costUsd = -1;
}

const addCost = (target: TokenUse, cost: number): void => {
  if (cost < 0) return;
  target.costUsd = (target.costUsd < 0 ? 0 : target.costUsd) + cost;
};

const first = (r: Record<string, unknown>, keys: string[]): number => {
  for (const key of keys) {
    const value = r[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
};

const has = (r: Record<string, unknown>, keys: string[]): boolean => {
  for (const key of keys) if (typeof r[key] === "number") return true;
  return false;
};

/** Add a usage object in either the harness's or Claude's spelling (`input` or `input_tokens`). */
const addUsage = (target: TokenUse, usage: Record<string, unknown>): void => {
  const input = first(usage, ["input", "inputTokens", "input_tokens"]);
  const cacheRead = first(usage, ["cacheRead", "cachedReadTokens", "cache_read_input_tokens"]);
  const cacheWrite = first(usage, ["cacheWrite", "cachedWriteTokens", "cache_creation_input_tokens"]);
  const output = first(usage, ["output", "outputTokens", "output_tokens"]);
  target.requests++;
  target.input += input;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.output += output;
  if (has(usage, ["cost", "costUsd", "reportedCost"])) addCost(target, first(usage, ["cost", "costUsd", "reportedCost"]));
};

/** One tool call an orchestrator made, as its own session records it. */
export class RecordedCall {
  name = "";
  inputJson = "";
  callId = "";
}

/** The orchestrator's own session as the session file records it. */
export class HarnessMeasures {
  usage = new TokenUse();
  edits = 0;
  writes = 0;
  taskCalls = 0;
  taskBackground = 0;
  /** The ids of background Task runs the session says started, in order. */
  backgroundIds: string[] = [];
  calls: RecordedCall[] = [];
}

const startedIds = (text: string): string[] => {
  const out: string[] = [];
  const rx = /subagent started:\s*([A-Za-z0-9_.:-]+)/g;
  let m = rx.exec(text);
  while (m !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
    m = rx.exec(text);
  }
  return out;
};

const parseLine = (line: string): Record<string, unknown> | null => {
  if (line.trim().length === 0) return null;
  try {
    return recordOf(JSON.parse(line));
  } catch {
    return null;
  }
};

const isTask = (name: string): boolean => name === "Task" || name.endsWith("__Task") || name.endsWith("_Task");

const taskInput = (inputJson: string): Record<string, unknown> | null => {
  try {
    return recordOf(JSON.parse(inputJson));
  } catch {
    return null;
  }
};

/** A harness session file read: its usage entries, its tool calls and its background Task runs. */
export const readHarnessSession = (text: string): HarnessMeasures => {
  const out = new HarnessMeasures();
  for (const line of text.split("\n")) {
    const r = parseLine(line);
    if (r === null) continue;
    // A usage entry per request, its tokens and cost in `data` (side requests, a subagent's or a page read's, among them).
    if (str(r["kind"]) === "usage") {
      const data = recordOf(r["data"]);
      if (data !== null) addUsage(out.usage, data);
      continue;
    }
    if (str(r["kind"]) !== "message") continue;
    for (const value of listOf(r["parts"])) {
      const part = recordOf(value);
      if (part === null) continue;
      const kind = str(part["kind"]);
      if (kind === "tool_call") {
        const call = new RecordedCall();
        call.name = str(part["name"]);
        call.inputJson = str(part["inputJson"]);
        call.callId = str(part["callId"]);
        out.calls.push(call);
        if (call.name === "Edit") out.edits++;
        else if (call.name === "Write") out.writes++;
        if (isTask(call.name)) {
          out.taskCalls++;
          const input = taskInput(call.inputJson);
          if (input !== null && input["run_in_background"] === true) out.taskBackground++;
        }
      } else if (kind === "tool_result") {
        for (const id of startedIds(str(part["text"]))) if (!out.backgroundIds.includes(id)) out.backgroundIds.push(id);
      }
    }
  }
  return out;
};

/** The orchestrator's own Claude Code transcript: its usage, its cost, its calls and its Task runs. */
export class ClaudeMeasures extends HarnessMeasures {
  constructor() {
    super();
  }
}

const blockText = (value: unknown): string => {
  if (typeof value === "string") return value;
  const r = recordOf(value);
  if (r === null) return "";
  const texts: string[] = [];
  for (const part of listOf(r["content"])) {
    const p = recordOf(part);
    if (p !== null && typeof p["text"] === "string") texts.push(p["text"]);
  }
  return texts.length > 0 ? texts.join("") : typeof r["text"] === "string" ? r["text"] : "";
};

/** A Claude Code transcript read; subagent records (`parent_tool_use_id`) are left out of the main thread's numbers. */
export const readClaudeTranscript = (text: string): ClaudeMeasures => {
  const out = new ClaudeMeasures();
  let processCost = 0;
  let sawResult = false;
  const resultUsage = new TokenUse();
  // Claude Code writes an assistant message's content blocks as lines of their own, each with the
  // message's usage: a request counts once, by its message id.
  const counted = new Set<string>();
  for (const line of text.split("\n")) {
    const r = parseLine(line);
    if (r === null) continue;
    if (str(r["parent_tool_use_id"]).length > 0) continue;
    const type = str(r["type"]);
    if (type === "assistant") {
      const message = recordOf(r["message"]);
      if (message === null) continue;
      const usage = recordOf(message["usage"]);
      const id = str(message["id"]);
      if (usage !== null && (id.length === 0 || !counted.has(id))) {
        if (id.length > 0) counted.add(id);
        addUsage(out.usage, usage);
      }
      for (const value of listOf(message["content"])) {
        const block = recordOf(value);
        if (block === null || str(block["type"]) !== "tool_use") continue;
        const call = new RecordedCall();
        call.name = str(block["name"]);
        call.inputJson = JSON.stringify(block["input"] ?? {});
        call.callId = str(block["id"]);
        out.calls.push(call);
        if (call.name === "Edit") out.edits++;
        else if (call.name === "Write") out.writes++;
        if (isTask(call.name)) {
          out.taskCalls++;
          const input = recordOf(block["input"]);
          if (input !== null && input["run_in_background"] === true) out.taskBackground++;
        }
      }
    } else if (type === "user") {
      const message = recordOf(r["message"]);
      if (message === null) continue;
      for (const value of listOf(message["content"])) {
        const block = recordOf(value);
        if (block === null || str(block["type"]) !== "tool_result") continue;
        for (const id of startedIds(blockText(block["content"]))) if (!out.backgroundIds.includes(id)) out.backgroundIds.push(id);
      }
    } else if (type === "result") {
      sawResult = true;
      const total = num(r["total_cost_usd"], -1);
      if (total >= 0) {
        // The CLI's total is cumulative per process; a smaller one is a new process's first.
        if (total >= processCost) addCost(out.usage, total - processCost);
        else addCost(out.usage, total);
        processCost = total;
      }
      const usage = recordOf(r["usage"]);
      if (usage !== null) addUsage(resultUsage, usage);
    }
  }
  // A transcript with result usage but no assistant messages (a resumed print) still has its tokens.
  if (out.usage.requests === 0 && resultUsage.requests > 0) out.usage = resultUsage;
  if (sawResult && out.usage.costUsd < 0 && resultUsage.costUsd >= 0) out.usage.costUsd = resultUsage.costUsd;
  return out;
};

/** One subagent run's usage, from its own session's export. */
export class SubagentUse {
  id = "";
  agent = "";
  requests = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  costUsd = -1;
}

/** Turn an opencode export into the subagent's numbers (null when it does not parse). */
export const subagentFromExport = (id: string, agent: string, text: string): SubagentUse | null => {
  const usage = opencodeUsage(text);
  if (usage === null) return null;
  return fromUsage(id, agent, usage);
};

const fromUsage = (id: string, agent: string, usage: UsageTotals): SubagentUse => {
  const sub = new SubagentUse();
  sub.id = id;
  sub.agent = agent;
  sub.requests = usage.requests;
  sub.input = usage.inputTokens;
  sub.output = usage.outputTokens;
  sub.cacheRead = usage.cacheReadTokens;
  sub.costUsd = usage.costUsd;
  return sub;
};

/** The session ids in an `opencode session list --format json` answer that ran in `folder` at or after `sinceMs`. */
export const subagentSessions = (text: string, folder: string, sinceMs: number): string[] => {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const out: { id: string; created: number }[] = [];
  for (const item of listOf(value)) {
    const r = recordOf(item);
    if (r === null) continue;
    const id = str(r["id"]);
    const directory = str(r["directory"]).length > 0 ? str(r["directory"]) : str(r["cwd"]);
    if (id.length === 0 || directory !== folder) continue;
    const time = recordOf(r["time"]);
    const created = time !== null ? num(time["created"], 0) : num(r["created"], 0);
    if (created > 0 && created + 5000 < sinceMs) continue;
    out.push({ id, created });
  }
  out.sort((a, b) => a.created - b.created);
  return out.map((x) => x.id);
};

/** Sum the subagents' numbers into a run's totals. */
export const subagentTotals = (subs: SubagentUse[]): TokenUse => {
  const total = new TokenUse();
  for (const sub of subs) {
    total.requests += sub.requests;
    total.input += sub.input;
    total.output += sub.output;
    total.cacheRead += sub.cacheRead;
    addCost(total, sub.costUsd);
  }
  return total;
};

/** What the app's log says about turns and background subagents. */
export class LogSignal {
  /** The turn starts and ends seen. */
  started = 0;
  ended = 0;
  /** Whether a turn is open at the last line. */
  running = false;
  /** Background subagent ids that finished or failed. */
  finished: string[] = [];
  failed: string[] = [];

  /** Whether a turn ended and none is open now. */
  idleAfterTurn(): boolean {
    return this.ended > 0 && !this.running;
  }
}

/** The log's lines read into the done signal. */
export const readLogSignal = (text: string): LogSignal => {
  const out = new LogSignal();
  for (const line of text.split("\n")) {
    if (line.includes("turn started")) {
      out.started++;
      out.running = true;
    } else if (line.includes("turn ended")) {
      out.ended++;
      out.running = false;
    }
    const bg = /background subagent (\S+) (finished|failed)/.exec(line);
    if (bg === null) continue;
    const id = bg[1];
    if (bg[2] === "finished") {
      if (!out.finished.includes(id)) out.finished.push(id);
    } else if (!out.failed.includes(id)) out.failed.push(id);
  }
  return out;
};

/** The background Task ids the session says started but the log has not seen finish or fail. */
export const pendingBackground = (started: string[], log: LogSignal): string[] => {
  const out: string[] = [];
  for (const id of started) if (!log.finished.includes(id) && !log.failed.includes(id)) out.push(id);
  return out;
};
