// The orchestration benchmark's tasks and the repository a run gets. A task names parts, each one of
// the single-agent benchmark's tasks; its repository is each part's repository copied into a folder
// of its own, named after the part, so two parts never share a path. The prompt is the task's own:
// it names those folders and says what is wanted there. The parts' own prompts are not changed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { num, recordOf, str, strs } from "@lightstart/lib/json.ts";

/** One of the single benchmark's tasks, used as a part. */
export class PartTask {
  readonly name: string;
  readonly dir: string;
  prompt = "";
  timeoutMs = 300000;
  web = false;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
  }
}

/** A task the orchestration benchmark runs: its prompt, its parts and its time. */
export class OrchestrateTask {
  readonly name: string;
  readonly dir: string;
  prompt = "";
  parts: string[] = [];
  timeoutMs = 1800000;

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
  }

  /** Whether one of its parts searches the web. */
  web(partRoot: string): boolean {
    for (const name of this.parts) {
      const part = loadPart(partRoot, name);
      if (part !== null && part.web) return true;
    }
    return false;
  }
}

/** The part `name` under `partRoot`, null when it has no task.json. */
export const loadPart = (partRoot: string, name: string): PartTask | null => {
  const dir = join(partRoot, name);
  const file = join(dir, "task.json");
  if (!existsSync(file)) return null;
  const spec = recordOf(JSON.parse(readFileSync(file, "utf8")));
  if (spec === null) return null;
  const part = new PartTask(name, dir);
  part.prompt = str(spec["prompt"]);
  part.timeoutMs = num(spec["timeoutMs"], part.timeoutMs);
  part.web = spec["web"] === true;
  return part;
};

/** The tasks under `root`, those in `only` when it names any, by name. */
export const loadTasks = (root: string, partRoot: string, only: string[]): OrchestrateTask[] => {
  const out: OrchestrateTask[] = [];
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
    const task = new OrchestrateTask(name, join(root, name));
    task.prompt = str(spec["prompt"]);
    task.timeoutMs = num(spec["timeoutMs"], task.timeoutMs);
    task.parts = strs(spec["parts"]).filter((p) => existsSync(join(partRoot, p, "task.json")));
    if (task.parts.length === 0) continue;
    out.push(task);
  }
  return out;
};

/** The folder `part` works in, inside the run's `folder`. */
export const partFolder = (folder: string, part: string): string => join(folder, part);

/** Assemble the run's repository: each named part's repo into a subfolder of its own (`parts` limits it). */
export const assembleRepo = (task: OrchestrateTask, partRoot: string, folder: string, parts: string[] = task.parts): void => {
  for (const name of parts) cpSync(join(partRoot, name, "repo"), partFolder(folder, name), { recursive: true });
};

/** Copy each part's solution into its subfolder. */
export const copySolutions = (task: OrchestrateTask, partRoot: string, folder: string, parts: string[] = task.parts): void => {
  for (const name of parts) {
    const solution = join(partRoot, name, "solution");
    if (existsSync(solution)) cpSync(solution, partFolder(folder, name), { recursive: true });
  }
};

/** One part's check's result. */
export class PartVerdict {
  name = "";
  passed = false;
  output = "";
}

/** Run each part's check.mjs in its own subfolder. */
export const checkParts = (task: OrchestrateTask, partRoot: string, folder: string, timeoutMs = 120000): PartVerdict[] => {
  const out: PartVerdict[] = [];
  for (const name of task.parts) {
    const verdict = new PartVerdict();
    verdict.name = name;
    const run = spawnSync("node", [join(partRoot, name, "check.mjs")], { cwd: partFolder(folder, name), encoding: "utf8", timeout: timeoutMs });
    verdict.passed = run.status === 0;
    verdict.output = ((run.stdout ?? "") + (run.stderr ?? "")).trim().slice(0, 600);
    out.push(verdict);
  }
  return out;
};
