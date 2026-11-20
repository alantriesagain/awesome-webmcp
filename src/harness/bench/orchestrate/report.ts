// The orchestration benchmark's tables: one row per orchestrator and model (passed runs, parts
// passed, the mean time, the orchestrator's cost, its subagents' cost, the total, its Task calls and
// its own edits), then one row per task with each orchestrator's pass rate and parts there.
import { OrchestrateRecord } from "./record.ts";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const seconds = (ms: number): string => (ms / 1000).toFixed(1) + " s";
const ratio = (a: number, b: number): string => String(a) + "/" + String(b);
const money = (v: number): string => (v < 0 ? "-" : "$" + v.toFixed(4));
const label = (r: OrchestrateRecord): string => r.orchestrator + " " + (r.model.length > 0 ? r.model : "(default)");

const groupOrder = (records: OrchestrateRecord[]): string[] => {
  const groups: string[] = [];
  for (const r of records) {
    const g = label(r);
    if (!groups.includes(g)) groups.push(g);
  }
  const sorted = groups.filter((g) => !g.startsWith("harness ")).sort();
  return groups.filter((g) => g.startsWith("harness ")).concat(sorted);
};

const partsKnown = (r: OrchestrateRecord): number => r.parts.filter((p) => p.passed).length;

/** The records as markdown: the per-orchestrator table, then the per-task one. */
export const reportText = (records: OrchestrateRecord[]): string => {
  const groups = groupOrder(records);
  const of = (g: string): OrchestrateRecord[] => records.filter((r) => label(r) === g);
  const lines: string[] = [];
  lines.push("| orchestrator and model | passed | parts | time | orchestrator cost | subagent cost | total | Task calls | background | own edits | own writes |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of groups) {
    const rs = of(g);
    const passed = rs.filter((r) => r.passed).length;
    const partsOk = rs.reduce((n, r) => n + partsKnown(r), 0);
    const partsAll = rs.reduce((n, r) => n + r.parts.length, 0);
    const costs = rs.map((r) => r.costUsd).filter((v) => v >= 0);
    const subCosts = rs.map((r) => r.subagentCostUsd).filter((v) => v >= 0);
    const totals = rs.map((r) => r.totalCostUsd).filter((v) => v >= 0);
    lines.push(
      "| " +
        [
          g,
          ratio(passed, rs.length),
          ratio(partsOk, partsAll),
          seconds(mean(rs.map((r) => r.ms))),
          costs.length === rs.length && costs.length > 0 ? money(mean(costs)) : "-",
          subCosts.length === rs.length && subCosts.length > 0 ? money(mean(subCosts)) : "-",
          totals.length === rs.length && totals.length > 0 ? money(mean(totals)) : "-",
          mean(rs.map((r) => r.taskCalls)).toFixed(1),
          mean(rs.map((r) => r.taskBackground)).toFixed(1),
          mean(rs.map((r) => r.ownEdits)).toFixed(1),
          mean(rs.map((r) => r.ownWrites)).toFixed(1),
        ].join(" | ") +
        " |",
    );
  }
  const tasks: string[] = [];
  for (const r of records) if (!tasks.includes(r.task)) tasks.push(r.task);
  lines.push("");
  lines.push("| task | " + groups.join(" | ") + " |");
  lines.push("|---|" + groups.map(() => "---").join("|") + "|");
  for (const t of tasks) {
    const cells = groups.map((g) => {
      const rs = of(g).filter((r) => r.task === t);
      if (rs.length === 0) return "";
      const passed = rs.filter((r) => r.passed).length;
      const ok = rs.reduce((n, r) => n + partsKnown(r), 0);
      const all = rs.reduce((n, r) => n + r.parts.length, 0);
      return ratio(passed, rs.length) + " (" + ratio(ok, all) + " parts)";
    });
    lines.push("| " + pad(t, 1) + " | " + cells.join(" | ") + " |");
  }
  const failures = records.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push("");
    lines.push("Failed runs:");
    for (const r of failures) {
      const wrong = r.parts.filter((p) => !p.passed).map((p) => p.name + ": " + (p.output.split("\n")[0] ?? "failed"));
      const why = r.error.length > 0 ? r.error : wrong.join("; ");
      lines.push("- " + r.task + ", " + label(r) + ": " + why.slice(0, 200));
    }
  }
  return lines.join("\n");
};
