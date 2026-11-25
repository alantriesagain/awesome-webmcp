// The folder and store one orchestration run gets. The folder holds each part's repository in a
// subfolder of its own, committed once so the agent sees a project, and `.lightcode/prompt.md`, the
// delegation guidance every orchestrator runs with. The store is fresh: its auth.json is a symbolic
// link to the user's key file (never read or copied), trusted.json names the run's folder, and
// config.json picks the orchestrator and the subagent target. Claude Code still runs on its own login.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrateTask, assembleRepo } from "./tasks.ts";

/** The user's store: $LIGHTCODE_HOME, else ~/.lightcode. */
export const userStoreRoot = (): string => {
  const env = process.env["LIGHTCODE_HOME"] ?? "";
  return env.length > 0 ? env : join(homedir(), ".lightcode");
};

/** One run's folder and store, and where its app log goes. */
export class RunSetup {
  folder = "";
  store = "";
  log = "";
  /** The task's time in all. */
  timeoutMs = 1800000;
}

/** What a run starts: the orchestrator, its model, the subagent target and the guidance text. */
export class SetupSpec {
  orchestrator = "harness";
  model = "";
  promptText = "";
  targetAgent = "opencode";
  targetModel = "opencode-go/deepseek-v4.1-flash";
  targetDescription = "DeepSeek subagent";
}

const git = (dir: string, args: string[]): void => {
  spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
};

/** The config.json a run's store gets: the orchestrator, the harness model and the Task targets. */
const configText = (spec: SetupSpec): string => {
  const tasks = {
    replaceClaudeSubagents: true,
    targets: {
      deepseek: { agent: spec.targetAgent, model: spec.targetModel, description: spec.targetDescription },
    },
    maxConcurrent: 4,
    timeoutMs: 900000,
  };
  return JSON.stringify({ agent: spec.orchestrator, harness: { model: spec.model }, plugins: { acp: { tasks } } }, null, 2) + "\n";
};

/** Make the run's folder and store, assemble the task's repository and commit it. */
export const createSetup = (task: OrchestrateTask, partRoot: string, spec: SetupSpec): RunSetup => {
  const setup = new RunSetup();
  setup.timeoutMs = task.timeoutMs;
  setup.folder = mkdtempSync(join(tmpdir(), "orchestrate-" + task.name + "-"));
  assembleRepo(task, partRoot, setup.folder);
  git(setup.folder, ["init", "-q", "-b", "main"]);
  git(setup.folder, ["add", "-A"]);
  git(setup.folder, ["-c", "user.email=bench@lightcode", "-c", "user.name=bench", "commit", "-qm", "the task"]);
  mkdirSync(join(setup.folder, ".lightcode"), { recursive: true });
  writeFileSync(join(setup.folder, ".lightcode", "prompt.md"), spec.promptText);
  setup.store = mkdtempSync(join(tmpdir(), "orchestrate-store-"));
  const auth = join(userStoreRoot(), "auth.json");
  if (existsSync(auth)) symlinkSync(auth, join(setup.store, "auth.json"));
  writeFileSync(join(setup.store, "trusted.json"), JSON.stringify([setup.folder], null, 2) + "\n");
  writeFileSync(join(setup.store, "config.json"), configText(spec));
  // Lightcode's approval mode "full": no orchestrator stops on a permission question nobody answers.
  // Claude Code asked one on its first command writing outside the folder and waited out the run;
  // the harness met none, so the comparison measured the question. lightcode keeps the mode in state.json.
  writeFileSync(join(setup.store, "state.json"), JSON.stringify({ approval: "full" }) + "\n");
  setup.log = join(setup.store, "app.log");
  return setup;
};

/** The Claude Code projects folder for a run's `folder`: the plugin's default, `<root>/<folder, non-alphanumerics as '-'>`. */
export const claudeProjectDir = (folder: string): string => {
  const env = process.env["CLAUDE_CONFIG_DIR"] ?? "";
  const root = env.length > 0 ? join(env, "projects") : join(homedir(), ".claude", "projects");
  return join(root, folder.replace(/[^A-Za-z0-9]/g, "-"));
};

/** The harness's sessions root in a store. */
export const harnessSessionsRoot = (store: string): string => join(store, "harness", "sessions");
