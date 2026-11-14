// The benchmark's table: one row per agent and model (runs, passed, the mean time to the first
// token and in all, the mean calls and those that failed, the mean tokens and the diagnosis the
// stream gave: the first request's input, the requests, the share compacted, the peak context, the
// cost computed from the prices and the cost the agent reported), then which tasks each passed,
// then, for each model more than one agent ran, a paired table with the pass rate each agent
// reached and its difference from the baseline's (the harness when it ran, else the first agent).
import { RunResult } from "./runner.ts";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const seconds = (ms: number): string => (ms / 1000).toFixed(1) + " s";
const label = (r: RunResult): string => (r.model.length > 0 ? r.model : "(default)");
const points = (x: number): string => (x > 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const rate = (passed: number, runs: number): number => (runs === 0 ? 0 : passed / runs);
const ratio = (passed: number, runs: number): string => String(passed) + "/" + String(runs);
/** The runs that got to the prompt: a setup failure is no result of the agent's. */
const scored = (rs: RunResult[]): RunResult[] => rs.filter((r) => !r.setupFailed);

/** The agents in a consistent order: the harness first when it ran, then the others by name. */
const agentOrder = (agents: string[]): string[] => {
  const names = agents.slice().sort();
  return names.includes("harness") ? ["harness", ...names.filter((a) => a !== "harness")] : names;
};

/** The results as a markdown table and a matrix of tasks, then a paired table per shared model. */
export const reportText = (results: RunResult[]): string => {
  const groups: string[] = [];
  for (const r of results) {
    const g = r.agent + " " + (r.model.length > 0 ? r.model : "(default)") + (r.effort.length > 0 ? " " + r.effort : "");
    if (!groups.includes(g)) groups.push(g);
  }
  const of = (g: string): RunResult[] => results.filter((r) => r.agent + " " + (r.model.length > 0 ? r.model : "(default)") + (r.effort.length > 0 ? " " + r.effort : "") === g);
  const known = (rs: RunResult[], pick: (r: RunResult) => number): number[] => rs.map(pick).filter((n) => n >= 0);
  const meanOf = (rs: RunResult[], pick: (r: RunResult) => number): string => {
    const xs = known(rs, pick);
    return xs.length > 0 ? mean(xs).toFixed(1) : "-";
  };
  const costOf = (rs: RunResult[], pick: (r: RunResult) => number): string => {
    const xs = known(rs, pick);
    return xs.length === rs.length && xs.length > 0 ? "$" + xs.reduce((a, b) => a + b, 0).toFixed(4) : "-";
  };
  const lines: string[] = [];
  lines.push("| agent and model | passed | setup failures | first token | time | calls | failed calls | tokens in | tokens out | first input | requests | compacted | peak context | cost | agent cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of groups) {
    const rs = of(g);
    const real = scored(rs);
    const passed = real.filter((r) => r.passed).length;
    const first = real.filter((r) => r.firstTokenMs >= 0).map((r) => r.firstTokenMs);
    lines.push(
      "| " + [g, ratio(passed, real.length), String(rs.length - real.length), first.length > 0 ? seconds(mean(first)) : "-", seconds(mean(real.map((r) => r.ms))), mean(real.map((r) => r.calls)).toFixed(1), mean(real.map((r) => r.failedCalls)).toFixed(1), Math.round(mean(real.map((r) => r.inputTokens))).toString(), Math.round(mean(real.map((r) => r.outputTokens))).toString(), meanOf(real, (r) => r.firstInputTokens), meanOf(real, (r) => r.requests), meanOf(real, (r) => r.compacted), meanOf(real, (r) => r.peakContext), costOf(real, (r) => r.computedCostUsd), costOf(real, (r) => r.costUsd)].join(" | ") + " |",
    );
  }
  const tasks: string[] = [];
  for (const r of results) if (!tasks.includes(r.task)) tasks.push(r.task);
  lines.push("");
  lines.push("| task | " + groups.join(" | ") + " |");
  lines.push("|---|" + groups.map(() => "---").join("|") + "|");
  for (const t of tasks) {
    const cells = groups.map((g) => {
      const rs = scored(of(g)).filter((r) => r.task === t);
      return rs.length === 0 ? "" : ratio(rs.filter((r) => r.passed).length, rs.length);
    });
    lines.push("| " + pad(t, 1) + " | " + cells.join(" | ") + " |");
  }
  // A paired table for every model more than one agent ran.
  const models: string[] = [];
  for (const r of results) if (!models.includes(label(r))) models.push(label(r));
  for (const model of models) {
    const runs = scored(results.filter((r) => label(r) === model));
    const agents = agentOrder(runs.map((r) => r.agent).filter((a, i, all) => all.indexOf(a) === i));
    if (agents.length < 2) continue;
    const baseline = agents[0];
    const others = agents.filter((a) => a !== baseline);
    lines.push("");
    lines.push("### " + model + " (baseline: " + baseline + ")");
    lines.push("| task | " + agents.join(" | ") + " | " + others.map((a) => a + " - " + baseline).join(" | ") + " |");
    lines.push("|---|" + agents.map(() => "---").join("|") + "|" + others.map(() => "---").join("|") + "|");
    const cell = (agent: string, task: string): string => {
      const rs = runs.filter((r) => r.agent === agent && r.task === task);
      return rs.length === 0 ? "" : ratio(rs.filter((r) => r.passed).length, rs.length);
    };
    const diff = (agent: string, task: string): string => {
      const rs = runs.filter((r) => r.agent === agent && r.task === task);
      const base = runs.filter((r) => r.agent === baseline && r.task === task);
      if (rs.length === 0 || base.length === 0) return "";
      return points(rate(rs.filter((r) => r.passed).length, rs.length) - rate(base.filter((r) => r.passed).length, base.length));
    };
    const inModel: string[] = [];
    for (const r of runs) if (!inModel.includes(r.task)) inModel.push(r.task);
    for (const t of inModel) lines.push("| " + pad(t, 1) + " | " + agents.map((a) => cell(a, t)).join(" | ") + " | " + others.map((a) => diff(a, t)).join(" | ") + " |");
    const total = (agent: string): RunResult[] => runs.filter((r) => r.agent === agent);
    const totalCell = (agent: string): string => {
      const rs = total(agent);
      return rs.length === 0 ? "" : ratio(rs.filter((r) => r.passed).length, rs.length);
    };
    const totalDiff = (agent: string): string => {
      const rs = total(agent);
      const base = total(baseline);
      if (rs.length === 0 || base.length === 0) return "";
      return points(rate(rs.filter((r) => r.passed).length, rs.length) - rate(base.filter((r) => r.passed).length, base.length));
    };
    lines.push("| total | " + agents.map(totalCell).join(" | ") + " | " + others.map(totalDiff).join(" | ") + " |");
  }
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push("");
    lines.push("Failed runs:");
    for (const r of failures) {
      const why = (r.error.length > 0 ? r.error : r.checkOutput.split("\n")[0] ?? "").slice(0, 200);
      lines.push("- " + r.task + ", " + r.agent + " " + r.model + ": " + (r.setupFailed ? "setup failure: " + why : why));
    }
  }
  return lines.join("\n");
};
