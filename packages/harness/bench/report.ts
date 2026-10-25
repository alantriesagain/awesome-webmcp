// The benchmark's table: one row per agent and model (runs, passed, the mean time to the first
// token and in all, the mean calls and those that failed, the mean tokens, the cost in all when
// the agent reported it), then which tasks each passed.
import { RunResult } from "./runner.ts";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const seconds = (ms: number): string => (ms / 1000).toFixed(1) + " s";

/** The results as a markdown table and a matrix of tasks. */
export const reportText = (results: RunResult[]): string => {
  const groups: string[] = [];
  for (const r of results) {
    const g = r.agent + " " + (r.model.length > 0 ? r.model : "(default)") + (r.effort.length > 0 ? " " + r.effort : "");
    if (!groups.includes(g)) groups.push(g);
  }
  const of = (g: string): RunResult[] => results.filter((r) => r.agent + " " + (r.model.length > 0 ? r.model : "(default)") + (r.effort.length > 0 ? " " + r.effort : "") === g);
  const lines: string[] = [];
  lines.push("| agent and model | passed | first token | time | calls | failed calls | tokens in | tokens out | cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const g of groups) {
    const rs = of(g);
    const passed = rs.filter((r) => r.passed).length;
    const first = rs.filter((r) => r.firstTokenMs >= 0).map((r) => r.firstTokenMs);
    const costs = rs.filter((r) => r.costUsd >= 0).map((r) => r.costUsd);
    lines.push(
      "| " + [g, String(passed) + "/" + String(rs.length), first.length > 0 ? seconds(mean(first)) : "-", seconds(mean(rs.map((r) => r.ms))), mean(rs.map((r) => r.calls)).toFixed(1), mean(rs.map((r) => r.failedCalls)).toFixed(1), Math.round(mean(rs.map((r) => r.inputTokens))).toString(), Math.round(mean(rs.map((r) => r.outputTokens))).toString(), costs.length === rs.length && costs.length > 0 ? "$" + costs.reduce((a, b) => a + b, 0).toFixed(4) : "-"].join(" | ") + " |",
    );
  }
  const tasks: string[] = [];
  for (const r of results) if (!tasks.includes(r.task)) tasks.push(r.task);
  lines.push("");
  lines.push("| task | " + groups.join(" | ") + " |");
  lines.push("|---|" + groups.map(() => "---").join("|") + "|");
  for (const t of tasks) {
    const cells = groups.map((g) => {
      const rs = of(g).filter((r) => r.task === t);
      return rs.length === 0 ? "" : String(rs.filter((r) => r.passed).length) + "/" + String(rs.length);
    });
    lines.push("| " + pad(t, 1) + " | " + cells.join(" | ") + " |");
  }
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push("");
    lines.push("Failed runs:");
    for (const r of failures) lines.push("- " + r.task + ", " + r.agent + " " + r.model + ": " + (r.error.length > 0 ? r.error : r.checkOutput.split("\n")[0] ?? "").slice(0, 200));
  }
  return lines.join("\n");
};
