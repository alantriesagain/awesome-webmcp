// The tasks section: the subagent targets, the bounds on them and the box a boxed target needs, the
// box runner, and the ACP main's in-flight calls of lightcode's Task tool.

import { obj, str, list } from "./json.ts";
import { quote } from "./shell.ts";

/** A subagent target: the `subagent_type` Claude names, the agent entry it runs on, its model ("" for the entry's default), what it is for, and the box kind it runs in ("" when it is unboxed). */
export interface TaskTarget {
  name: string;
  agent: string;
  model: string;
  description: string;
  box: string;
}

/** The box a boxed target runs in: the box script, the host proxy's port, the memory the box gets, the folders it shares beside the session's, its backend kind, the domains its proxy allows beside the defaults (["*"] for any host) and, for the VM, the idle minutes before it stops. */
interface BoxConfig {
  script: string;
  proxyPort: number;
  memory: number;
  projects: string[];
  kind: "bwrap" | "vm";
  allow: string[];
  idleMinutes: number;
}

/** The `tasks` section: whether Claude's own subagent tools are replaced, the targets, the bounds, and the box a boxed target needs. */
interface TasksConfig {
  replace: boolean;
  targets: TaskTarget[];
  box: BoxConfig | null;
  maxConcurrent: number;
  timeoutMs: number;
  worktreeSetup: string[];
  worktreeSetupTimeoutMs: number;
}

export const tasksOf = (section: unknown): TasksConfig => {
  const t = obj(obj(section)?.tasks);
  const out: TasksConfig = { replace: t?.replaceClaudeSubagents === true, targets: [], box: null, maxConcurrent: 4, timeoutMs: 1800000, worktreeSetup: [], worktreeSetupTimeoutMs: 300000 };
  const b = obj(t?.box);
  let kind: "bwrap" | "vm" = "bwrap";
  if (b !== null && str(b.script).length > 0) {
    const proxyPort = typeof b.proxyPort === "number" && b.proxyPort >= 1 && b.proxyPort <= 65535 ? Math.floor(b.proxyPort) : 8888;
    const memory = typeof b.memory === "number" && b.memory >= 512 ? Math.floor(b.memory) : 4096;
    const idleMinutes = typeof b.idleMinutes === "number" && b.idleMinutes > 0 ? b.idleMinutes : 10;
    kind = str(b.kind) === "vm" ? "vm" : "bwrap";
    out.box = { script: str(b.script), proxyPort, memory, projects: list(b.projects).filter((w): w is string => typeof w === "string" && w.length > 0), kind, allow: list(b.allow).filter((w): w is string => typeof w === "string" && w.length > 0), idleMinutes };
  }
  const targets = obj(t?.targets);
  if (targets !== null)
    for (const name of Object.keys(targets)) {
      const e = obj(targets[name]);
      if (e === null) continue;
      const agent = str(e.agent).length > 0 ? str(e.agent) : name;
      const model = str(e.model);
      const wanted = e.box;
      const box = wanted === true ? kind : wanted === "bwrap" || wanted === "vm" ? wanted : "";
      out.targets.push({ name, agent, model, description: str(e.description).length > 0 ? str(e.description) : "Runs on " + (model.length > 0 ? model : agent), box });
    }
  if (typeof t?.maxConcurrent === "number" && t.maxConcurrent > 0) out.maxConcurrent = Math.floor(t.maxConcurrent);
  if (typeof t?.timeoutMs === "number" && t.timeoutMs >= 1000) out.timeoutMs = Math.floor(t.timeoutMs);
  out.worktreeSetup = list(t?.worktreeSetup).filter((w): w is string => typeof w === "string" && w.length > 0);
  if (typeof t?.worktreeSetupTimeoutMs === "number" && t.worktreeSetupTimeoutMs >= 1000) out.worktreeSetupTimeoutMs = Math.floor(t.worktreeSetupTimeoutMs);
  return out;
};

/**
 * The box a boxed run starts in: it reads the box's status and keeps its host proxy running. The
 * VM backend also starts the box with the session's folder and the configured projects, and stops
 * it once no VM run has been in flight for `idleMinutes`. The bwrap backend needs only the proxy.
 * Calls are serialized, so two runs at once never start a second box.
 */
export class BoxRunner {
  private readonly api: lightcode.Api;
  readonly config: BoxConfig;
  private proxy: lightcode.ProcessHandle | null = null;
  /** The local MCP port the running proxy lets in (0 for none): a boxed subagent's HostAction calls go through it. */
  private localMcp = 0;
  private chain: Promise<void> = Promise.resolve();
  private vmRuns = 0;
  private idleGen = 0;

  constructor(api: lightcode.Api, config: BoxConfig) {
    this.api = api;
    this.config = config;
  }

  /** A VM run starts: it keeps the box up, and a pending idle stop is dropped. */
  enterVm(): void {
    this.vmRuns++;
    this.idleGen++;
  }

  /** A VM run ended: with none left, the box stops after the idle minutes unless another run starts. */
  leaveVm(): void {
    if (this.vmRuns > 0) this.vmRuns--;
    if (this.vmRuns !== 0) return;
    const gen = ++this.idleGen;
    const ms = Math.max(1, Math.round(this.config.idleMinutes * 60000));
    this.api.after(ms, () => {
      if (gen !== this.idleGen || this.vmRuns !== 0) return;
      const command = ["node", this.config.script, "down", "--if-idle"].map(quote).join(" ");
      this.api.process.run(command, "", 90000).then((r) => {
        const said = r.out.trim().length > 0 ? r.out.trim() : r.err.trim();
        if (said.length > 0) this.api.note("box down: " + said);
      });
    });
  }

  /** The box's own state: whether it runs, its projects and whether its proxy runs. */
  private status(): Promise<{ running: boolean; projects: string[]; proxy: boolean }> {
    const command = ["node", this.config.script, "status", "--json"].map(quote).join(" ");
    return this.api.process.run(command, "", 30000).then((r) => {
      if (r.code !== 0) throw new Error((r.err.trim().length > 0 ? r.err.trim() : r.out.trim()) || "the box's status failed");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.out);
      } catch {
        throw new Error("the box's status printed no JSON: " + r.out.trim());
      }
      const s = obj(parsed);
      return { running: s?.running === true, projects: list(s?.projects).filter((p): p is string => typeof p === "string"), proxy: s?.proxy === true };
    });
  }

  /** If a boxed run brings HostAction, the proxy must let that run's MCP port in; an earlier proxy without it goes. */
  setLocalMcp(port: number): void {
    if (port === this.localMcp) return;
    this.localMcp = port;
    if (this.proxy !== null) {
      this.proxy.stop(1000);
      this.proxy = null;
    }
  }

  private startProxy(): Promise<void> {
    if (this.proxy !== null && this.proxy.started) return Promise.resolve();
    const base = this.config.script;
    const script = base.endsWith("/box.mjs") ? base.slice(0, base.length - "box.mjs".length) + "proxy.mjs" : base;
    const command = ["node", script, "proxy", "--port", String(this.config.proxyPort)];
    if (this.config.allow.length > 0) command.push("--allow-extra", this.config.allow.join(","));
    if (this.localMcp > 0) command.push("--allow-local", String(this.localMcp));
    const p = this.api.process.spawn(command, {}, {
      lines: (lines) => {
        for (const l of lines) this.api.note("box proxy: " + l);
      },
      error: (text) => this.api.note("box proxy: " + text.trimEnd()),
    });
    if (!p.started) return Promise.reject(new Error("cannot start the box's proxy"));
    this.proxy = p;
    return Promise.resolve();
  }

  private async ready(folder: string, kind: string): Promise<string> {
    const s = await this.status();
    if (!s.proxy) await this.startProxy();
    if (kind === "bwrap") return "";
    const desired = [folder, ...this.config.projects];
    const same = s.running && s.projects.length === desired.length && s.projects.every((p, i) => p === desired[i]);
    if (same) return "";
    const up = await this.api.process.run(["node", this.config.script, "up", "--memory", String(this.config.memory), ...desired].map(quote).join(" "), "", 120000);
    if (up.code !== 0) return (up.err.trim().length > 0 ? up.err.trim() : up.out.trim()) || "the box did not start";
    return "";
  }

  /** "" when the box of `kind` runs with `folder` and the configured projects, else why not. */
  ensure(folder: string, kind: string): Promise<string> {
    const next = this.chain.then(() =>
      this.ready(folder, kind).then(
        (why) => why,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      ),
    );
    this.chain = next.then(() => {});
    return next;
  }

  stop(): void {
    if (this.proxy !== null) this.proxy.stop(1000);
    this.proxy = null;
  }
}

/** A call of lightcode's Task tool that the ACP main announced and has not completed: which call, and what it asked. */
class PendingTask {
  readonly id: string;
  prompt: string;
  description: string;
  claimed = false;

  constructor(id: string, prompt: string, description: string) {
    this.id = id;
    this.prompt = prompt;
    this.description = description;
  }
}

/**
 * The ACP main's calls of lightcode's Task tool that are in flight: it announces each with a
 * toolCallId of its own and the call's input, so the Task tool runs under that card instead of
 * making one. A call is dropped once it completes or fails.
 */
export class TaskCalls {
  private calls: PendingTask[] = [];

  /** Keep call `id`, or update what it asks, while it is in flight. */
  record(id: string, prompt: string, description: string): void {
    const found = this.calls.find((c) => c.id === id);
    if (found !== undefined) {
      found.prompt = prompt;
      found.description = description;
      return;
    }
    this.calls.push(new PendingTask(id, prompt, description));
  }

  /** The call is over: drop it. */
  done(id: string): void {
    this.calls = this.calls.filter((c) => c.id !== id);
  }

  /** Claim the oldest unclaimed call that asked for `prompt` with `description`; "" when none does. */
  claim(prompt: string, description: string): string {
    const found = this.calls.find((c) => !c.claimed && c.prompt === prompt && c.description === description);
    if (found === undefined) return "";
    found.claimed = true;
    return found.id;
  }
}
