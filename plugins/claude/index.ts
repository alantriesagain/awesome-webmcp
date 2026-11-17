// Claude Code as widecode's agent: its CLI (`claude -p` over stream-json) started on the first
// message, what it writes read into the conversation as events, what the user does written to it.
// Its records (live, and a session's transcript under ~/.claude/projects read on resume) are read
// here: a message's content blocks keyed by message and index (or a call's id), stream events
// previewing them, a call's facts from Claude's tools table, a subagent's records under its call,
// questions and plans for the request panel, and the status Claude Code's status line gets. A
// permission prompt the user need not see is allowed at once; one about a path outside the
// session's folders offers the folder, for the session or from now on. The Sessions tab lists the
// folder's transcripts, titled by Claude Code's own records. The skills Claude Code lists at start
// go to the conversation with what each SKILL.md says it is for (the project's under .claude/skills,
// the user's under ~/.claude/skills and its synced folder, a plugin's under the plugin's path; a
// bundled skill has no file), each called by typing its name with a slash; before it starts, the
// project's (once the folder is trusted), the user's and the synced ones are read from disk as a
// partial list; a Skill call is a skill call for the Skills tab. `/subagents` picks the session's
// subagents: Claude Code's own, widecode's Task over the acp plugin's targets, or both, and keeps
// the choice in state.json. Its section of config.json: { "id":
// "claude", "projects": "", "configDir": "" } (the id it is chosen by; where Claude Code keeps
// sessions, "" for $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects; where it keeps its config,
// with its skills folder, "" for $CLAUDE_CONFIG_DIR, else ~/.claude).

// The pieces that read those records are in records.ts (the record readers and the session
// listing), tools.ts (the tools table and a call's facts), status.ts (the status line's fields
// and the limit helpers), reader.ts (the live stream read as events) and permissions.ts (the
// permission and subagent helpers).

import type { Ev, Rec, Listed } from "./records.ts";
import type { SubagentTarget, SubagentTasks, SubagentChoice } from "./permissions.ts";
import { rec, str, num, list, parse, safeId, activeChain, summarize } from "./records.ts";
import { replyJson } from "./tools.ts";
import { Status, limitMessage, resetFrom } from "./status.ts";
import { Reader } from "./reader.ts";
import { INTERACTIVE, ALLOW_ALL, PERMISSION_OPTIONS, argumentOf, outsidePath, folderSessionLabel, folderKeptLabel, allowResponse } from "./permissions.ts";

/** A random version 4 UUID (QuickJS has no crypto; Math.random is enough for a message's id). */
const uuidV4 = (): string => {
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return hex(8) + "-" + hex(4) + "-4" + hex(3) + "-" + "89ab"[Math.floor(Math.random() * 4)] + hex(3) + "-" + hex(12);
};

/** The window of a transcript a resume reads, and each "load earlier" before it. */
const HISTORY_BYTES = 4 * 1024 * 1024;
/** How much of a SKILL.md is read for its frontmatter. */
const FRONTMATTER_BYTES = 8192;
/** What Claude Code puts before a synced skill's name (those under ~/.claude/skills/synced/<id>/). */
const SYNCED_PREFIX = "anthropic-skills:";
/** Lines kept of the live stream and of the loaded history; the model is rebuilt from them. */
const LIVE_MAX = 8000;
const HISTORY_MAX = 40000;
/** A process's /proc stat fields from the third (its state) on, past its name, which may hold spaces: [1] the parent's pid, [19] when it started. */
const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(")") + 2).split(" ");
/** Records never shown nor linked: left out of history windows. */
const SKIP_RECORDS = ['{"type":"file-history-snapshot"', '{"type":"file-history-delta"', '{"type":"queue-operation"', '{"type":"atis-latch"', '{"type":"last-prompt"', '{"type":"mode"'];

// The agent: the CLI's process, the session's history, the bookkeeping kept in widecode's store.

const claudeAgent = (api: widecode.Api, id: string, projects: string, config: string, keepSubagents: boolean): widecode.AgentAdapter => {
  let proc: widecode.ProcessHandle | null = null;
  let processes = 0;
  /** widecode's MCP server as this plugin's agent sees it, and whether the CLI restarts at the turn's end to pick up a change to the harness. */
  let server: { url: string; headers: { name: string; value: string }[]; tools: { name: string; category: string }[]; file: string } | null = null;
  let restartWanted = false;
  /** The permission prompts open in the request panel, by the CLI's request id, with the folder each may add ("" for none, else as shown); the calls the user allowed for the session (tool and argument), or every call (`allowAll`); the folders added to the session's, given again to each start. */
  const permissions = new Map<string, { tool: string; input: unknown; key: string; folder: string; shown: string }>();
  const allowedThisSession = new Set<string>();
  let allowAll = false;
  const allowedFolders: string[] = [];
  /** The folder to offer for a path outside the session's: the git repository holding it, else its own folder; "" when that would be the home folder or the root. */
  const folderOf = (path: string): string => {
    const p = path.replace(/\/+$/, "");
    if (!p.startsWith("/")) return "";
    const home = api.fs.home();
    const dir = api.fs.stat(p + "/.") !== null ? p : p.slice(0, p.lastIndexOf("/"));
    for (let at = dir; at.length > 1 && at !== home; at = at.slice(0, at.lastIndexOf("/"))) if (api.fs.stat(at + "/.git") !== null) return at;
    return dir.length > 1 && dir !== home ? dir : "";
  };
  const shownPath = (path: string): string => {
    const home = api.fs.home();
    return home.length > 1 && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
  };
  /** Whether a message started a turn that has not ended, and how many more were written meanwhile (the CLI holds them in its queue, which a restart would lose). */
  let turnOpen = false;
  let sentDuringTurn = 0;
  /** The last message written, for a retry after a limit; whether this plugin is sending it again; and when that is due (0: not scheduled), with a count that drops the run a newer choice replaces. */
  let lastPrompt: { text: string; images: { mediaType: string; data: string; path?: string }[] } | null = null;
  let retrying = false;
  let retryAt = 0;
  let retryGen = 0;
  /** The options the process started with, and its folder. */
  let folder = "";
  /** The session resumed ("" for a new one), the part of its file loaded (byte offset; 0: all of it). */
  let resumed = "";
  let historyStart = 0;
  /** The loaded windows' lines and the CLI's lines since, kept as text and parsed while applied. */
  let history: string[] = [];
  let live: string[] = [];
  let requestSeq = 0;
  /** The control requests waiting for their answer, by request id: the answer's body, or why it failed. */
  const answers = new Map<string, (response: Rec | null, error: string) => void>();
  /** The messages written that the CLI has not taken up yet (it replays one as it does), and a take-back under way. */
  let queued: { uuid: string; text: string }[] = [];
  let withdrawing = false;
  /** The side questions asked this session and their answers (Claude Code takes them as a side question's history). */
  let sides: { question: string; response: string }[] = [];
  let sideSeq = 0;
  /** The process's cost so far (`result.total_cost_usd` counts per process). */
  let processCost = 0;
  let out: Ev[] = [];
  const emit = (e: Ev): void => {
    out.push(e);
  };
  const flush = (): void => {
    if (out.length === 0) return;
    const batch = out;
    out = [];
    api.conversation.apply(batch);
  };
  const readFile = (path: string): string | null => api.fs.text(path);
  /** Claude Code's config folder (the section's, else $CLAUDE_CONFIG_DIR, else ~/.claude): its skills folder is under it. */
  const configDir = (): string => {
    if (config.length > 0) return config;
    const env = api.fs.env("CLAUDE_CONFIG_DIR");
    return env.length > 0 ? env : api.fs.home() + "/.claude";
  };
  /** What a SKILL.md's frontmatter says the skill is for ("" when it says nothing): the `description:` line, or the indented lines after one that holds a `|` or `>`. */
  const descriptionOf = (path: string): string => {
    const head = api.fs.read(path, 0, FRONTMATTER_BYTES);
    if (!head.startsWith("---")) return "";
    const end = head.indexOf("\n---", 3);
    const lines = (end > 0 ? head.slice(3, end) : head.slice(3)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("description:")) continue;
      let value = lines[i].slice("description:".length).trim();
      if (value.length === 0 || value === "|" || value === ">") {
        const more: string[] = [];
        for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) more.push(lines[j].trim());
        value = more.join(" ");
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return value.replace(/\s+/g, " ").trim();
    }
    return "";
  };
  /** Skills read already, by name (a skill's file does not move while Claude runs here), and the folder they were read for. */
  const skillCache = new Map<string, widecode.AgentSkill>();
  let skillFolder = "";
  /** Where skill `name` lives and whose it is: a plugin's (`plugin:skill`, under the plugin's path the init record gives, else among the synced skills), else the project's (under `folder`), the user's, a synced one's; "" for a bundled skill. */
  const skillFile = (name: string, plugins: unknown[], folder: string): { path: string; source: string } => {
    const skillsDir = configDir() + "/skills";
    const synced = (short: string): string => {
      for (const e of api.fs.list(skillsDir + "/synced")) {
        if (e.file) continue;
        const path = skillsDir + "/synced/" + e.name + "/" + short + "/SKILL.md";
        if (api.fs.stat(path) !== null) return path;
      }
      return "";
    };
    const colon = name.indexOf(":");
    if (colon > 0) {
      const prefix = name.slice(0, colon);
      const short = name.slice(colon + 1);
      for (const v of plugins) {
        const p = rec(v);
        if (p === null || str(p.name) !== prefix || str(p.path).length === 0 || str(p.path) === "builtin") continue;
        const path = str(p.path) + "/skills/" + short + "/SKILL.md";
        if (api.fs.stat(path) !== null) return { path, source: prefix };
      }
      return { path: synced(short), source: prefix };
    }
    const project = folder + "/.claude/skills/" + name + "/SKILL.md";
    if (folder.length > 0 && api.fs.stat(project) !== null) return { path: project, source: "project" };
    const user = skillsDir + "/" + name + "/SKILL.md";
    if (api.fs.stat(user) !== null) return { path: user, source: "user" };
    const path = synced(name);
    return { path, source: path.length > 0 ? "user" : "built-in" };
  };
  const skillsOf = (names: string[], plugins: unknown[], folder: string): widecode.AgentSkill[] => {
    if (folder !== skillFolder) skillCache.clear();
    skillFolder = folder;
    const out: widecode.AgentSkill[] = [];
    for (const name of names) {
      let s = skillCache.get(name);
      if (s === undefined) {
        const file = skillFile(name, plugins, folder);
        s = { name, description: file.path.length > 0 ? descriptionOf(file.path) : "", source: file.source, path: file.path, command: "/" + name };
        skillCache.set(name, s);
      }
      out.push(s);
    }
    return out;
  };
  /** The skills on disk, before Claude says: the trusted project's, the user's and the synced ones (named as Claude names them), each with its description; Claude's bundled skills and a plugin's come with its init record. */
  const scanSkills = (): widecode.AgentSkill[] => {
    const at = api.state.active().folder;
    const names: string[] = [];
    const withSkill = (dir: string): string[] => api.fs.list(dir).filter((e) => !e.file && api.fs.stat(dir + "/" + e.name + "/SKILL.md") !== null).map((e) => e.name);
    if (at.length > 0 && api.harness.info().trusted) for (const n of withSkill(at + "/.claude/skills")) names.push(n);
    const skillsDir = configDir() + "/skills";
    for (const n of withSkill(skillsDir)) if (!names.includes(n)) names.push(n);
    for (const e of api.fs.list(skillsDir + "/synced")) if (!e.file) for (const n of withSkill(skillsDir + "/synced/" + e.name)) if (!names.includes(SYNCED_PREFIX + n)) names.push(SYNCED_PREFIX + n);
    return skillsOf(names, [], at);
  };
  /** The skills found on disk go to the conversation as a partial list, while this agent is the one it talks to, until Claude's own. */
  const announceScanned = (): void => {
    if (api.agent.info().id !== id) return;
    emit({ type: "skills", skills: scanSkills(), partial: true });
    flush();
  };
  let reader = new Reader(emit, readFile, skillsOf);
  let status = new Status();
  /** The listing's cache (by file name: its size and time, and what it read). */
  const listed = new Map<string, { size: number; mtimeMs: number; s: Listed }>();

  const projectsRoot = (): string => {
    if (projects.length > 0) return projects;
    const config = api.fs.env("CLAUDE_CONFIG_DIR");
    return config.length > 0 ? config + "/projects" : api.fs.home() + "/.claude/projects";
  };
  const projectDir = (f: string): string => projectsRoot() + "/" + f.replace(/[^A-Za-z0-9]/g, "-");
  const fileOf = (sid: string): string => (safeId(sid) ? projectDir(folder || api.state.active().folder) + "/" + sid + ".jsonl" : "");
  /** The pid of a live Claude running `sid` that widecode did not start, from the records Claude Code keeps beside its projects folder (sessions/<pid>.json); 0 when none. */
  const runningElsewhere = (sid: string): number => {
    const dir = projectsRoot().replace(/\/[^/]*$/, "") + "/sessions";
    const self = api.fs.read("/proc/self/stat", 0, 1024);
    const me = self.slice(0, self.indexOf(" "));
    for (const e of api.fs.list(dir)) {
      if (!e.file || !e.name.endsWith(".json")) continue;
      const text = api.fs.text(dir + "/" + e.name);
      const r = text !== null && text.includes(sid) ? rec(parse(text)) : null;
      if (r === null || r.sessionId !== sid || typeof r.pid !== "number") continue;
      const stat = statFields(api.fs.read("/proc/" + String(r.pid) + "/stat", 0, 1024));
      const started = str(r.procStart);
      if (stat.length < 20 || stat[1] === me || (started.length > 0 && stat[19] !== started)) continue;
      return r.pid;
    }
    return 0;
  };

  /** The status sent last, as text: a line that changes nothing in it sends nothing. */
  let sentStatus = "";
  /** The status as it stands, to the conversation when it changed (limits only once seen: the ones kept stand). */
  const sendStatus = (): void => {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(status.f)) {
      if (!status.limits && (k === "fiveHourPct" || k === "fiveHourResets" || k === "weekPct" || k === "weekResets")) continue;
      if (typeof v === "string" ? v.length > 0 : typeof v === "number") f[k] = v;
    }
    const text = JSON.stringify(f);
    if (text === sentStatus) return;
    sentStatus = text;
    emit({ type: "info", fields: f as Partial<widecode.StatusFields> });
  };

  /** One record into the reader and the status; `when` the time it was written (0: now). */
  const applyRecord = (value: unknown, stamped: boolean): void => {
    const r = rec(value);
    if (r === null) return;
    reader.stamped = stamped;
    reader.apply(value);
    status.apply(r, stamped ? (typeof r.timestamp === "string" ? Date.parse(r.timestamp) || 0 : 0) : Date.now());
  };

  /** The model again (a new one, from the conversation): the loaded history's active branch, then the CLI's lines since. */
  const rebuild = (): void => {
    sentStatus = "";
    reader = new Reader(emit, readFile, skillsOf);
    reader.folder = folder;
    status = new Status();
    for (const r of activeChain(history)) applyRecord(r, true);
    // The CLI's cost per print-mode process, kept in the transcript off the message chain.
    for (const line of history) if (line.startsWith('{"type":"cost-state"')) status.apply(rec(parse(line)) ?? {}, 0);
    emit({ type: "close" });
    // The transcript holds no init record: the skills on disk stand until the CLI's lines (an init among them) say.
    emit({ type: "skills", skills: scanSkills(), partial: true });
    for (const line of live) applyRecord(parse(line), false);
    status.f.sessionId = resumed;
    status.f.transcriptPath = fileOf(resumed);
    const meta = api.store.session(resumed);
    if (meta !== null && meta.costUsd > 0) status.f.costUsd = meta.costUsd;
    if (meta !== null && meta.contextWindow > 0) status.f.knownWindow = meta.contextWindow;
    emit({ type: "session", earlier: historyStart > 0 });
    sendStatus();
  };

  /** A turn ended: its cost and thinking added to the session's record, a title asked for when it has none. */
  const finishedTurn = (r: Rec): void => {
    flush();
    turnOpen = false;
    if (restartWanted && sentDuringTurn === 0) restart();
    sentDuringTurn = 0;
    const sid = api.agent.sessionId();
    if (sid.length === 0) return;
    const meta = api.store.session(sid);
    const total = num(r.total_cost_usd);
    const cost = (meta?.costUsd ?? 0) + (total >= processCost ? total - processCost : total);
    processCost = total;
    const thinking = (meta?.thinkingTokens ?? 0) + num(rec(rec(r.usage)?.output_tokens_details)?.thinking_tokens);
    const model = api.agent.modelName() || api.agent.reportedModel();
    const head = api.agent.headAtStart();
    const kept = api.store.updateSession(sid, {
      costUsd: cost,
      thinkingTokens: thinking,
      ...(model.length > 0 ? { model } : {}),
      ...((status.f.contextSize ?? 0) > 0 ? { contextWindow: status.f.contextSize } : {}),
      ...((meta?.baseCommit ?? "").length === 0 && head.length > 0 ? { baseCommit: head } : {}),
      effort: api.agent.effort(),
    });
    if (!kept) return;
    status.f.costUsd = cost;
    sendStatus();
    flush();
    if ((meta?.title ?? "").length === 0 && api.agent.title().length === 0) {
      const first = api.agent.firstExchange();
      api.titles.request(sid, first.prompt, first.reply, false);
    }
  };

  /** A line the CLI wrote: a permission prompt the user need not see allowed at once, then read. */
  const line = (l: string, fromProcess: boolean): void => {
    const value = parse(l);
    const r = rec(value);
    if (r === null) {
      api.note("claude: not JSON: " + l.slice(0, 120));
      return;
    }
    live.push(l);
    if (live.length > LIVE_MAX) live = live.slice(live.length - LIVE_MAX);
    if (r.type === "control_response") {
      const res = rec(r.response);
      const then = answers.get(str(res?.request_id));
      if (then === undefined) return;
      answers.delete(str(res?.request_id));
      then(res?.subtype === "success" ? rec(res.response) : null, str(res?.error));
      return;
    }
    // A message the CLI took up is off its queue.
    if (r.type === "user" && r.isReplay === true) {
      const content = rec(r.message)?.content;
      const said = typeof content === "string" ? content : list(content).map((b) => str(rec(b)?.text)).join("");
      const at = queued.findIndex((q) => q.uuid === str(r.uuid));
      const same = at >= 0 ? at : queued.findIndex((q) => q.text === said);
      if (same >= 0) queued.splice(same, 1);
    }
    if (fromProcess && r.type === "control_request") {
      const q = rec(r.request);
      const tool = str(q?.tool_name);
      if (q !== null && q.subtype === "can_use_tool" && !INTERACTIVE.includes(tool)) {
        // Under bypass the CLI asks only what no mode auto-approves (an ask rule, a critical removal); in a mode that asks, every prompt comes here.
        const id = str(r.request_id);
        const argument = argumentOf(tool, q.input);
        const key = tool + "\n" + argument;
        if (allowAll) {
          write(allowResponse(id, q.input));
          api.note("claude: allowed " + tool + " (all allowed for this session)");
        } else if (allowedThisSession.has(key)) {
          write(allowResponse(id, q.input));
          api.note("claude: allowed " + tool + " again (allowed for this session)");
        } else {
          const outside = folderOf(outsidePath(q));
          const folder = allowedFolders.includes(outside) ? "" : outside;
          const shown = shownPath(folder);
          const options = folder.length === 0 ? PERMISSION_OPTIONS : [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[1], { label: folderSessionLabel(shown), description: "the folder joins this session's: reading there stops asking" }, { label: folderKeptLabel(shown), description: "the same, kept in this folder's .claude/settings.local.json for later sessions" }, PERMISSION_OPTIONS[2], PERMISSION_OPTIONS[3]];
          permissions.set(id, { tool, input: q.input, key, folder, shown });
          emit({ type: "request", id, name: tool, callId: str(q.tool_use_id), input: q.input, category: "permission", permission: true, questions: [{ question: tool + " " + argument + ": allow it?", header: "Permission", options }] });
        }
      }
    }
    applyRecord(value, false);
    if (r.type === "result") {
      sendStatus();
      finishedTurn(r);
      const limit = limitMessage(r);
      // After the batch is applied: the turn's end closes its requests, and this one belongs after it.
      if (limit.length > 0) api.after(0, () => offerLimit(limit));
    } else if (r.type === "rate_limit_event") {
      const f = status.f;
      api.store.saveLimits({ fiveHourPct: f.fiveHourPct ?? -1, fiveHourResets: f.fiveHourResets ?? 0, weekPct: f.weekPct ?? -1, weekResets: f.weekResets ?? 0 });
    }
  };

  const write = (l: string): void => {
    if (proc !== null) proc.write(l);
  };
  const control = (body: string): void => {
    if (proc === null) return;
    write('{"type":"control_request","request_id":"code-' + String(++requestSeq) + '","request":' + body + "}");
  };
  /** A control request whose answer `then` gets: its body, or null and why it failed. */
  const ask = (body: string, then: (response: Rec | null, error: string) => void): void => {
    if (proc === null) return then(null, "Claude does not run");
    const rid = "code-" + String(++requestSeq);
    answers.set(rid, then);
    write('{"type":"control_request","request_id":' + JSON.stringify(rid) + ',"request":' + body + "}");
  };
  /** The answers no process will give now. */
  const unanswered = (): void => {
    const waiting = [...answers.values()];
    answers.clear();
    for (const then of waiting) then(null, "Claude exited");
    queued = [];
  };

  const exited = (): void => {
    processes++;
    proc = null;
    turnOpen = false;
    sentDuringTurn = 0;
    permissions.clear();
    unanswered();
    emit({ type: "notice", text: "Claude exited during the turn", tone: "error", ifOpen: true });
    emit({ type: "close" });
    emit({ type: "dropQueued" });
    emit({ type: "process", state: "ended" });
    flush();
  };

  /** Ask the core where its tools are served for this agent, and keep the answer for the next start. */
  const refreshServer = (): void => {
    api.tools.server().then(
      (s) => {
        server = s;
      },
      () => {
        server = null;
      },
    );
  };

  /** Stop the CLI between turns so the next message starts it again with what changed (its tools, the harness), on the same session. */
  const restart = (): void => {
    restartWanted = false;
    const p = proc;
    if (p === null) return;
    const sid = api.agent.sessionId();
    processes++;
    proc = null;
    p.stop(3000);
    permissions.clear();
    unanswered();
    if (sid.length > 0) resumed = sid;
    emit({ type: "process", state: "ended" });
    flush();
    api.note("claude stopped to pick up the harness" + (sid.length > 0 ? "; resumes " + sid + " on the next message" : ""));
  };

  /** The CLI to start: `--claude`'s path, one on PATH, the installer's default, else the bare name. */
  const executableOf = (given: string): string => {
    if (given.length > 0) return given;
    for (const dir of api.fs.env("PATH").split(":")) {
      if (dir.length > 0 && api.fs.stat(dir + "/claude") !== null) return dir + "/claude";
    }
    const local = api.fs.home() + "/.local/bin/claude";
    return api.fs.stat(local) !== null ? local : "claude";
  };

  /** The acp plugin's tasks from the effective config, and whether widecode's Task is offered to this plugin's agent. */
  const subagentTasks = (): SubagentTasks => {
    const plugins = rec(api.harness.info().config.effective.plugins);
    const acp = plugins !== null ? rec(plugins.acp) : null;
    const tasks = acp !== null ? rec(acp.tasks) : null;
    const replace = tasks !== null && tasks.replaceClaudeSubagents === true;
    const targets: SubagentTarget[] = [];
    const configured = tasks !== null ? rec(tasks.targets) : null;
    if (configured !== null)
      for (const name of Object.keys(configured)) {
        const t = rec(configured[name]);
        if (t !== null) targets.push({ name, agent: str(t.agent), model: str(t.model) });
      }
    const offered = targets.length > 0 && server !== null && server.tools.some((t) => t.name === "Task");
    return { offered, replace, targets };
  };

  /** The models plugin's list for Claude Code, from the effective config. */
  const subagentModels = (): string[] => {
    const plugins = rec(api.harness.info().config.effective.plugins);
    const models = plugins !== null ? rec(plugins.models) : null;
    const out: string[] = [];
    for (const m of list(models !== null ? models.list : null)) if (typeof m === "string" && m.trim().length > 0) out.push(m.trim());
    return out;
  };

  /** The subagents chosen (state.json), else the config's default, clamped to Claude Code's own when widecode's Task is not offered. */
  const chosenSubagents = (): SubagentChoice => {
    const t = subagentTasks();
    const kept = rec(api.settings.state());
    const saved = kept !== null ? rec(kept.subagents) : null;
    const mode = saved !== null ? str(saved.mode) : "";
    const model = saved !== null ? str(saved.model) : "";
    if (!t.offered) return { mode: "claude", model };
    if (mode === "claude" || mode === "widecode" || mode === "both") return { mode, model };
    return { mode: t.replace && !keepSubagents ? "widecode" : "both", model: "" };
  };

  /** Keep the choice in state.json beside what the plugin kept before. */
  const rememberSubagents = (choice: SubagentChoice): void => {
    const kept = rec(api.settings.state());
    const next: Rec = {};
    if (kept !== null) for (const key of Object.keys(kept)) next[key] = kept[key];
    next.subagents = { mode: choice.mode, model: choice.model };
    api.settings.setState(next);
  };

  /** The choice in one short phrase, for /subagents: the status line shows about forty characters. */
  const describeSubagents = (choice: SubagentChoice, t: SubagentTasks): string => {
    const names = t.targets.map((x) => x.name).join(", ");
    if (choice.mode === "claude") return "Claude's own" + (choice.model.length > 0 ? " on " + choice.model : "");
    if (choice.mode === "widecode") return names + " via Task";
    return "Claude's own and " + names;
  };

  /** Every choice /subagents takes, in the order it lists them. */
  const subagentChoices = (t: SubagentTasks): string[] => {
    const out = ["claude", "claude opus", "claude sonnet", "claude haiku"];
    for (const m of subagentModels()) {
      const value = "claude " + m;
      if (!out.includes(value)) out.push(value);
    }
    if (t.offered) {
      out.push("widecode");
      out.push("both");
    }
    return out;
  };

  /** The choice a value names, null for none. Claude Code takes any model alias or id, as /model does. */
  const subagentChoiceOf = (typed: string, t: SubagentTasks): SubagentChoice | null => {
    if (typed === "claude") return { mode: "claude", model: "" };
    if (typed === "widecode" || typed === "both") return t.offered ? { mode: typed, model: "" } : null;
    if (!typed.startsWith("claude ")) return null;
    const model = typed.slice("claude ".length).trim();
    return model.length > 0 && !/\s/.test(model) ? { mode: "claude", model } : null;
  };

  api.commands.add({
    name: "/subagents",
    usage: "[claude [model] | widecode | both]",
    help: "the session's subagents: Claude Code's own, widecode's Task, or both",
    complete: (typed) => {
      const t = subagentTasks();
      const now = chosenSubagents();
      const current = now.mode === "claude" ? (now.model.length > 0 ? "claude " + now.model : "claude") : now.mode;
      return subagentChoices(t)
        .filter((value) => value.startsWith(typed.trim()))
        .map((value) => ({ value, label: value, detail: value === current ? "now" : value === "claude" ? "Claude Code's own, inheriting its model" : value.startsWith("claude ") ? "Claude Code's own, on " + value.slice("claude ".length) : value === "widecode" ? "widecode's Task on the targets" : "Claude Code's own and widecode's Task" }));
    },
    run: (arg) => {
      const t = subagentTasks();
      const main = api.agent.info();
      if (main.id !== id) {
        const names = t.targets.map((x) => x.name).join(", ");
        api.tell("subagents: " + (names.length > 0 ? names + " via Task" : "none") + " (main: " + main.name + ")");
        return;
      }
      const typed = arg.trim();
      const now = chosenSubagents();
      if (typed.length === 0) {
        api.tell("subagents: " + describeSubagents(now, t));
        return;
      }
      const choice = subagentChoiceOf(typed, t);
      if (choice === null) {
        api.tell("subagents: choose " + subagentChoices(t).join(", "));
        return;
      }
      rememberSubagents(choice);
      // Between turns the CLI stops now and the next message has the choice; a turn's end is worth saying.
      const when = turnOpen ? ", after this turn" : "";
      if (proc !== null) {
        if (turnOpen) restartWanted = true;
        else restart();
      }
      api.tell("subagents: " + describeSubagents(choice, t) + when);
    },
  });

  const start = (o: widecode.AgentStart): string => {
    if (proc !== null) return "";
    folder = o.cwd;
    reader.folder = folder;
    const command = [executableOf(o.executable), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (o.model.length > 0) command.push("--model", o.model);
    const resume = o.resume.length > 0 ? o.resume : resumed.length > 0 ? resumed : o.args.includes("--no-session-persistence") ? "" : api.agent.sessionId();
    if (resume.length > 0) command.push("--resume", resume);
    for (const f of allowedFolders) command.push("--add-dir", f);
    command.push("--permission-mode", "bypassPermissions");
    if (o.effort.length > 0) command.push("--effort", o.effort);
    const s = server;
    if (s !== null) command.push("--mcp-config", s.file.length > 0 ? s.file : JSON.stringify({ mcpServers: { widecode: { type: "http", url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) } } }));
    // The acp plugin offers widecode's Task: /subagents says which subagents run, Claude Code's own,
    // widecode's Task, or both, and the other's tools step aside.
    const subagents = chosenSubagents();
    const offered = subagentTasks().offered;
    if (offered && subagents.mode === "widecode") command.push("--disallowedTools", "Task,Agent,TaskStop,SendMessage");
    else if (offered && subagents.mode === "claude") command.push("--disallowedTools", "mcp__widecode__Task,mcp__widecode__TaskStop,mcp__widecode__SendMessage");
    // Recorded once per session by default, the prompt would stay as the first launch had it: off, a changed prompt.md reaches a resumed session.
    if (o.systemPrompt.length > 0) command.push("--append-system-prompt", o.systemPrompt, "--system-prompt-snapshot", "off");
    // Claude Code enforces them: a deny rule blocks in every mode, an ask rule prompts (here, over stdio) in every mode.
    // Its own subagents run on the model chosen with `env`, the rest of the settings carrying the permissions.
    // Claude Code takes an agent's own model (its definition, a model the Agent call names) over
    // CLAUDE_CODE_SUBAGENT_MODEL, and an agent defined as "inherit" never reads it; _FORCE puts the
    // chosen model over both, so every subagent runs on it.
    const settings: Rec = {};
    if (o.permissions.allow.length + o.permissions.ask.length + o.permissions.deny.length > 0) settings.permissions = o.permissions;
    if (subagents.mode === "claude" && subagents.model.length > 0) settings.env = { CLAUDE_CODE_SUBAGENT_MODEL: subagents.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" };
    if (Object.keys(settings).length > 0) command.push("--settings", JSON.stringify(settings));
    command.push("--permission-prompt-tool", "stdio", "--forward-subagent-text", "--replay-user-messages", ...o.args);
    const mine = ++processes;
    const p = api.process.spawn(command, { cwd: folder }, {
      lines: (ls) => {
        if (mine !== processes) return;
        for (const l of ls) line(l, true);
        sendStatus();
        flush();
      },
      exit: (code) => {
        api.note("claude exited with code " + String(code));
        if (mine === processes) exited();
      },
      error: (text) => api.note("claude: " + text.trimEnd()),
    });
    if (!p.started) return "cannot start " + command[0];
    proc = p;
    processCost = 0;
    emit({ type: "process", state: "running" });
    flush();
    api.note("claude started in " + folder + (resume.length > 0 ? " resuming " + resume : ""));
    return "";
  };

  /** Read a window of session `sid`'s file ending at byte `before` (-1: its end). */
  const windowOf = (sid: string, before: number): { lines: string[]; start: number; end: number } => {
    const path = fileOf(sid);
    return path.length > 0 ? api.fs.window(path, before, HISTORY_BYTES, SKIP_RECORDS) : { lines: [], start: 0, end: 0 };
  };

  refreshServer();
  api.on("toolsChanged", () => {
    refreshServer();
    if (proc !== null) restartWanted = true;
  });
  api.on("harnessChanged", () => {
    if (proc !== null) restartWanted = true;
    // The folder trusted: its skills join the list.
    if (!api.agent.started()) announceScanned();
  });
  // The skills on disk, once the agent is registered, and after /new.
  api.after(0, announceScanned);

  /** When the limit's window resets (epoch ms; 0 when unknown): the agent's reported one, else what the message says. */
  const resetOf = (text: string): number => {
    const now = Date.now();
    const f = status.f;
    const week = /week|seven[- ]day|7[- ]day/i.test(text);
    const fiveAt = (f.fiveHourResets ?? 0) * 1000;
    const weekAt = (f.weekResets ?? 0) * 1000;
    const live = (at: number): boolean => at > now + 1000;
    if (week) return live(weekAt) ? weekAt : resetFrom(text, now);
    if (live(fiveAt) && (f.fiveHourPct ?? -1) >= 99) return fiveAt;
    if (live(weekAt) && (f.weekPct ?? -1) >= 99) return weekAt;
    if (live(fiveAt)) return fiveAt;
    return resetFrom(text, now);
  };

  const cancelRetry = (): void => {
    retryGen++;
    retryAt = 0;
  };

  const sendMessage = (text: string, images: { mediaType: string; data: string; path?: string }[], from: string = ""): string => {
    if (from.length === 0) {
      if (!retrying) cancelRetry();
      lastPrompt = { text, images };
    }
    const content: unknown[] = images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }));
    content.push({ type: "text", text });
    // Its uuid lets it be taken back while it waits in the CLI's queue (cancel_async_message).
    const uuid = uuidV4();
    queued.push({ uuid, text });
    if (turnOpen) sentDuringTurn++;
    turnOpen = true;
    write(JSON.stringify({ type: "user", session_id: "", uuid, message: { role: "user", content }, parent_tool_use_id: null }));
    return "";
  };

  const retryLast = (): void => {
    retryAt = 0;
    const last = lastPrompt;
    if (last === null || api.agent.info().id !== id) return;
    emit({ type: "notice", text: "Retrying after the limit reset", tone: "info" });
    flush();
    retrying = true;
    try {
      if (proc === null) {
        const r = api.agent.send(last.text);
        if (r.error.length > 0) api.tell(r.error);
      } else {
        emit({ type: "turn", text: last.text, images: last.images.length });
        sendMessage(last.text, last.images);
        flush();
      }
    } finally {
      retrying = false;
    }
  };

  const scheduleRetry = (at: number, known: boolean): void => {
    const now = Date.now();
    const when = known ? (at > now ? at : now + 3000) : now + 5 * 60000;
    const gen = ++retryGen;
    retryAt = when;
    api.after(when - now + 5000, () => {
      if (gen !== retryGen) return;
      retryLast();
    });
    const left = widecode.util.elapsed(Math.max(0, when - now));
    api.tell("retrying in " + left);
    emit({ type: "notice", text: (known ? "Retry scheduled when the limit resets · in " : "Retry scheduled in five minutes · in ") + left, tone: "info" });
    flush();
  };

  /** The turn stopped by a limit: say what it was, and let the user wait, switch model, or send the message again when it resets. */
  const offerLimit = (text: string): void => {
    if (retryAt > 0) return;
    const now = Date.now();
    const reset = resetOf(text);
    const known = reset > 0;
    const when = known ? (reset > now ? reset : now + 3000) : now + 5 * 60000;
    const left = widecode.util.elapsed(Math.max(0, when - now));
    const retryLabel = known ? "Retry in " + left : "Retry in 5 min";
    api.conversation
      .ask({
        category: "question",
        name: "Claude limit",
        questions: [
          {
            question: "Claude hit its limit. How should widecode go on?",
            header: "Limit",
            options: [
              { label: "Wait", description: "do nothing; send a message yourself when you are ready" },
              { label: "Change model", description: "put /model in the composer to pick another model" },
              { label: retryLabel, description: known ? "send the same message again when the limit resets" : "the reset time is unknown; try again in five minutes" },
            ],
          },
        ],
      })
      .then((reply) => {
        if (reply.state !== "answered" || reply.answers.length === 0) return;
        const label = reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
        if (label === "Change model") {
          api.composer.set(["/model "], 0, 7);
          api.actions.focus("chat");
          api.tell("pick the model to switch to");
        } else if (label === retryLabel) scheduleRetry(when, known);
      });
  };

  return {
    id,
    name: "Claude",
    choices: { anyModel: true, efforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ value: e, name: e })), modes: ["default", "acceptEdits", "plan", "bypassPermissions"].map((m) => ({ value: m, name: m })), models: [] },
    start(o) {
      return start(o);
    },
    send(text, images, from) {
      return sendMessage(text, images, from);
    },
    withdraw() {
      if (withdrawing) return "";
      const asked = queued.slice();
      if (asked.length === 0) {
        emit({ type: "withdrawn", texts: [] });
        flush();
        return "";
      }
      // Each is dropped from the CLI's queue unless it was taken up meanwhile; those dropped come back.
      withdrawing = true;
      const back = asked.map(() => false);
      let left = asked.length;
      asked.forEach((m, i) =>
        ask('{"subtype":"cancel_async_message","message_uuid":' + JSON.stringify(m.uuid) + "}", (res) => {
          if (res !== null && res.cancelled === true) {
            back[i] = true;
            queued = queued.filter((q) => q !== m);
          }
          if (--left > 0) return;
          withdrawing = false;
          emit({ type: "withdrawn", texts: asked.filter((_, j) => back[j]).map((q) => q.text) });
          flush();
        }),
      );
      return "";
    },
    sideQuestion(question) {
      // Claude Code's own side question: answered from the session so far, no tools, nothing added to it.
      const sid = "btw" + String(++sideSeq);
      emit({ type: "aside", id: sid, question });
      flush();
      const history = sides.length > 0 ? ',"history":' + JSON.stringify(sides) : "";
      ask('{"subtype":"side_question","question":' + JSON.stringify(question) + history + "}", (res, error) => {
        const answer = res !== null ? res.response : null;
        if (typeof answer === "string") {
          sides.push({ question, response: answer });
          emit({ type: "aside", id: sid, text: answer, done: true });
        } else emit({ type: "aside", id: sid, error: error.length > 0 ? error : "Claude gave no answer" });
        flush();
      });
      return "";
    },
    interrupt() {
      if (proc !== null && api.agent.running()) {
        control('{"subtype":"interrupt"}');
        api.note("interrupt sent");
      }
    },
    setMode(mode) {
      control('{"subtype":"set_permission_mode","mode":' + JSON.stringify(mode) + "}");
      emit({ type: "mode", mode });
      flush();
      return "";
    },
    setModel(name) {
      control('{"subtype":"set_model","model":' + JSON.stringify(name) + "}");
    },
    setEffort(level) {
      control('{"subtype":"apply_flag_settings","settings":{"effortLevel":' + JSON.stringify(level) + "}}");
    },
    respond(request, reply) {
      const p = permissions.get(request.id);
      if (p !== undefined) {
        permissions.delete(request.id);
        const label = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
        if (label === "Allow once" || label === "Allow for this session") {
          if (label === "Allow for this session") allowedThisSession.add(p.key);
          write(allowResponse(request.id, p.input));
          api.note("claude: " + p.tool + " allowed by the user" + (label === "Allow for this session" ? " for this session" : ""));
        } else if (label === ALLOW_ALL) {
          allowAll = true;
          write(allowResponse(request.id, p.input));
          api.note("claude: " + p.tool + " allowed by the user, and every call after it for this session");
          // The prompts still open (calls asked about together) are allowed with it.
          for (const [id, other] of Array.from(permissions.entries())) {
            permissions.delete(id);
            write(allowResponse(id, other.input));
            emit({ type: "cancelRequest", id, state: "answered" });
            api.note("claude: allowed " + other.tool + " (all allowed for this session)");
          }
          flush();
        } else if (p.folder.length > 0 && (label === folderSessionLabel(p.shown) || label === folderKeptLabel(p.shown))) {
          const kept = label === folderKeptLabel(p.shown);
          if (!kept) allowedFolders.push(p.folder);
          write(allowResponse(request.id, p.input, p.folder, kept));
          api.note("claude: " + p.tool + " allowed by the user, and " + p.folder + (kept ? " from now on (.claude/settings.local.json)" : " for this session"));
        } else {
          write('{"type":"control_response","response":{"subtype":"success","request_id":' + JSON.stringify(request.id) + ',"response":{"behavior":"deny","message":' + JSON.stringify("The user denied " + p.tool) + "}}}");
          api.note("claude: " + p.tool + " denied by the user");
        }
        return;
      }
      const asked = reader.requests.get(request.id);
      reader.requests.delete(request.id);
      write('{"type":"control_response","response":{"subtype":"success","request_id":' + JSON.stringify(request.id) + ',"response":' + replyJson(asked?.input ?? null, reply) + "}}");
    },
    resume(sid) {
      cancelRetry();
      folder = api.state.active().folder;
      resumed = sid;
      sides = [];
      allowAll = false;
      const w = windowOf(sid, -1);
      history = w.lines.length > HISTORY_MAX ? w.lines.slice(w.lines.length - HISTORY_MAX) : w.lines;
      live = [];
      historyStart = w.start;
      rebuild();
      const other = runningElsewhere(sid);
      if (other > 0) emit({ type: "notice", text: "Another Claude (pid " + String(other) + ") is running this session.", tone: "error" });
      if (w.lines.length === 0) emit({ type: "notice", text: "No transcript for " + sid + " under " + projectDir(folder) + ": the session may belong to another agent (/agent lists them).", tone: "error" });
      flush();
      api.note("resumed " + sid + " (" + String(w.lines.length) + " records from byte " + String(w.start) + ")");
    },
    loadEarlier() {
      if (resumed.length === 0 || historyStart <= 0) return false;
      const w = windowOf(resumed, historyStart);
      if (w.end === w.start) return false;
      history = w.lines.concat(history);
      if (history.length > HISTORY_MAX) history = history.slice(history.length - HISTORY_MAX);
      historyStart = w.start;
      rebuild();
      flush();
      return true;
    },
    loadSubagent(callId) {
      const sid = resumed.length > 0 ? resumed : api.agent.sessionId();
      if (!safeId(sid)) return false;
      // A Task run keeps its own transcript under the project; read it back under its call.
      let taskRaw = "";
      try {
        taskRaw = api.store.taskTranscript(sid, callId);
      } catch {
        taskRaw = "";
      }
      if (taskRaw.length > 0) {
        const events: unknown[] = [];
        for (const line of taskRaw.split("\n")) if (line.length > 0) {
          const v = parse(line);
          if (v !== null) events.push(v);
        }
        if (events.length > 0) {
          api.conversation.subagent(callId, events as widecode.ConversationEvent[], true);
          return true;
        }
      }
      const dir = projectDir(folder || api.state.active().folder) + "/" + sid + "/subagents";
      for (const e of api.fs.list(dir)) {
        if (!e.name.endsWith(".meta.json")) continue;
        const meta = rec(parse(api.fs.text(dir + "/" + e.name) ?? ""));
        if (meta === null || meta.toolUseId !== callId) continue;
        const w = api.fs.window(dir + "/" + e.name.slice(0, e.name.length - 10) + ".jsonl", -1, HISTORY_BYTES, SKIP_RECORDS);
        reader.applyNested(callId, w.lines.map(parse));
        flush();
        return true;
      }
      return false;
    },
    reset() {
      cancelRetry();
      if (proc !== null) proc.stop(3000);
      processes++;
      proc = null;
      unanswered();
      sides = [];
      allowAll = false;
      resumed = "";
      historyStart = 0;
      history = [];
      live = [];
      reader = new Reader(emit, readFile, skillsOf);
      reader.folder = folder;
      status = new Status();
      sentStatus = "";
      api.after(0, announceScanned);
    },
    receive(text) {
      // A line, or a batch of them (JSON lines hold no raw newline).
      for (const l of text.split("\n")) if (l.length > 0) line(l, false);
      sendStatus();
      flush();
    },
    stop() {
      cancelRetry();
      if (proc !== null) proc.stop(3000);
      processes++;
      proc = null;
    },
    kill() {
      cancelRetry();
      if (proc !== null) proc.kill();
      processes++;
      proc = null;
    },
    sessions(f) {
      const out: widecode.AgentSession[] = [];
      const dir = projectDir(f);
      for (const e of api.fs.list(dir)) {
        if (!e.file || !e.name.endsWith(".jsonl") || e.name.startsWith("agent-") || e.size === 0) continue;
        const sid = e.name.slice(0, e.name.length - 6);
        if (!safeId(sid)) continue;
        let cached = listed.get(e.name);
        if (cached === undefined || cached.size !== e.size || cached.mtimeMs !== e.mtimeMs) {
          cached = { size: e.size, mtimeMs: e.mtimeMs, s: summarize(api, dir + "/" + e.name, sid, e.size, e.mtimeMs) };
          listed.set(e.name, cached);
        }
        const s = cached.s;
        if (s.cwd.length > 0 && s.cwd !== f) continue;
        out.push({ id: sid, title: s.title, firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt, cwd: s.cwd, model: s.model, mtimeMs: s.mtimeMs, size: s.size });
      }
      return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    },
  };
};

widecode.plugin({
  id: "claude",
  defaults: () => ({ id: "claude", projects: "", configDir: "" }),
  activate(api) {
    const section = rec(api.settings.section());
    const agentId = section !== null && str(section.id).length > 0 ? str(section.id) : "claude";
    api.agents.register(claudeAgent(api, agentId, str(section?.projects), str(section?.configDir), section?.keepSubagents === true));
  },
});

export {};
