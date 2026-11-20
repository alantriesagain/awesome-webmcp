// One orchestration run's record, written as a line of JSON and read back. It carries the verdict of
// every part, the time in all, what the orchestrator itself spent (tokens and cost, its own Edit and
// Write calls instead of delegation, its Task calls) and what its subagents spent, then the totals.
// Which file each number came from is named in the README's section.
import { listOf, num, recordOf, str } from "@lightstart/lib/json.ts";
import { SubagentUse } from "./measures.ts";
import { PartVerdict } from "./tasks.ts";

/** A run's transcript files, beside its record. */
export class RunFiles {
  /** The orchestrator's session file, the app's log, the last screen. */
  session = "";
  log = "";
  screen = "";
}

/** What one orchestration run measured. */
export class OrchestrateRecord {
  task = "";
  orchestrator = "";
  model = "";
  repeat = 0;
  passed = false;
  /** The run never got to the orchestrator's first turn. */
  setupFailed = false;
  timedOut = false;
  error = "";
  ms = 0;
  parts: PartVerdict[] = [];
  /** The orchestrator's own requests and tokens. */
  requests = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  costUsd = -1;
  /** Its own Edit and Write calls, work it did rather than delegating. */
  ownEdits = 0;
  ownWrites = 0;
  /** Its Task calls, those started in the background, and those run in the foreground. */
  taskCalls = 0;
  taskBackground = 0;
  taskForeground = 0;
  subagents: SubagentUse[] = [];
  subagentCostUsd = -1;
  subagentInputTokens = 0;
  subagentOutputTokens = 0;
  subagentCacheReadTokens = 0;
  totalCostUsd = -1;
  files = new RunFiles();
  folder = "";

  line(): string {
    const parts = this.parts.map((p) => ({ name: p.name, passed: p.passed, output: p.output }));
    const subagents = this.subagents.map((s) => ({ id: s.id, agent: s.agent, requests: s.requests, input: s.input, output: s.output, cacheRead: s.cacheRead, costUsd: s.costUsd }));
    return JSON.stringify({
      task: this.task,
      orchestrator: this.orchestrator,
      model: this.model,
      repeat: this.repeat,
      passed: this.passed,
      setupFailed: this.setupFailed,
      timedOut: this.timedOut,
      error: this.error,
      ms: this.ms,
      parts,
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      costUsd: this.costUsd,
      ownEdits: this.ownEdits,
      ownWrites: this.ownWrites,
      taskCalls: this.taskCalls,
      taskBackground: this.taskBackground,
      taskForeground: this.taskForeground,
      subagents,
      subagentCostUsd: this.subagentCostUsd,
      subagentInputTokens: this.subagentInputTokens,
      subagentOutputTokens: this.subagentOutputTokens,
      subagentCacheReadTokens: this.subagentCacheReadTokens,
      totalCostUsd: this.totalCostUsd,
      session: this.files.session,
      log: this.files.log,
      screen: this.files.screen,
      folder: this.folder,
    });
  }

  static parse(text: string): OrchestrateRecord | null {
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const r = recordOf(value);
    if (r === null) return null;
    const o = new OrchestrateRecord();
    o.task = str(r["task"]);
    o.orchestrator = str(r["orchestrator"]);
    o.model = str(r["model"]);
    o.repeat = num(r["repeat"], 0);
    o.passed = r["passed"] === true;
    o.setupFailed = r["setupFailed"] === true;
    o.timedOut = r["timedOut"] === true;
    o.error = str(r["error"]);
    o.ms = num(r["ms"], 0);
    for (const v of listOf(r["parts"])) {
      const p = recordOf(v);
      if (p === null) continue;
      const verdict = new PartVerdict();
      verdict.name = str(p["name"]);
      verdict.passed = p["passed"] === true;
      verdict.output = str(p["output"]);
      o.parts.push(verdict);
    }
    o.requests = num(r["requests"], 0);
    o.inputTokens = num(r["inputTokens"], 0);
    o.outputTokens = num(r["outputTokens"], 0);
    o.cacheReadTokens = num(r["cacheReadTokens"], 0);
    o.costUsd = num(r["costUsd"], -1);
    o.ownEdits = num(r["ownEdits"], 0);
    o.ownWrites = num(r["ownWrites"], 0);
    o.taskCalls = num(r["taskCalls"], 0);
    o.taskBackground = num(r["taskBackground"], 0);
    o.taskForeground = num(r["taskForeground"], 0);
    for (const v of listOf(r["subagents"])) {
      const s = recordOf(v);
      if (s === null) continue;
      const sub = new SubagentUse();
      sub.id = str(s["id"]);
      sub.agent = str(s["agent"]);
      sub.requests = num(s["requests"], 0);
      sub.input = num(s["input"], 0);
      sub.output = num(s["output"], 0);
      sub.cacheRead = num(s["cacheRead"], 0);
      sub.costUsd = num(s["costUsd"], -1);
      o.subagents.push(sub);
    }
    o.subagentCostUsd = num(r["subagentCostUsd"], -1);
    o.subagentInputTokens = num(r["subagentInputTokens"], 0);
    o.subagentOutputTokens = num(r["subagentOutputTokens"], 0);
    o.subagentCacheReadTokens = num(r["subagentCacheReadTokens"], 0);
    o.totalCostUsd = num(r["totalCostUsd"], -1);
    o.files.session = str(r["session"]);
    o.files.log = str(r["log"]);
    o.files.screen = str(r["screen"]);
    o.folder = str(r["folder"]);
    return o;
  }
}
