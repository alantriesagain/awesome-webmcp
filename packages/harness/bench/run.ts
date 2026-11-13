// `node packages/harness/bench/run.ts [options]`: the benchmark. Each task of `bench/tasks` (or
// those `--tasks` names) runs `--repeat` times with each `--model` on the agent, the records
// appended to `--out` (a JSONL file, under `bench/results/` by default) and the table printed at
// the end. It talks to real models and spends real money: `--budget <dollars>` stops starting
// runs once the cost the agent reported passes it.
//
//   --agent harness | opencode | dsh     the agent (harness by default: this checkout's daemon under node)
//   --binary                             the harness from the installed `widecode` instead
//   --command "<words>"                  any other ACP agent, started in the task's folder
//   --model <value>[,<value>...]         the models to compare, as the agent's model option names them
//   --effort <value>                     the effort, as its effort option names it
//   --tasks <name>[,<name>...]           some of the tasks
//   --repeat <n>                         runs of each task and model (1)
//   --fake <fixture>                     the harness on its fake model (the runner's own test)
//   --prices <file.json>                 model prices, per million tokens (`{ "<model>": [input, output, cacheRead] }`);
//                                        by default the models in the harness's config.json
//   --keep                               keep each run's folder
//   --report <file.jsonl>...             print the table of earlier results, run nothing
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportText } from "./report.ts";
import { BenchTask, RunResult, RunSpec, loadTasks, pricesFromConfig, pricesFromFile, runTask } from "./runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};

const two = (n: number): string => (n < 10 ? "0" : "") + String(n);
const stamp = (): string => {
  const d = new Date();
  return String(d.getFullYear()) + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
};

const reportAt = args.indexOf("--report");
if (reportAt >= 0) {
  const results: RunResult[] = [];
  for (const file of args.slice(reportAt + 1))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const r = line.trim().length > 0 ? RunResult.parse(line) : null;
      if (r !== null) results.push(r);
    }
  console.log(reportText(results));
  process.exit(0);
}

const agent = value("--agent", "harness");
const main = join(here, "..", "main.ts");
const base = new RunSpec();
base.agent = agent;
const fake = value("--fake", "");
if (args.includes("--command")) {
  base.command = value("--command", "").split(/\s+/).filter((w) => w.length > 0);
  base.agent = value("--agent", base.command[0] ?? "agent");
} else if (agent === "harness") {
  base.command = args.includes("--binary") ? ["widecode", "--harness"] : ["node", main, "--harness"];
  base.forget = args.includes("--binary") ? ["widecode", "--harness-forget", "{session}"] : ["node", main, "--harness-forget", "{session}"];
  if (fake.length > 0) {
    const home = join(here, "results", "fake-home");
    mkdirSync(home, { recursive: true });
    base.command.push("--harness-fake", fake, "--harness-home", home);
    base.forget.push("--harness-home", home);
  }
} else if (agent === "opencode") {
  base.command = ["opencode", "acp"];
  base.forget = ["opencode", "session", "delete", "{session}"];
} else if (agent === "dsh") base.command = ["dsh", "--profile", "acp"];
else {
  console.error("no agent " + agent + "; harness, opencode, dsh, or --command");
  process.exit(2);
}
base.effort = value("--effort", "");
base.keep = args.includes("--keep");
const models = value("--model", "").split(",").filter((m) => m.length > 0);
const only = value("--tasks", "").split(",").filter((t) => t.length > 0);
const repeat = Math.max(1, Number(value("--repeat", "1")) || 1);
const budget = Number(value("--budget", "-1"));
const home = process.env["WIDECODE_HOME"] ?? "";
const store = home.length > 0 ? home : join(process.env["HOME"] ?? "", ".widecode");
const pricesFile = value("--prices", "");
const prices = pricesFile.length > 0 ? pricesFromFile(pricesFile) : pricesFromConfig(join(store, "config.json"));
const tasks: BenchTask[] = loadTasks(join(here, "tasks"), only);
const out = value("--out", join(here, "results", stamp() + "-" + base.agent + ".jsonl"));
mkdirSync(dirname(out), { recursive: true });
if (tasks.length === 0) {
  console.error("no tasks" + (only.length > 0 ? " named " + only.join(", ") : ""));
  process.exit(2);
}

const results: RunResult[] = [];
let spent = 0;
const run = async (): Promise<void> => {
  for (const model of models.length > 0 ? models : [""])
    for (const task of tasks)
      for (let i = 0; i < repeat; i++) {
        if (budget >= 0 && spent >= budget) {
          console.log("the budget of $" + budget.toFixed(2) + " is spent: stopping");
          return;
        }
        const spec = new RunSpec();
        spec.agent = base.agent;
        spec.command = base.command;
        spec.forget = base.forget;
        spec.effort = base.effort;
        spec.keep = base.keep;
        spec.model = model;
        spec.prices = prices;
        const r = await runTask(task, spec);
        const cost = r.computedCostUsd >= 0 ? r.computedCostUsd : r.costUsd;
        if (cost > 0) spent += cost;
        results.push(r);
        appendFileSync(out, r.line() + "\n");
        console.log((r.passed ? "pass " : "FAIL ") + task.name + " · " + base.agent + " " + (model.length > 0 ? model : "(default)") + " · " + (r.ms / 1000).toFixed(1) + " s · " + String(r.calls) + " calls" + (r.costUsd >= 0 ? " · $" + r.costUsd.toFixed(4) : "") + (r.error.length > 0 ? " · " + r.error.slice(0, 160) : ""));
      }
};

run().then(() => {
  console.log("\n" + reportText(results) + "\n\nthe records: " + out);
});
