// `node src/harness/bench/run.ts [options]`: the benchmark. Each task of `bench/tasks` (or
// those `--tasks` names) runs `--repeat` times with each `--model` on the agent, the records
// appended to `--out` (a JSONL file, under `bench/results/` by default) and the table printed at
// the end. It talks to real models and spends real money: `--budget <dollars>` stops starting
// runs once the cost the agent reported passes it.
//
//   --agent <name>[,<name>...]           the agents (harness by default: this checkout's daemon under node;
//                                        opencode and dsh over ACP, pi over its RPC mode)
//   --binary                             the harness from the installed `lightcode` instead
//   --command "<words>"                  any other ACP agent, started in the task's folder
//   --model <value>[,<value>...]         the models to compare, as the agent's model option names them
//   --effort <value>                     the effort, as its effort option names it
//   --tasks <name>[,<name>...]           some of the tasks
//   --web, --no-web                      only the tasks that need the web, or only those that do not
//   --repeat <n>                         runs of each task, model and agent (1)
//   --retries <n>                        runs again after a setup failure, keeping the last record (1)
//   --user-store                         run the harness over the user's ~/.lightcode and opencode over the
//                                        user's config, as they do for the app, rather than fresh temp folders
//   --fake <fixture>                     the harness on its fake model (the runner's own test)
//   --prices <file.json>                 model prices, per million tokens (`{ "<model>": [input, output, cacheRead] }`);
//                                        by default the harness's registry: its built-in models and those config.json adds
//   --keep                               keep each run's folder, its store or config folder
//   --report <file.jsonl>...             print the table of earlier results, run nothing
//
// A run's transcript goes beside the records: for `--out <dir>/<name>.jsonl`, `<dir>/<name>/`
// holds `<task>-<agent>-<k>.jsonl`, k counting that task and agent's runs.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flagsReport } from "./detect.ts";
import { reportText } from "./report.ts";

/** The table, then what the runs' transcripts show an agent wasted (none when no run kept one). */
const fullReport = (results: RunResult[]): string => {
  const flags = flagsReport(results.map((r) => r.transcript).filter((p) => p.length > 0 && existsSync(p)));
  return reportText(results) + (flags.length > 0 ? "\n\n## Flags\n\n" + flags : "");
};
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
  console.log(fullReport(results));
  process.exit(0);
}

const main = join(here, "..", "main.ts");
const fake = value("--fake", "");
const commandGiven = args.includes("--command");
const specFor = (agent: string): RunSpec => {
  const spec = new RunSpec();
  spec.agent = agent;
  if (commandGiven) {
    spec.command = value("--command", "").split(/\s+/).filter((w) => w.length > 0);
    spec.agent = value("--agent", spec.command[0] ?? "agent");
  } else if (agent === "harness") {
    spec.command = args.includes("--binary") ? ["lightcode", "--harness"] : ["node", main, "--harness"];
    spec.forget = args.includes("--binary") ? ["lightcode", "--harness-forget", "{session}"] : ["node", main, "--harness-forget", "{session}"];
    if (fake.length > 0) {
      const home = join(here, "results", "fake-home");
      mkdirSync(home, { recursive: true });
      spec.command.push("--harness-fake", fake, "--harness-home", home);
      spec.forget.push("--harness-home", home);
    }
  } else if (agent === "opencode") {
    spec.command = ["opencode", "acp"];
    // opencode's websearch, which calls Exa as the harness's does, is off unless this says otherwise.
    spec.env = { OPENCODE_ENABLE_EXA: "1" };
    spec.usage = ["opencode", "export", "{session}"];
    spec.forget = ["opencode", "session", "delete", "{session}"];
  } else if (agent === "dsh") spec.command = ["dsh", "--profile", "acp"];
  else if (agent === "pi") spec.command = ["pi"];
  else {
    console.error("no agent " + agent + "; harness, opencode, dsh, pi, or --command");
    process.exit(2);
  }
  spec.effort = value("--effort", "");
  spec.keep = args.includes("--keep");
  spec.userStore = args.includes("--user-store");
  return spec;
};
const commandWords = value("--command", "").split(/\s+/).filter((w) => w.length > 0);
const agentNames = commandGiven
  ? [value("--agent", commandWords[0] ?? "agent")]
  : value("--agent", "harness").split(",").map((a) => a.trim()).filter((a) => a.length > 0);
if (agentNames.length === 0) agentNames.push("harness");
const bases = agentNames.map((name) => specFor(name));
const models = value("--model", "").split(",").filter((m) => m.length > 0);
const only = value("--tasks", "").split(",").filter((t) => t.length > 0);
const repeat = Math.max(1, Number(value("--repeat", "1")) || 1);
const retries = Math.max(0, Math.trunc(Number(value("--retries", "1"))) || 0);
const budget = Number(value("--budget", "-1"));
const home = process.env["LIGHTCODE_HOME"] ?? "";
const store = home.length > 0 ? home : join(process.env["HOME"] ?? "", ".lightcode");
const pricesFile = value("--prices", "");
const prices = pricesFile.length > 0 ? pricesFromFile(pricesFile) : pricesFromConfig(join(store, "config.json"));
let tasks: BenchTask[] = loadTasks(join(here, "tasks"), only);
if (args.includes("--web")) tasks = tasks.filter((t) => t.web);
if (args.includes("--no-web")) tasks = tasks.filter((t) => !t.web);
const out = value("--out", join(here, "results", stamp() + "-" + agentNames.join("+") + ".jsonl"));
mkdirSync(dirname(out), { recursive: true });
const transcriptDir = out.endsWith(".jsonl") ? out.slice(0, -".jsonl".length) : out;
mkdirSync(transcriptDir, { recursive: true });
if (tasks.length === 0) {
  console.error("no tasks" + (only.length > 0 ? " named " + only.join(", ") : ""));
  process.exit(2);
}

const results: RunResult[] = [];
const counts = new Map<string, number>();
let spent = 0;
const run = async (): Promise<void> => {
  for (let i = 0; i < repeat; i++)
    for (const task of tasks)
      for (const model of models.length > 0 ? models : [""])
        for (const spec of bases) {
          if (budget >= 0 && spent >= budget) {
            console.log("the budget of $" + budget.toFixed(2) + " is spent: stopping");
            return;
          }
          spec.model = model;
          spec.prices = prices;
          const key = task.name + "\u0000" + spec.agent;
          const k = (counts.get(key) ?? 0) + 1;
          counts.set(key, k);
          spec.transcript = join(transcriptDir, task.name + "-" + spec.agent + "-" + String(k) + ".jsonl");
          let r = await runTask(task, spec);
          for (let attempt = 0; attempt < retries && r.setupFailed; attempt++) r = await runTask(task, spec);
          const cost = r.computedCostUsd >= 0 ? r.computedCostUsd : r.costUsd;
          if (cost > 0) spent += cost;
          results.push(r);
          appendFileSync(out, r.line() + "\n");
          console.log((r.setupFailed ? "SETUP " : r.passed ? "pass " : "FAIL ") + task.name + " · " + spec.agent + " " + (model.length > 0 ? model : "(default)") + " · " + (r.ms / 1000).toFixed(1) + " s · " + String(r.calls) + " calls" + (r.costUsd >= 0 ? " · $" + r.costUsd.toFixed(4) : "") + (r.error.length > 0 ? " · " + r.error.slice(0, 160) : ""));
        }
};

run().then(() => {
  console.log("\n" + fullReport(results) + "\n\nthe records: " + out);
});
