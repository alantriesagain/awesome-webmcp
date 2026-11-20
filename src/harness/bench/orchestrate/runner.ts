// One orchestration run: a folder with each part's repository, a fresh store (its auth.json a link to
// the user's, the folder trusted, config.json naming the orchestrator and the Task target), the
// guidance in `.widecode/prompt.md`, dist/widecode started in the folder through test/drive.py's App,
// the task's prompt sent, and the run followed until a turn ended, no background subagent is still
// out and nothing changed for 30 seconds, or the task's time ran out. Then the app is closed, each
// part's check runs in its subfolder, and the numbers are read from the orchestrator's session file,
// its subagents' opencode exports and the app's log.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordOf, str } from "@lightstart/lib/json.ts";
import { HarnessMeasures, SubagentUse, pendingBackground, readClaudeTranscript, readHarnessSession, readLogSignal, subagentFromExport, subagentSessions, subagentTotals } from "./measures.ts";
import { OrchestrateRecord } from "./record.ts";
import { SetupSpec, claudeProjectDir, createSetup, harnessSessionsRoot } from "./setup.ts";
import { OrchestrateTask, checkParts } from "./tasks.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** How long nothing may change before a run is done. */
export const QUIET_MS = 30000;
/** How often the log and session are read while a run goes. */
const POLL_MS = 2000;
/** How long a start may take before the prompt is asked for without a turn opening. */
const START_MS = 180000;

/** The binary the benchmark drives (dist/widecode, built by `pnpm light build`). */
export const binaryPath = (): string => join(here, "..", "..", "..", "..", "dist", "widecode");

/** What one orchestration run starts with. */
export class OrchestrateSpec {
  orchestrator = "harness";
  model = "";
  /** How many runs of a task and orchestrator this is, for the transcript's name (1-based). */
  repeat = 1;
  targetAgent = "opencode";
  targetModel = "opencode-go/deepseek-v4.1-flash";
  targetDescription = "DeepSeek subagent";
  /** The delegation guidance every orchestrator is given. */
  promptText = "";
  keep = false;
}

/** A JSON command and its answer over the bridge to test/drive.py's App. */
class Bridge {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiting: ((answer: Record<string, unknown>) => void) | null = null;

  constructor() {
    this.proc = spawn("python3", [join(here, "drive_bridge.py")], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const at = this.buffer.indexOf("\n");
        if (at < 0) return;
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const answer = recordOf(JSON.parse(line));
        const then = this.waiting;
        this.waiting = null;
        if (then !== null && answer !== null) then(answer);
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => undefined);
  }

  request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((settle) => {
      this.waiting = settle;
      this.proc.stdin.write(JSON.stringify(command) + "\n");
    });
  }

  stop(): void {
    if (!this.proc.killed) this.proc.kill();
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

const textOf = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Every .jsonl under `dir`, recursively. */
const jsonlFiles = (dir: string): string[] => {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...jsonlFiles(path));
    else if (name.endsWith(".jsonl")) out.push(path);
  }
  return out;
};

const newest = (paths: string[]): string => {
  let best = "";
  let bestMs = -1;
  for (const path of paths) {
    try {
      const ms = statSync(path).mtimeMs;
      if (ms > bestMs) {
        bestMs = ms;
        best = path;
      }
    } catch {
      // A file that went away is no candidate.
    }
  }
  return best;
};

/** The run's orchestrator session: the harness's newest session file, or Claude's transcript for the folder. */
export const sessionFile = (orchestrator: string, store: string, folder: string): string => {
  if (orchestrator === "claude") {
    const dir = claudeProjectDir(folder);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return "";
    }
    return newest(names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n)));
  }
  return newest(jsonlFiles(harnessSessionsRoot(store)));
};

/** The session's text right now ("" before it is written). */
export const sessionText = (orchestrator: string, store: string, folder: string): string => textOf(sessionFile(orchestrator, store, folder));

/** Whether the run is done: a turn ended, none is open, no background subagent is still out, and nothing changed for `quietMs`. */
export class DoneSignal {
  done = false;
  timedOut = false;
  started = false;
  error = "";
}

/** Follow a run's log and session until done or past `deadline`, answering what happened. */
export const waitDone = async (orchestrator: string, store: string, folder: string, log: string, deadline: number, quietMs = QUIET_MS): Promise<DoneSignal> => {
  const signal = new DoneSignal();
  const began = Date.now();
  let lastKey = "";
  let lastRelevant = began;
  while (Date.now() < deadline) {
    const text = textOf(log);
    const logSignal = readLogSignal(text);
    if (logSignal.started > 0) signal.started = true;
    const session = sessionText(orchestrator, store, folder);
    const started = orchestrator === "claude" ? readClaudeTranscript(session).backgroundIds : readHarnessSession(session).backgroundIds;
    const pending = pendingBackground(started, logSignal);
    const key = [logSignal.started, logSignal.ended, logSignal.running, logSignal.finished.join(","), logSignal.failed.join(","), pending.join(",")].join("|");
    if (key !== lastKey) {
      lastKey = key;
      lastRelevant = Date.now();
    }
    if (logSignal.idleAfterTurn() && pending.length === 0 && Date.now() - lastRelevant >= quietMs) {
      signal.done = true;
      return signal;
    }
    if (!signal.started && Date.now() - began > START_MS) {
      signal.error = "no turn opened within " + String(Math.round(START_MS / 1000)) + " s";
      return signal;
    }
    await sleep(POLL_MS);
  }
  signal.timedOut = true;
  signal.error = "the task took longer than " + String(Math.round((Date.now() - began) / 1000)) + " s";
  return signal;
};

const findSubagents = (spec: OrchestrateSpec, folder: string, since: number): SubagentUse[] => {
  const out: SubagentUse[] = [];
  if (spec.targetAgent !== "opencode") return out;
  const list = spawnSync("opencode", ["session", "list", "--format", "json"], { cwd: folder, encoding: "utf8", timeout: 30000 });
  if (list.status !== 0 || typeof list.stdout !== "string") return out;
  for (const id of subagentSessions(list.stdout, folder, since)) {
    const exported = spawnSync("opencode", ["export", id], { cwd: folder, encoding: "utf8", timeout: 30000 });
    if (exported.status !== 0 || typeof exported.stdout !== "string") continue;
    const sub = subagentFromExport(id, spec.targetAgent, exported.stdout);
    if (sub !== null) out.push(sub);
  }
  return out;
};

const readMeasures = (orchestrator: string, store: string, folder: string): HarnessMeasures => {
  const text = sessionText(orchestrator, store, folder);
  return orchestrator === "claude" ? readClaudeTranscript(text) : readHarnessSession(text);
};

/** Run `task` once for `spec`, writing its transcript files under `outDir`. */
export const runOne = async (task: OrchestrateTask, partRoot: string, spec: OrchestrateSpec, outDir: string): Promise<OrchestrateRecord> => {
  const record = new OrchestrateRecord();
  record.task = task.name;
  record.orchestrator = spec.orchestrator;
  record.model = spec.model;
  record.repeat = spec.repeat;
  const setupSpec = new SetupSpec();
  setupSpec.orchestrator = spec.orchestrator;
  setupSpec.model = spec.model;
  setupSpec.promptText = spec.promptText;
  setupSpec.targetAgent = spec.targetAgent;
  setupSpec.targetModel = spec.targetModel;
  setupSpec.targetDescription = spec.targetDescription;
  const setup = createSetup(task, partRoot, setupSpec);
  record.folder = setup.folder;
  const transcriptDir = join(outDir, task.name + "-" + spec.orchestrator + "-" + String(spec.repeat));
  mkdirSync(transcriptDir, { recursive: true });
  record.files.session = join(transcriptDir, "session.jsonl");
  record.files.log = join(transcriptDir, "app.log");
  record.files.screen = join(transcriptDir, "screen.txt");
  const bridge = new Bridge();
  let screen = "";
  let timedOut = false;
  try {
    const args = ["--agent", spec.orchestrator];
    if (spec.orchestrator === "claude" && spec.model.length > 0) args.push("--model", spec.model);
    const started = await bridge.request({ op: "start", folder: setup.folder, log: setup.log, args });
    if (started["ok"] !== true) {
      record.setupFailed = true;
      record.error = str(started["error"]);
    } else {
      const sentAt = Date.now();
      await bridge.request({ op: "send", text: task.prompt });
      const done = await waitDone(spec.orchestrator, setup.store, setup.folder, setup.log, sentAt + task.timeoutMs);
      record.ms = Date.now() - sentAt;
      record.setupFailed = !done.started;
      record.timedOut = done.timedOut;
      record.error = done.error;
      timedOut = done.timedOut;
      try {
        const shot = await bridge.request({ op: "screen" });
        if (shot["ok"] === true) screen = str(shot["screen"]);
      } catch {
        screen = "";
      }
      await bridge.request({ op: "close" });
    }
  } catch (err: unknown) {
    record.error = err instanceof Error ? err.message : String(err);
    record.setupFailed = true;
  } finally {
    bridge.stop();
  }
  const session = textOf(sessionFile(spec.orchestrator, setup.store, setup.folder));
  const logText = textOf(setup.log);
  writeFileSync(record.files.session, session);
  writeFileSync(record.files.log, logText);
  writeFileSync(record.files.screen, screen);
  const measures = readMeasures(spec.orchestrator, setup.store, setup.folder);
  record.requests = measures.usage.requests;
  record.inputTokens = measures.usage.input + measures.usage.cacheRead + measures.usage.cacheWrite;
  record.cacheReadTokens = measures.usage.cacheRead;
  record.outputTokens = measures.usage.output;
  record.costUsd = measures.usage.costUsd;
  record.ownEdits = measures.edits;
  record.ownWrites = measures.writes;
  record.taskCalls = measures.taskCalls;
  record.taskBackground = measures.taskBackground;
  record.taskForeground = Math.max(0, measures.taskCalls - measures.taskBackground);
  const subs = timedOut ? [] : findSubagents(spec, setup.folder, Date.now() - record.ms - 5000);
  record.subagents = subs;
  const subTotals = subagentTotals(subs);
  record.subagentCostUsd = subs.length === 0 ? 0 : subTotals.costUsd;
  record.subagentInputTokens = subTotals.input + subTotals.cacheRead;
  record.subagentOutputTokens = subTotals.output;
  record.subagentCacheReadTokens = subTotals.cacheRead;
  record.totalCostUsd = record.costUsd >= 0 && record.subagentCostUsd >= 0 ? record.costUsd + record.subagentCostUsd : -1;
  record.parts = checkParts(task, partRoot, setup.folder);
  record.passed = record.parts.length === task.parts.length && record.parts.every((p) => p.passed);
  if (!spec.keep) {
    rmSync(setup.folder, { recursive: true, force: true });
    rmSync(setup.store, { recursive: true, force: true });
  }
  return record;
};

