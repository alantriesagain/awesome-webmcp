// The orchestration benchmark's command. It runs each orchestrator and model over each task, repeat
// by repeat, writes one record per run, keeps the transcripts beside the records, and prints the
// tables; `--report` prints earlier records instead and runs nothing.
//
//   --orchestrator <name>[,<name>...]  the main agent: harness (widecode's own) or claude (Claude Code)
//   --model <value>[,<value>...]       the orchestrator's model
//   --tasks <name>[,<name>...]         some of the tasks
//   --repeat <n>                       runs of each task, model and orchestrator (1)
//   --target-agent <name>              the subagent target's ACP agent (opencode)
//   --target-model <value>             the subagent target's model
//   --out <file.jsonl>                 the records (results/<stamp>-orchestrate-<agents>.jsonl)
//   --keep                             keep each run's folder and store
//   --report <file.jsonl>...           print the table of earlier records, run nothing
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks } from "./tasks.ts";
import { OrchestrateRecord } from "./record.ts";
import { reportText } from "./report.ts";
import { OrchestrateSpec, runOne } from "./runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const partRoot = join(here, "..", "tasks");
const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const list = (name: string): string[] => value(name, "").split(",").map((v) => v.trim()).filter((v) => v.length > 0);
const two = (n: number): string => (n < 10 ? "0" : "") + String(n);
const stamp = (): string => {
  const d = new Date();
  return String(d.getFullYear()) + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
};

const reportAt = args.indexOf("--report");
if (reportAt >= 0) {
  const records: OrchestrateRecord[] = [];
  for (const file of args.slice(reportAt + 1)) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const r = OrchestrateRecord.parse(line);
      if (r !== null) records.push(r);
    }
  }
  console.log(reportText(records));
  process.exit(0);
}

const orchestrators = list("--orchestrator");
if (orchestrators.length === 0) orchestrators.push("harness");
const models = list("--model");
if (models.length === 0) models.push("");
const tasks = loadTasks(join(here, "tasks"), partRoot, list("--tasks"));
if (tasks.length === 0) {
  console.error("no tasks" + (list("--tasks").length > 0 ? " named " + list("--tasks").join(", ") : ""));
  process.exit(2);
}
const repeat = Math.max(1, Math.trunc(Number(value("--repeat", "1"))) || 1);
const promptText = readFileSync(join(here, "prompt.md"), "utf8");
const out = value("--out", join(here, "results", stamp() + "-orchestrate-" + orchestrators.join("+") + ".jsonl"));
mkdirSync(dirname(out), { recursive: true });
const transcriptDir = out.endsWith(".jsonl") ? out.slice(0, -".jsonl".length) : out;
mkdirSync(transcriptDir, { recursive: true });
const records: OrchestrateRecord[] = [];
const counts = new Map<string, number>();

const main = async (): Promise<void> => {
  for (const orchestrator of orchestrators)
    for (const model of models)
      for (const task of tasks)
        for (let i = 0; i < repeat; i++) {
          const key = task.name + "\u0000" + orchestrator;
          const k = (counts.get(key) ?? 0) + 1;
          counts.set(key, k);
          const spec = new OrchestrateSpec();
          spec.orchestrator = orchestrator;
          spec.model = model;
          spec.repeat = k;
          spec.promptText = promptText;
          spec.targetAgent = value("--target-agent", spec.targetAgent);
          spec.targetModel = value("--target-model", spec.targetModel);
          spec.keep = args.includes("--keep");
          const record = await runOne(task, partRoot, spec, transcriptDir);
          records.push(record);
          appendFileSync(out, record.line() + "\n");
          const parts = record.parts.map((p) => (p.passed ? "+" : "-") + p.name).join(" ");
          console.log(
            (record.setupFailed ? "SETUP " : record.passed ? "pass " : "FAIL ") +
              task.name +
              " · " +
              orchestrator +
              " " +
              (model.length > 0 ? model : "(default)") +
              " · " +
              (record.ms / 1000).toFixed(1) +
              " s · parts " +
              parts +
              (record.costUsd >= 0 ? " · $" + record.costUsd.toFixed(4) : ""),
          );
        }
  console.log("\n" + reportText(records) + "\n\nthe records: " + out);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
