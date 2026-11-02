// Agents over ACP, the Agent Client Protocol (agentclientprotocol.com: JSON-RPC 2.0 on the agent's
// stdin and stdout): each entry of this plugin's section of config.json is one the conversation can
// talk to, chosen with "agent" in config.json or --agent <id>. The agent's messages become the
// conversation's events: its text and thinking, its calls (their kind, title, files, diffs and
// output; a todo list or a subagent its input names), its plan as a todo list, its model, effort,
// mode and commands (config options, or the older modes and models), a session it loads replayed as
// turns, and the permissions it asks for, answered from the request panel. Its session starts with
// widecode (and after /new), so the models and efforts it offers are known before the first
// message; one made and never written to is deleted (the entry's "forget" command) when it is left,
// at once or by the next widecode when this one quit. An agent that takes MCP
// servers over HTTP gets widecode's (api.tools: AskUser, PresentPlan), whose calls show as their
// requests. Esc cancels its turn. The Sessions
// tab lists its sessions from session/list while it runs, when it offers that, else from the
// entry's "sessions" command (it prints them as JSON). ACP does not say which tools an agent has:
// the entry's "tools" command prints them for the mode ({mode} in it), as opencode's
// `debug agent <mode>` does, read once the session is made and again as its mode changes. Nor
// which skills: the entry's "skills" command prints them (opencode's `debug skill`: a list of name,
// description, location and content), read once the session is made; a call of the agent's `skill`
// tool, the skill's name in its input, is a skill call for the Skills tab. Its section:
// { "agents": { "opencode": { "name": "opencode", "command": ["opencode", "acp"],
//   "sessions": ["opencode", "session", "list", "--format", "json"],
//   "tools": ["opencode", "debug", "agent", "{mode}"], "skills": ["opencode", "debug", "skill"] } } };
// an entry with the id of a default replaces it.
// Three agents ship: opencode, the DeepSeek Harness (`dsh`, the `dsh --profile acp` command), and
// widecode's own, the harness (`{widecode} --harness`, the running binary, `own: true`: the
// project's prompt and trust go to it in `_meta.widecode` with each session and prompt). An
// agent that advertises session/load (opencode) replays a past session's turns; one that only
// advertises session/resume (the DeepSeek Harness) reopens it without them.

type Ev = widecode.ConversationEvent;

interface Entry {
  name: string;
  command: string[];
  /** A command that prints the agent's sessions as JSON ([] for none). */
  sessions: string[];
  /** A command that prints the tools of the mode named in it as {mode}, as JSON ([] for none). */
  tools: string[];
  /** A command that prints the agent's skills as JSON (a list of name, description and location; [] for none). */
  skills: string[];
  /** A command that deletes the session named in it as {session} (a side question's fork; [] for none). */
  forget: string[];
  /** Whether the agent takes a prompt into the turn that runs (opencode does): a message queued meanwhile goes after its next call. */
  midTurn: boolean;
  /** widecode's own agent, the harness: the project's prompt and trust go to it in `_meta.widecode`, and `{widecode}` in its commands is the running binary. */
  own: boolean;
}

const DEFAULT_AGENTS: Record<string, Entry> = {
  opencode: {
    name: "opencode",
    command: ["opencode", "acp"],
    sessions: ["opencode", "session", "list", "--format", "json"],
    tools: ["opencode", "debug", "agent", "{mode}"],
    skills: ["opencode", "debug", "skill"],
    forget: ["opencode", "session", "delete", "{session}"],
    midTurn: true,
    own: false,
  },
  dsh: {
    name: "DeepSeek Harness",
    command: ["dsh", "--profile", "acp"],
    sessions: [],
    tools: [],
    skills: [],
    forget: [],
    midTurn: false,
    own: false,
  },
  harness: {
    name: "harness",
    command: ["{widecode}", "--harness"],
    sessions: ["{widecode}", "--harness-sessions"],
    tools: ["{widecode}", "--harness-tools", "{mode}"],
    skills: ["{widecode}", "--harness-skills"],
    forget: ["{widecode}", "--harness-forget", "{session}"],
    midTurn: true,
    own: true,
  },
};

/** `words` with `{widecode}` made the running binary's path (the harness's commands). */
const resolved = (api: widecode.Api, words: string[]): string[] => words.map((w) => (w === "{widecode}" ? api.fs.executable() : w));

/** A permission rule of opencode's: what a call of `permission` (a tool's) on `pattern` gets. */
interface Rule {
  permission: string;
  pattern: string;
  action: string;
}

/** opencode's wildcards: * any run of characters, ? one. */
const wild = (pattern: string, text: string): boolean => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s").test(text);

/**
 * What the mode's rules let tool `tool` do, read as opencode reads them: the last rule matching
 * its permission (edit's for write and apply_patch) decides; one for any pattern that denies takes
 * the tool from the model ("denied"). Else a call meets the last rule for any pattern, and those
 * after it for some: denied but for some patterns is "limited" to those, asked is "asks".
 */
const accessOf = (tool: string, rules: Rule[]): { access: string; scope: string } => {
  const key = tool === "write" || tool === "apply_patch" ? "edit" : tool;
  const mine = rules.filter((r) => wild(r.permission, key));
  const last = mine.length > 0 ? mine[mine.length - 1] : null;
  if (last !== null && last.pattern === "*" && last.action === "deny") return { access: "denied", scope: "" };
  let any = -1;
  for (let i = 0; i < mine.length; i++) if (mine[i].pattern === "*") any = i;
  const action = any >= 0 ? mine[any].action : "ask";
  if (action === "ask") return { access: "asks", scope: "" };
  const some = mine.slice(any + 1).filter((r) => r.action === "allow").map((r) => r.pattern);
  return action === "deny" && some.length > 0 ? { access: "limited", scope: some.join(", ") } : { access: "", scope: "" };
};

/**
 * The tools a tools command printed, with what the mode lets each do: opencode's agent,
 * `{ tools: { <name>: true | false }, permission: [{ permission, pattern, action }] }`, the ones it
 * has. Left out: `invalid` (opencode's stand-in for a call it cannot read) and `question` (opencode
 * leaves it out for an ACP client). Null when it printed none.
 */
const listedOf = (v: unknown): { names: string[]; rules: Rule[] } | null => {
  const tools = obj(obj(v)?.tools);
  if (tools === null) return null;
  const rules = list(obj(v)?.permission)
    .map(obj)
    .filter((r): r is Msg => r !== null && typeof r.permission === "string")
    .map((r) => ({ permission: str(r.permission), pattern: str(r.pattern).length > 0 ? str(r.pattern) : "*", action: str(r.action) }));
  return { names: Object.keys(tools).filter((name) => tools[name] === true && name !== "invalid" && name !== "question"), rules };
};

/**
 * The skills a skills command printed, as opencode's `debug skill` does: a list of `{ name,
 * description, location, content }`, one built in located at `<built-in>`. Each with where it comes
 * from: the folder's are the project's, one under the home folder the user's, a built-in one the
 * agent's. None is called from the composer: the agent loads one when asked for it in words.
 */
const skillsOf = (v: unknown, cwd: string, home: string): widecode.AgentSkill[] => {
  const out: widecode.AgentSkill[] = [];
  for (const x of list(v)) {
    const s = obj(x);
    if (s === null || str(s.name).length === 0) continue;
    const location = str(s.location);
    const builtIn = location === "<built-in>" || location.length === 0;
    const source = builtIn ? "built-in" : cwd.length > 0 && location.startsWith(cwd + "/") ? "project" : home.length > 0 && location.startsWith(home + "/") ? "user" : "";
    out.push({ name: str(s.name), description: str(s.description), source, path: builtIn ? "" : location, command: "" });
  }
  return out;
};

/** What a side question's fork is told before the question. */
const SIDE_PROMPT = "Answer briefly, from what you know of this session so far and without tools:\n\n";

/** How long a listing of sessions is used before it is read again. */
const LISTING_MS = 3000;

/** Sizes a run logs while it keeps its events, to diagnose memory growth. */
const EVENT_LOG_CHARS = 1024 * 1024;
const HISTORY_LOG_CHARS = 8 * 1024 * 1024;

/** A test seam: an update handler failure injected to exercise the run's failure path. */
let crashOnUpdate = false;

/** Run one step of settling a call, going on when it throws: a host call failing must not stop the next step. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // The next step still runs.
  }
}

/** End a process, killing it when stopping it throws. */
function end(proc: widecode.ProcessHandle, ms: number): void {
  try {
    proc.stop(ms);
  } catch {
    attempt(() => proc.kill());
  }
}

/** A JSON-RPC message, or any object in one, every field unknown. */
interface Msg {
  [key: string]: unknown;
}

const { obj, str, list, parse } = widecode.util;

/** A tool result past this many characters is kept as its first CUT_HEAD, a line saying how many
 * characters were cut, and its last CUT_TAIL. */
const CUT_AT = 64000;
const CUT_HEAD = 48000;
const CUT_TAIL = 16000;

/** `text` bounded to a preview: its first CUT_HEAD characters, the number cut, its last CUT_TAIL. */
const cutText = (text: string): { text: string; size: number; truncated: boolean } => {
  if (text.length <= CUT_AT) return { text, size: text.length, truncated: false };
  const cut = text.length - CUT_HEAD - CUT_TAIL;
  return { text: text.slice(0, CUT_HEAD) + "\n[… " + String(cut) + " characters cut by widecode …]\n" + text.slice(text.length - CUT_TAIL), size: text.length, truncated: true };
};

/**
 * A tool result's fields from its text and raw output: bounded when long, with the full size and
 * who cut it (the agent, when its raw output's metadata says it truncated the output itself, else
 * widecode).
 */
const resultOf = (text: string, raw: unknown): { text: string; size?: number; truncated?: "agent" | "widecode" } => {
  const cut = cutText(text);
  const meta = obj(obj(raw)?.metadata);
  if (meta !== null && meta.truncated === true) return cut.truncated ? { text: cut.text, size: cut.size, truncated: "agent" } : { text: cut.text, truncated: "agent" };
  return cut.truncated ? { text: cut.text, size: cut.size, truncated: "widecode" } : { text: cut.text };
};

/** The section's agents over the defaults: an entry needs a command (a list of words). */
const agentsOf = (section: unknown): Record<string, Entry> => {
  const out: Record<string, Entry> = { ...DEFAULT_AGENTS };
  const agents = obj(obj(section)?.agents);
  if (agents === null) return out;
  for (const id of Object.keys(agents)) {
    const e = obj(agents[id]);
    const words = (v: unknown): string[] => list(v).filter((w): w is string => typeof w === "string" && w.length > 0);
    const command = words(e?.command);
    if (e === null || command.length === 0) continue;
    out[id] = { name: str(e.name).length > 0 ? str(e.name) : id, command, sessions: words(e.sessions), tools: words(e.tools), skills: words(e.skills), forget: words(e.forget), midTurn: e.midTurn === true, own: e.own === true };
  }
  return out;
};

/** A subagent target: the `subagent_type` Claude names, the agent entry it runs on, its model ("" for the entry's default), what it is for, and whether it runs in the box. */
interface TaskTarget {
  name: string;
  agent: string;
  model: string;
  description: string;
  box: boolean;
}

/** The box a boxed target runs in: the box script, the host proxy's port, the memory the box gets, and the folders it shares beside the session's. */
interface BoxConfig {
  script: string;
  proxyPort: number;
  memory: number;
  projects: string[];
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

const tasksOf = (section: unknown): TasksConfig => {
  const t = obj(obj(section)?.tasks);
  const out: TasksConfig = { replace: t?.replaceClaudeSubagents === true, targets: [], box: null, maxConcurrent: 4, timeoutMs: 1800000, worktreeSetup: [], worktreeSetupTimeoutMs: 300000 };
  const targets = obj(t?.targets);
  if (targets !== null)
    for (const name of Object.keys(targets)) {
      const e = obj(targets[name]);
      if (e === null) continue;
      const agent = str(e.agent).length > 0 ? str(e.agent) : name;
      const model = str(e.model);
      out.targets.push({ name, agent, model, description: str(e.description).length > 0 ? str(e.description) : "Runs on " + (model.length > 0 ? model : agent), box: e.box === true });
    }
  const b = obj(t?.box);
  if (b !== null && str(b.script).length > 0) {
    const proxyPort = typeof b.proxyPort === "number" && b.proxyPort >= 1 && b.proxyPort <= 65535 ? Math.floor(b.proxyPort) : 8888;
    const memory = typeof b.memory === "number" && b.memory >= 512 ? Math.floor(b.memory) : 4096;
    out.box = { script: str(b.script), proxyPort, memory, projects: list(b.projects).filter((w): w is string => typeof w === "string" && w.length > 0) };
  }
  if (typeof t?.maxConcurrent === "number" && t.maxConcurrent > 0) out.maxConcurrent = Math.floor(t.maxConcurrent);
  if (typeof t?.timeoutMs === "number" && t.timeoutMs >= 1000) out.timeoutMs = Math.floor(t.timeoutMs);
  out.worktreeSetup = list(t?.worktreeSetup).filter((w): w is string => typeof w === "string" && w.length > 0);
  if (typeof t?.worktreeSetupTimeoutMs === "number" && t.worktreeSetupTimeoutMs >= 1000) out.worktreeSetupTimeoutMs = Math.floor(t.worktreeSetupTimeoutMs);
  return out;
};

/**
 * The box a boxed run starts in: it reads the box's status, keeps its host proxy running and
 * starts the box with the session's folder and the configured projects. Calls are serialized, so
 * two runs at once never start a second box.
 */
class BoxRunner {
  private readonly api: widecode.Api;
  readonly config: BoxConfig;
  private proxy: widecode.ProcessHandle | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(api: widecode.Api, config: BoxConfig) {
    this.api = api;
    this.config = config;
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

  private startProxy(): Promise<void> {
    if (this.proxy !== null && this.proxy.started) return Promise.resolve();
    const command = ["node", this.config.script, "proxy", "--port", String(this.config.proxyPort)];
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

  private async ready(folder: string): Promise<string> {
    const desired = [folder, ...this.config.projects];
    const s = await this.status();
    const same = s.running && s.projects.length === desired.length && s.projects.every((p, i) => p === desired[i]);
    if (!s.proxy) await this.startProxy();
    if (same) return "";
    const up = await this.api.process.run(["node", this.config.script, "up", "--memory", String(this.config.memory), ...desired].map(quote).join(" "), "", 120000);
    if (up.code !== 0) return (up.err.trim().length > 0 ? up.err.trim() : up.out.trim()) || "the box did not start";
    return "";
  }

  /** "" when the box runs with `folder` and the configured projects, else why not. */
  ensure(folder: string): Promise<string> {
    const next = this.chain.then(() =>
      this.ready(folder).then(
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

/** A call's kind as ACP names it, as the views know it, and its name on the call's line. */
const CATEGORY: Record<string, string> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "fetch", switch_mode: "plan", think: "other", other: "other" };
const NAME: Record<string, string> = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Run", fetch: "Fetch", switch_mode: "Mode", think: "Think", other: "Tool" };
/** What a call of one of widecode's tools is named in the Tools tab, by its kind (another kind: the tool's name). */
const OWN_NAME: Record<string, string> = { question: "Ask", plan: "Plan" };

/** A call of widecode's tool `tool`: its first question, its plan's first line, else the tool's name. */
const ownSummary = (tool: { name: string; category: string }, input: Msg | null): string => {
  if (tool.category === "question") {
    const q = str(obj(list(input?.questions)[0])?.question);
    if (q.length > 0) return q;
  }
  if (tool.category === "plan") {
    const line = str(input?.plan).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    if (line.length > 0) return line;
  }
  return tool.name;
};

/** How many lines of context a hunk keeps around a change. */
const CONTEXT = 3;
/** Past this many differing lines a diff is one replacement. */
const MAX_EDITS = 500;
/** A whole file before and after is diffed up to this many characters (a call into a plugin has 250 ms). */
const MAX_WHOLE = 400000;

/** The edit script from `a` to `b` (Myers): " ", "-" and "+" lines; null past MAX_EDITS. */
const editScript = (a: string[], b: string[]): string[] | null => {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  /** The furthest x on each diagonal before step d, for the walk back. */
  const trace: number[][] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x < n || y < m) continue;
      const out: string[] = [];
      let cx = n;
      let cy = m;
      for (let e = d; e > 0; e--) {
        const pv = trace[e];
        const ck = cx - cy;
        const down = ck === -e || (ck !== e && pv[off + ck - 1] < pv[off + ck + 1]);
        const px = down ? pv[off + ck + 1] : pv[off + ck - 1];
        const py = px - (down ? ck + 1 : ck - 1);
        while (cx > px && cy > py) {
          cx--;
          cy--;
          out.push(" " + a[cx]);
        }
        if (down) out.push("+" + b[--cy]);
        else out.push("-" + a[--cx]);
      }
      while (cx > 0) {
        cx--;
        out.push(" " + a[cx]);
      }
      return out.reverse();
    }
  }
  return null;
};

const linesOf = (text: string): string[] => (text.length === 0 ? [] : text.replace(/\n$/, "").split("\n"));

/** A diff's hunks from the file's old text ("" for a new file) to its new text. */
const hunksOf = (oldText: string, newText: string): { oldStart: number; newStart: number; lines: string[] }[] => {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  // The lines both ends share are context; the script is of what lies between.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = editScript(midA, midB) ?? midA.map((l) => "-" + l).concat(midB.map((l) => "+" + l));
  const script = a
    .slice(0, head)
    .map((l) => " " + l)
    .concat(mid, a.slice(a.length - tail).map((l) => " " + l));
  // The old and new line numbers at each line of the script, and where it changes.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  const changes: number[] = [];
  let o = 1;
  let n = 1;
  for (let i = 0; i < script.length; i++) {
    oldNo.push(o);
    newNo.push(n);
    if (!script[i].startsWith("+")) o++;
    if (!script[i].startsWith("-")) n++;
    if (!script[i].startsWith(" ")) changes.push(i);
  }
  // Changes closer than twice the context share a hunk.
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  let first = 0;
  for (let c = 0; c < changes.length; c++) {
    if (c + 1 < changes.length && changes[c + 1] - changes[c] - 1 <= 2 * CONTEXT) continue;
    const from = Math.max(0, changes[first] - CONTEXT);
    const to = Math.min(script.length, changes[c] + CONTEXT + 1);
    hunks.push({ oldStart: oldNo[from], newStart: newNo[from], lines: script.slice(from, to) });
    first = c + 1;
  }
  return hunks;
};

/** A unified diff's hunks (`@@ -a,b +c,d @@` and the lines under each). */
const unifiedHunks = (diff: string): { oldStart: number; newStart: number; lines: string[] }[] => {
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  for (const line of diff.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at !== null) hunks.push({ oldStart: Number(at[1]), newStart: Number(at[2]), lines: [] });
    else if (hunks.length > 0 && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) hunks[hunks.length - 1].lines.push(line);
  }
  return hunks;
};

/** A word for `sh`, quoted. */
const quote = (w: string): string => "'" + w.replace(/'/g, "'\\''") + "'";

/**
 * The shell line that runs `words` in `folder` for what they print: their output goes to a file,
 * then to the plugin. An agent's CLI that writes a large listing and exits without waiting for it
 * to drain (opencode's, under Bun) loses what a pipe could not hold, 64 KB natively, and its JSON
 * no longer parses; a file holds it all, and `cat` waits for the pipe.
 */
const throughFile = (folder: string, words: string[]): string =>
  "cd " + quote(folder) + ' && f=$(mktemp) && { ' + words.map(quote).join(" ") + ' > "$f"; c=$?; cat "$f"; rm -f "$f"; exit $c; }';

/** A time as epoch ms: a number (seconds when it is small) or a date's text. */
const msOf = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
};

/** Sessions as an agent lists them (session/list's, or its command's JSON), those of `folder`, newest first. */
const sessionsOf = (v: unknown, folder: string): widecode.AgentSession[] => {
  const out: widecode.AgentSession[] = [];
  for (const x of list(v)) {
    const s = obj(x);
    if (s === null) continue;
    const id = str(s.sessionId) || str(s.id);
    const dir = str(s.cwd) || str(s.directory);
    if (id.length === 0 || (dir.length > 0 && dir !== folder)) continue;
    const time = obj(s.time);
    out.push({ id, title: str(s.title) || str(s.name), mtimeMs: msOf(s.updatedAt ?? s.updated ?? time?.updated ?? s.mtime) });
  }
  return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
};

/** A setting the agent offers: its config option's id ("" for the older set_mode and set_model), its options and their values, the current one. */
interface Setting {
  id: string;
  options: widecode.AgentOption[];
  values: string[];
  current: string;
}

const setting = (id: string, options: widecode.AgentOption[], current: string): Setting => ({ id, options, values: options.map((o) => o.value), current });

/** A select's options, its groups' included. */
const optionsOf = (options: unknown): widecode.AgentOption[] => {
  const out: widecode.AgentOption[] = [];
  for (const x of list(options)) {
    const o = obj(x);
    if (o === null) continue;
    if (typeof o.value === "string") out.push({ value: o.value, name: str(o.name).length > 0 ? str(o.name) : o.value });
    else out.push(...optionsOf(o.options));
  }
  return out;
};

/** An option the agent offers for a permission, as ACP names its kind. */
interface Option {
  optionId: string;
  name: string;
  kind: string;
}

/** A session made and not written to yet (the agent keeps it as any other): whose agent, its id, the widecode process that made it, its folder; kept in the plugin's state until it is deleted. */
interface Fresh {
  agent: string;
  id: string;
  pid: number;
  folder: string;
}

const freshOf = (api: widecode.Api): Fresh[] => {
  const out: Fresh[] = [];
  const kept = obj(api.settings.state());
  for (const x of list(kept?.fresh)) {
    const f = obj(x);
    if (f !== null && str(f.agent).length > 0 && str(f.id).length > 0) out.push({ agent: str(f.agent), id: str(f.id), pid: typeof f.pid === "number" ? f.pid : 0, folder: str(f.folder) });
  }
  return out;
};

const rememberFresh = (api: widecode.Api, f: Fresh): void => api.settings.setState({ fresh: [...freshOf(api).filter((k) => k.id !== f.id), f] });

const dropFresh = (api: widecode.Api, sid: string): void => api.settings.setState({ fresh: freshOf(api).filter((k) => k.id !== sid) });

/** This process's id (Linux), 0 when unknown; whether process `pid` runs. */
const ownPid = (api: widecode.Api): number => parseInt((api.fs.text("/proc/self/stat") ?? "").split(" ")[0], 10) || 0;
const alive = (api: widecode.Api, pid: number): boolean => pid > 0 && api.fs.stat("/proc/" + String(pid)) !== null;

/** Delete session `sid` of `entry` with its forget command, run in `folder`, the outcome noted as `what`. */
const deleteSession = (api: widecode.Api, entry: Entry, folder: string, sid: string, what: string): void => {
  if (entry.forget.length === 0) return;
  const words = resolved(api, entry.forget).map((w) => w.split("{session}").join(sid));
  api.process.run("cd " + quote(folder) + " && " + words.map(quote).join(" "), "", 15000).then(
    (r) => api.note(entry.name + ": " + (r.code === 0 ? "deleted " + what + " " + sid : "could not delete " + what + " " + sid + ": " + (r.timedOut ? "timed out" : r.err.trim()))),
    (e) => api.note(entry.name + ": could not delete " + what + " " + sid + ": " + String(e)),
  );
};

/** The sessions made and left (their widecode process gone, or this one, which made them before it started over), but `except`, forgotten and deleted; one of an agent no longer in the section is forgotten. */
const sweep = (api: widecode.Api, agents: Record<string, Entry>, except: string): void => {
  const own = ownPid(api);
  for (const f of freshOf(api)) {
    const entry = agents[f.agent];
    if (f.id === except) continue;
    if (entry === undefined || entry.forget.length === 0 || f.pid === own || !alive(api, f.pid)) dropFresh(api, f.id);
    if (entry !== undefined && entry.forget.length > 0 && (f.pid === own || !alive(api, f.pid))) deleteSession(api, entry, f.folder, f.id, "unused session");
  }
};

/** A call of widecode's Task tool that the ACP main announced and has not completed: which call, and what it asked. */
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
 * The ACP main's calls of widecode's Task tool that are in flight: it announces each with a
 * toolCallId of its own and the call's input, so the Task tool runs under that card instead of
 * making one. A call is dropped once it completes or fails.
 */
class TaskCalls {
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

const acpAgent = (api: widecode.Api, id: string, entry: Entry, taskCalls: TaskCalls): widecode.AgentAdapter => {
  const entries: Record<string, Entry> = {};
  entries[id] = entry;
  let proc: widecode.ProcessHandle | null = null;
  /** The process answered initialize, and what it can do. */
  let initialized = false;
  let canLoad = false;
  let canResume = false;
  let canImages = false;
  let canList = false;
  let canMcp = false;
  /** widecode's tools the agent was given, and the kind of call each is. */
  let own: { name: string; category: string }[] = [];
  /** Counts the readings of the agent's tools: a reading answers only while it is the last. */
  let toolReads = 0;
  let skillReads = 0;
  /** What the harness is told in `_meta.widecode` with each session and prompt: the project's prompt text and whether the folder is trusted (an entry with `own`). */
  let harnessPrompt = "";
  const metaOf = (): Record<string, unknown> => (entry.own ? { _meta: { widecode: { systemPrompt: harnessPrompt, trusted: api.harness.info().trusted } } } : {});
  /** The sessions listed last, the folder and when, and whether a listing is under way. */
  let listed: widecode.AgentSession[] = [];
  let listedFolder = "";
  let listedAt = 0;
  let listing = false;
  /** The session messages go to ("" before one is made or loaded), the one whose turns the model shows, the folder. */
  let session = "";
  let shown = "";
  let cwd = "";
  /** The session is made or loaded: prompts can go. */
  let ready = false;
  /** A session being loaded replays its turns; one already shown is loaded without them. */
  let replaying = false;
  let quiet = false;
  /** What the agent lets the user choose, by category ("model", "mode", "thought_level" for the effort). */
  let settings = new Map<string, Setting>();
  /** A mode, model and effort asked for before the session was ready. */
  let wantMode = "";
  let wantModel = "";
  let wantEffort = "";
  /** A model switch is out: an effort asked for meanwhile goes once it is answered, with the model's efforts known. */
  let switching = false;
  /** The session this process made and has not written to yet ("" else): deleted when it is left for another. */
  let fresh = "";
  /** Messages waiting for the session or the turn before them. */
  const queue: { text: string; images: { mediaType: string; data: string; path?: string }[] }[] = [];
  /** A prompt is out, since when, and whether the user cancelled it (an agent may answer end_turn then). */
  let inTurn = false;
  let turnAt = 0;
  let cancelled = false;
  /** The prompts out for the turn that runs (one, and those sent into it), and the first error one answered. */
  let prompts = 0;
  let promptError = "";
  /** Side questions out, by the session forked for each: the question's id and its answer so far. */
  const sides = new Map<string, { id: string; text: string }>();
  let sideSeq = 0;
  let canFork = false;
  /** The session's tokens in and out, from the turns' usage. */
  let tokensIn = 0;
  let tokensOut = 0;
  /** The text or thinking block being streamed ("" for none), its kind, and a counter for keys. */
  let open = "";
  let openKind = "";
  /** The message the block being streamed is of, when the agent names messages. */
  let openMessage = "";
  let blocks = 0;
  /** A user message being replayed, gathered from its chunks, and its id when the agent names messages. */
  let userText: string | null = null;
  let userMessage = "";
  let plans = 0;
  /** The calls the agent announced: their kind (a later update may leave it out) and whether their input made them a todo list or a subagent (an update of one it did not announce makes it). */
  /** The calls seen: each one's kind, whether its facts are its input's (a todo list, a subagent, a skill, one of widecode's tools), and the tool it was announced as. */
  const calls = new Map<string, { kind: string; named: boolean; tool: string }>();
  /** The last input JSON emitted for each open call, so a repeated raw input sends no event again. */
  const inputs = new Map<string, string>();
  /** Requests out (id: what answers them) and the permissions asked (request id: its JSON-RPC id and options). */
  let seq = 0;
  const waiting = new Map<number, (result: unknown, error: string) => void>();
  const asked = new Map<string, { rpc: unknown; options: Option[] }>();
  /** Events of the batch being read, applied in one call. */
  let out: Ev[] = [];
  /** Counts the processes started: the current one's number (a killed one's lines and end come too late). */
  let processes = 0;
  /** Moves with /new: what the session before it answers late is dropped, as are its updates. */
  let generation = 0;
  const dead = new Set<string>();

  const emit = (e: Ev): void => {
    out.push(e);
  };
  const flush = (): void => {
    if (out.length === 0) return;
    const batch = out;
    out = [];
    api.conversation.apply(batch);
  };
  const notice = (text: string, tone: "info" | "error", detail?: string): void => emit({ type: "notice", text, tone, detail: detail ?? "" });

  const send = (m: Msg): void => {
    if (proc !== null) proc.write(JSON.stringify(m));
  };
  /** A request to the agent; none goes while its process is not running (the next start asks again). */
  const rpc = (method: string, params: unknown, answer: (result: unknown, error: string) => void): void => {
    if (proc === null) return;
    const n = ++seq;
    waiting.set(n, answer);
    send({ jsonrpc: "2.0", id: n, method, params });
  };
  const notify = (method: string, params: unknown): void => send({ jsonrpc: "2.0", method, params });

  /** `path` relative to the folder when it is inside it. */
  const relative = (path: string): string => (cwd.length > 0 && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path);

  /** The text or thinking block being streamed is complete. */
  const closeBlock = (): void => {
    if (open.length > 0) emit({ type: "finish", key: open });
    open = "";
    openKind = "";
    openMessage = "";
  };

  /** A replayed user message is whole: its turn opens. */
  const userDone = (): void => {
    if (userText === null) return;
    emit({ type: "turn", text: userText });
    userText = null;
  };

  /** A chunk of the agent's text or thinking, onto the block being streamed (of the same message, when it names them) or a new one. */
  const chunk = (kind: "text" | "thinking", content: unknown, messageId: string): void => {
    const c = obj(content);
    const text = c !== null && c.type === "text" ? str(c.text) : "";
    if (text.length === 0) return;
    if (open.length > 0 && openKind === kind && (messageId.length === 0 || messageId === openMessage)) {
      emit({ type: "text", key: open, delta: text });
      return;
    }
    closeBlock();
    open = (kind === "text" ? "m" : "th") + String(++blocks);
    openKind = kind;
    openMessage = messageId;
    emit({ type: "block", key: open, kind, text });
  };

  /** A call's line: a command's first line; else its title, unless that is a bare tool name and its input says more. */
  const summaryOf = (kind: string, title: string, input: Msg | null): string => {
    if (input !== null && kind === "execute" && str(input.command).length > 0) return str(input.command).split("\n")[0];
    if (input !== null && !/\s/.test(title.trim())) {
      for (const k of ["command", "filePath", "filepath", "file_path", "path", "pattern", "query", "url", "description"]) {
        const v = str(input[k]);
        if (v.length > 0) return k === "filePath" || k === "filepath" || k === "file_path" || k === "path" ? relative(v) : v.split("\n")[0];
      }
    }
    return title.startsWith(cwd + "/") ? relative(title) : title;
  };

  /** Text from a call's content (text blocks; a diff says its file), else from its raw output. */
  const outputOf = (content: unknown[], raw: unknown): string => {
    const parts: string[] = [];
    for (const v of content) {
      const c = obj(v);
      if (c === null) continue;
      const inner = obj(c.content);
      if (c.type === "content" && inner !== null && inner.type === "text") parts.push(str(inner.text));
    }
    if (parts.length > 0) return parts.join("\n");
    if (typeof raw === "string") return raw;
    const r = obj(raw);
    if (r !== null) {
      for (const k of ["output", "stdout", "result", "error"]) if (typeof r[k] === "string") return r[k] as string;
      return JSON.stringify(raw);
    }
    return "";
  };

  /** A call or an update of one: its block made when new, its facts, and its result once it ended. */
  const call = (u: Msg, announced: boolean): void => {
    const callId = str(u.toolCallId);
    if (callId.length === 0) return;
    const known = calls.get(callId);
    const isNew = announced || known === undefined;
    const kind = str(u.kind).length > 0 ? str(u.kind) : (known?.kind ?? "");
    closeBlock();
    const title = str(u.title);
    const input = obj(u.rawInput);
    const locations = list(u.locations).map((l) => str(obj(l)?.path)).filter((p) => p.length > 0);
    const content = list(u.content);
    const diffs = content.map(obj).filter((c): c is Msg => c !== null && c.type === "diff");
    const todos = list(input?.todos);
    const subagent = input !== null && typeof input.subagent_type === "string";
    // One of widecode's tools, as the agent names it after the server (opencode's widecode_AskUser).
    const tool = own.find((t) => title === t.name || title.endsWith("widecode_" + t.name.replace(/[^A-Za-z0-9_-]/g, "_"))) ?? null;
    // The agent's skill tool (opencode's `skill`, the harness's `Skill`), the skill's name in its input.
    const announcedAs = announced && known === undefined ? title : (known?.tool ?? "");
    const skill = announcedAs.toLowerCase() === "skill" && input !== null ? str(input.name) : "";
    const named = todos.length > 0 || subagent || tool !== null || skill.length > 0 || (known?.named ?? false);
    calls.set(callId, { kind, named, tool: announcedAs });
    const facts: widecode.CallFacts = {};
    // A call is announced with its tool's name as its title (opencode's bash, read, edit), then retitled.
    if (announced && known === undefined && title.length > 0) facts.tool = title;
    // What the update says anew: its kind, its line (a command's stays its command; a todo list's or
    // a subagent's stays what its input made it).
    if (str(u.kind).length > 0 && !named) facts.category = CATEGORY[kind] ?? "other";
    if (!named && (input !== null || (title.length > 0 && kind !== "execute"))) facts.summary = summaryOf(kind, title, input);
    // A command's location is the folder it runs in, no file it touches.
    if (kind !== "execute" && (locations.length > 0 || diffs.length > 0)) facts.paths = locations.length > 0 ? locations : diffs.map((d) => str(d.path));
    if (input !== null && typeof input.command === "string") facts.command = input.command;
    // A todo list or a subagent, as its input names them (the kind does not say).
    if (todos.length > 0) {
      facts.category = "todo";
      facts.summary = String(todos.length) + " todos";
      facts.todos = todos.map((v) => {
        const t = obj(v);
        const s = str(t?.status);
        return { text: str(t?.content), state: (s === "completed" || s === "cancelled" ? "done" : s === "in_progress" ? "doing" : "todo") as "done" | "doing" | "todo" };
      });
    }
    if (tool !== null) {
      facts.category = tool.category.length > 0 ? tool.category : "other";
      if (isNew || input !== null) facts.summary = ownSummary(tool, input);
    }
    if (input !== null && subagent) {
      facts.category = "agent";
      facts.agentType = str(input.subagent_type);
      facts.agentTask = str(input.description);
      facts.agentPrompt = str(input.prompt);
      facts.summary = str(input.subagent_type) + ": " + str(input.description);
    }
    if (skill.length > 0) {
      facts.category = "skill";
      facts.summary = skill;
    }
    if (diffs.length === 1 && (diffs[0].oldText === null || diffs[0].oldText === undefined)) facts.written = cutText(str(diffs[0].newText)).text;
    else if (kind === "edit" && input !== null && typeof input.content === "string") facts.written = cutText(input.content).text;
    const name = tool !== null ? (OWN_NAME[tool.category] ?? tool.name) : skill.length > 0 ? "Skill" : (NAME[kind] ?? "Tool");
    if (isNew) emit({ type: "block", key: callId, kind: "tool", id: callId, name, text: "", ...facts });
    else emit({ type: "facts", id: callId, ...facts });
    if (u.rawInput !== undefined) {
      const json = JSON.stringify(u.rawInput);
      if (inputs.get(callId) !== json) {
        inputs.set(callId, json);
        emit({ type: "input", key: callId, input: u.rawInput, ...(subagent ? { name: "Agent" } : todos.length > 0 ? { name: "Todo" } : {}) });
      }
    }
    const status = str(u.status);
    // A call of widecode's Task tool is in flight until it completes or fails: the Task tool runs
    // under this card when its input is the one asked for here. Any call that ends is dropped, since
    // the agent may retitle it on the way.
    if (status === "completed" || status === "failed") {
      taskCalls.done(callId);
      inputs.delete(callId);
    } else if (tool !== null && tool.name === "Task" && input !== null) taskCalls.record(callId, str(input.prompt), str(input.description));
    if (status !== "completed" && status !== "failed") return;
    // The diff with the file's line numbers when the agent gives one (opencode 1.19's unified diff,
    // 1.2's whole file before and after), else from the diff content's texts (opencode's are the
    // strings replaced, numbered from 1).
    const meta = obj(obj(u.rawOutput)?.metadata);
    const whole = obj(meta?.filediff);
    const unified = str(whole?.patch).length > 0 ? str(whole?.patch) : str(meta?.diff);
    const patch: { oldStart: number; newStart: number; lines: string[] }[] = [];
    if (unified.length > 0) patch.push(...unifiedHunks(unified));
    else if (whole !== null && typeof whole.before === "string" && typeof whole.after === "string" && whole.before.length + whole.after.length <= MAX_WHOLE) patch.push(...hunksOf(whole.before, whole.after));
    if (patch.length === 0) for (const d of diffs) patch.push(...hunksOf(str(d.oldText), str(d.newText)));
    emit({ type: "result", id: callId, ...resultOf(outputOf(content, u.rawOutput), u.rawOutput), error: status === "failed", ...(patch.length > 0 ? { patch } : {}) });
    emit({ type: "finish", key: callId });
    if (status === "completed") for (const d of diffs) emit({ type: "edited", path: str(d.path) });
    midTurn();
  };

  /** The agent's plan, as a todo list. */
  const plan = (u: Msg): void => {
    closeBlock();
    const key = "plan" + String(++plans);
    const todos = list(u.entries).map((v) => {
      const e = obj(v);
      const s = str(e?.status);
      return { text: str(e?.content), state: (s === "completed" ? "done" : s === "in_progress" ? "doing" : "todo") as "done" | "doing" | "todo" };
    });
    emit({ type: "block", key, kind: "tool", id: key, name: "Plan", text: "", category: "todo", summary: String(todos.length) + " todos", todos });
    emit({ type: "result", id: key, text: "" });
    emit({ type: "finish", key });
  };

  /** Whether this agent took /title over (an agent whose session commands include `title` names it on request; the sessions plugin's /title says another agent names its own). */
  let titleOffered = false;
  const offerTitle = (): void => {
    if (titleOffered) return;
    titleOffered = true;
    api.commands.add({
      name: "/title",
      usage: "[title]",
      help: "ask " + entry.name + " for a new title, or give one",
      run: (words) => {
        const r = api.agent.send("/title" + (words.length > 0 ? " " + words : ""));
        if (r.error.length > 0) api.tell(r.error);
      },
    });
  };
  const dropTitle = (): void => {
    if (!titleOffered) return;
    titleOffered = false;
    api.commands.remove("/title");
  };

  /** A session/update notification. */
  const update = (u: Msg): void => {
    const what = str(u.sessionUpdate);
    if (replaying && quiet && what !== "current_mode_update" && what !== "available_commands_update") return;
    if (what === "user_message_chunk") {
      // Replayed by session/load; a live turn's own prompt is already shown.
      if (!replaying) return;
      const c = obj(u.content);
      // Another message (two in a row: one the agent did not answer) is another turn.
      if (userText !== null && str(u.messageId).length > 0 && str(u.messageId) !== userMessage) userDone();
      if (userText === null) {
        closeBlock();
        userText = "";
        userMessage = str(u.messageId);
      }
      // A part meant for the agent alone (a file's text it was given) is not the user's words.
      const audience = list(obj(c?.annotations)?.audience);
      if (c !== null && c.type === "text" && !(audience.length === 1 && audience[0] === "assistant")) userText += str(c.text);
      return;
    }
    userDone();
    if (what === "agent_message_chunk") chunk("text", u.content, str(u.messageId));
    else if (what === "agent_thought_chunk") chunk("thinking", u.content, str(u.messageId));
    else if (what === "tool_call") call(u, true);
    else if (what === "tool_call_update") call(u, false);
    else if (what === "plan") plan(u);
    else if (what === "current_mode_update") {
      const mode = settings.get("mode");
      const changed = mode !== undefined && mode.current !== str(u.currentModeId);
      if (mode !== undefined) mode.current = str(u.currentModeId);
      emit({ type: "mode", mode: str(u.currentModeId) });
      if (changed && ready) readTools();
    } else if (what === "config_option_update") applyOptions(u.configOptions);
    else if (what === "available_commands_update") {
      const names = list(u.availableCommands).map((c) => str(obj(c)?.name)).filter((n) => n.length > 0);
      emit({ type: "session", commands: names });
      if (names.includes("title")) offerTitle();
      else dropTitle();
    }
    else if (what === "usage_update") {
      const cost = obj(u.cost);
      // A cancelled turn reports nothing used (opencode): the context stays as it was.
      emit({ type: "usage", ...(typeof u.used === "number" && u.used > 0 ? { contextUsed: u.used } : {}), ...(typeof u.size === "number" ? { contextSize: u.size } : {}), ...(cost !== null && str(cost.currency) === "USD" && typeof cost.amount === "number" ? { costUsd: cost.amount } : {}) });
    }
  };

  /** The session's model, effort and mode as they stand, and what it offers, to the conversation. */
  const announce = (): void => {
    emit({ type: "choices", models: settings.get("model")?.options ?? [], efforts: settings.get("thought_level")?.options ?? [], modes: settings.get("mode")?.options ?? [] });
    const mode = settings.get("mode")?.current ?? "";
    const model = settings.get("model")?.current ?? "";
    const effort = settings.get("thought_level")?.current ?? "";
    emit({ type: "session", id: session, cwd, ...(mode.length > 0 ? { mode } : {}), ...(model.length > 0 ? { model } : {}), ...(effort.length > 0 ? { effort } : {}) });
    if (mode.length > 0) emit({ type: "mode", mode });
    if (model.length > 0) emit({ type: "usage", model });
  };

  /** Config options (selects, their values grouped or not), kept by category. */
  const applyOptions = (v: unknown): void => {
    for (const x of list(v)) {
      const o = obj(x);
      if (o === null || o.type !== "select") continue;
      const category = str(o.category).length > 0 ? str(o.category) : str(o.id);
      settings.set(category, setting(str(o.id), optionsOf(o.options), str(o.currentValue)));
    }
    announce();
  };

  /** What a session/new or session/load answered: its config options, else its modes and models. */
  const sessionInfo = (r: Msg | null): void => {
    settings = new Map<string, Setting>();
    if (r !== null && Array.isArray(r.configOptions)) {
      applyOptions(r.configOptions);
      return;
    }
    const m = obj(r?.modes);
    const ms = obj(r?.models);
    const named = (v: unknown, key: string): widecode.AgentOption[] =>
      list(v)
        .map((x) => ({ value: str(obj(x)?.[key]), name: str(obj(x)?.name) || str(obj(x)?.[key]) }))
        .filter((o) => o.value.length > 0);
    if (m !== null) settings.set("mode", setting("", named(m.availableModes, "id"), str(m.currentModeId)));
    if (ms !== null) settings.set("model", setting("", named(ms.availableModels, "modelId"), str(ms.currentModelId)));
    announce();
  };

  /** The agent's tools for its mode, from the entry's tools command, with widecode's it was given. */
  const readTools = (): void => {
    const seq = ++toolReads;
    const gen = generation;
    const mode = settings.get("mode")?.current ?? "";
    const told = (listed: { names: string[]; rules: Rule[] } | null): void => {
      if (seq !== toolReads || gen !== generation) return;
      const rules = listed !== null ? listed.rules : [];
      const facts = (id: string): widecode.AgentTool => {
        const a = rules.length > 0 ? accessOf(id, rules) : { access: "", scope: "" };
        return { ...(a.access.length > 0 ? { access: a.access as "asks" | "limited" | "denied" } : {}), ...(a.scope.length > 0 ? { scope: a.scope } : {}), name: id };
      };
      const theirs = listed !== null ? listed.names.map((name) => facts(name)) : [];
      // widecode's, as the agent names them after the server.
      const ours = own.map((t) => {
        const id = "widecode_" + t.name.replace(/[^A-Za-z0-9_-]/g, "_");
        return { ...facts(id), name: t.name, server: "widecode", id };
      });
      emit({ type: "tools", tools: [...theirs, ...ours], ...(own.length > 0 ? { servers: [{ name: "widecode", status: "connected" }] } : {}), partial: listed === null });
      flush();
    };
    if (entry.tools.length === 0 || (mode.length === 0 && entry.tools.some((w) => w.includes("{mode}")))) return told(null);
    const words = resolved(api, entry.tools).map((w) => w.split("{mode}").join(mode));
    api.process.run(throughFile(cwd, words), "", 15000).then(
      (r) => {
        let v: unknown = null;
        try {
          v = r.code === 0 ? JSON.parse(r.out) : null;
        } catch {
          v = null;
        }
        told(listedOf(v));
      },
      () => told(null),
    );
  };

  /** The agent's skills, from the entry's skills command (none without one: the conversation is told an empty list, so the tab says so). */
  const readSkills = (): void => {
    const seq = ++skillReads;
    const gen = generation;
    const told = (v: unknown): void => {
      if (seq !== skillReads || gen !== generation) return;
      emit({ type: "skills", skills: skillsOf(v, cwd, api.fs.home()) });
      flush();
    };
    if (entry.skills.length === 0) return told(null);
    api.process.run(throughFile(cwd, resolved(api, entry.skills)), "", 15000).then(
      (r) => {
        let v: unknown = null;
        try {
          v = r.code === 0 ? JSON.parse(r.out) : null;
        } catch {
          v = null;
        }
        told(v);
      },
      () => told(null),
    );
  };

  /** The effort asked for before the session was ready or while its model switched goes, when the model has it and does not run on it. */
  const wantedEffort = (): void => {
    const level = wantEffort;
    wantEffort = "";
    const s = settings.get("thought_level");
    if (level.length > 0 && s !== undefined && s.values.includes(level) && s.current !== level) setEffort(level);
  };

  /** The session is ready: what was asked meanwhile goes (a model only when the agent has it, then the effort, which the model decides the choices of). */
  const sessionReady = (): void => {
    ready = true;
    readTools();
    readSkills();
    if (wantMode.length > 0) setMode(wantMode);
    const model = wantModel;
    wantMode = "";
    wantModel = "";
    const m = settings.get("model");
    if (model.length > 0 && m !== undefined && m.values.includes(model) && m.current !== model) setModel(model);
    else wantedEffort();
    pump();
  };

  /** widecode's MCP server, for an agent that takes one over HTTP ([] else, or with no tools), then `then`. */
  const withServers = (then: (servers: unknown[]) => void): void => {
    if (!canMcp) return then([]);
    api.tools.server().then(
      (s) => {
        own = s === null ? [] : s.tools;
        then(s === null ? [] : [{ type: "http", name: "widecode", url: s.url, headers: s.headers }]);
      },
      () => then([]),
    );
  };

  const newSession = (): void => {
    ready = false;
    const gen = generation;
    withServers((mcpServers) => {
      if (gen === generation && proc !== null) newSessionWith(mcpServers);
    });
  };

  const newSessionWith = (mcpServers: unknown[]): void => {
    const gen = generation;
    rpc("session/new", { cwd, mcpServers, ...metaOf() }, (result, error) => {
      if (gen !== generation) return;
      if (error.length > 0) {
        notice(entry.name + " could not start a session", "error", error);
        failQueue();
        return;
      }
      const r = obj(result);
      session = str(r?.sessionId);
      shown = session;
      listedAt = 0;
      // Nothing written to it yet: deleted if it is left so.
      fresh = session;
      rememberFresh(api, { agent: id, id: session, pid: ownPid(api), folder: cwd });
      sessionInfo(r);
      sessionReady();
    });
  };

  /** The session made and not written to, forgotten and deleted now (left for another, or for a new one). */
  const forgetFresh = (): void => {
    const sid = fresh;
    fresh = "";
    if (sid.length === 0) return;
    dropFresh(api, sid);
    deleteSession(api, entry, cwd, sid, "unused session");
  };

  /** Load session `sid`: its turns replayed into the chat unless it is the one shown. */
  const load = (sid: string): void => {
    if (fresh.length > 0 && fresh !== sid) forgetFresh();
    ready = false;
    replaying = true;
    quiet = sid === shown;
    session = sid;
    // One left with /new and resumed now is heard again.
    dead.delete(sid);
    const gen = generation;
    withServers((mcpServers) => {
      if (gen === generation && proc !== null) loadWith(sid, mcpServers);
    });
  };

  const loadWith = (sid: string, mcpServers: unknown[]): void => {
    const gen = generation;
    rpc("session/load", { sessionId: sid, cwd, mcpServers, ...metaOf() }, (result, error) => {
      if (gen !== generation) return;
      userDone();
      closeBlock();
      if (!quiet) emit({ type: "close" });
      replaying = false;
      quiet = false;
      if (error.length > 0) {
        notice(entry.name + " could not load the session", "error", error);
        session = "";
        newSession();
        return;
      }
      shown = sid;
      sessionInfo(obj(result));
      sessionReady();
    });
  };

  /** Reopen session `sid` without replay (session/resume, an agent that has no session/load): its earlier turns stay unseen. */
  const resumeSession = (sid: string): void => {
    if (fresh.length > 0 && fresh !== sid) forgetFresh();
    ready = false;
    quiet = sid === shown;
    session = sid;
    // One left with /new and resumed now is heard again.
    dead.delete(sid);
    const gen = generation;
    withServers((mcpServers) => {
      if (gen === generation && proc !== null) resumeWith(sid, mcpServers);
    });
  };

  const resumeWith = (sid: string, mcpServers: unknown[]): void => {
    const gen = generation;
    rpc("session/resume", { sessionId: sid, cwd, mcpServers, ...metaOf() }, (result, error) => {
      if (gen !== generation) return;
      userDone();
      closeBlock();
      if (!quiet) {
        emit({ type: "close" });
        notice(entry.name + " resumed the session; its earlier turns are not shown", "info");
      }
      quiet = false;
      if (error.length > 0) {
        notice(entry.name + " could not resume the session", "error", error);
        session = "";
        newSession();
        return;
      }
      shown = sid;
      sessionInfo(obj(result));
      sessionReady();
    });
  };

  /** Reopen `sid` the way the agent offers: its turns replayed (session/load), else without them (session/resume), else a new session. */
  const reopen = (sid: string): void => {
    if (canLoad) load(sid);
    else if (canResume) resumeSession(sid);
    else {
      notice(entry.name + " cannot reopen a past session", "error");
      newSession();
    }
  };

  /** Messages that cannot go (no session): said, and off the queue. */
  const failQueue = (): void => {
    for (const m of queue.splice(0)) emit({ type: "take", text: m.text });
  };

  /** The next message goes when the session is ready and no turn runs. */
  const pump = (): void => {
    if (!ready || inTurn || queue.length === 0 || proc === null) return;
    const m = queue.shift()!;
    inTurn = true;
    turnAt = Date.now();
    cancelled = false;
    open = "";
    emit({ type: "take", text: m.text });
    emit({ type: "turn", text: m.text, images: m.images.length, imagePaths: m.images.map((i) => i.path ?? "") });
    prompts = 0;
    promptError = "";
    prompt(m);
  };

  /** Messages queued while a turn runs go into it once a call ends, the agent's next step reading them (an agent that takes them). */
  const midTurn = (): void => {
    if (!entry.midTurn || !ready || !inTurn || cancelled || queue.length === 0 || proc === null) return;
    for (const m of queue.splice(0)) {
      emit({ type: "take", text: m.text });
      emit({ type: "prompt", text: m.text, images: m.images.length, imagePaths: m.images.map((i) => i.path ?? "") });
      prompt(m);
    }
  };

  /** Prompt the session with message `m`; the turn ends once every prompt out for it is answered (opencode answers them together). */
  const prompt = (m: { text: string; images: { mediaType: string; data: string; path?: string }[] }): void => {
    const blocks: unknown[] = [{ type: "text", text: m.text }];
    if (canImages) for (const i of m.images) blocks.push({ type: "image", mimeType: i.mediaType, data: i.data });
    if (fresh === session) {
      fresh = "";
      dropFresh(api, session);
    }
    const gen = generation;
    prompts++;
    rpc("session/prompt", { sessionId: session, prompt: blocks, ...metaOf() }, (result, answerError) => {
      if (gen !== generation) return;
      prompts--;
      if (answerError.length > 0 && promptError.length === 0) promptError = answerError;
      if (prompts > 0) return;
      const error = promptError;
      closeBlock();
      inTurn = false;
      // The session's place in the list moved.
      listedAt = 0;
      const reason = cancelled ? "cancelled" : str(obj(result)?.stopReason);
      cancelled = false;
      const usage = obj(obj(result)?.usage);
      if (usage !== null) {
        tokensIn += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
        tokensOut += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
        emit({ type: "usage", inputTokens: tokensIn, outputTokens: tokensOut });
      }
      if (error.length > 0) notice("Error", "error", error);
      else if (reason === "cancelled") notice("Interrupted", "info");
      else if (reason === "refusal") notice(entry.name + " refused", "error");
      else if (reason === "max_tokens") notice("Stopped: the reply reached its token limit", "info");
      else if (reason === "max_turn_requests") notice("Stopped: the turn reached its limit of model requests", "info");
      emit({ type: "end", error: error.length > 0 || reason === "refusal", status: reason, durationMs: Date.now() - turnAt });
      pump();
    });
  };

  /** A request from the agent: a permission asked, else not something widecode offers. */
  const request = (m: Msg): void => {
    const method = str(m.method);
    const p = obj(m.params);
    if (method !== "session/request_permission" || p === null) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "widecode does not offer " + method } });
      return;
    }
    // A side question's session asks for nothing: it answers from what it knows.
    if (sides.has(str(p.sessionId))) {
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const tool = obj(p.toolCall);
    const options: Option[] = list(p.options).map((v) => {
      const o = obj(v);
      return { optionId: str(o?.optionId), name: str(o?.name), kind: str(o?.kind) };
    });
    const rid = "perm" + String(m.id);
    asked.set(rid, { rpc: m.id, options });
    const callId = str(tool?.toolCallId);
    const title = str(tool?.title);
    // The call it asks about shows while it waits, announced or not.
    if (tool !== null && callId.length > 0 && !calls.has(callId)) call(tool, false);
    const kind = str(tool?.kind);
    const what = summaryOf(kind, title, obj(tool?.rawInput));
    emit({
      type: "request",
      id: rid,
      category: "permission",
      name: title,
      callId,
      permission: true,
      ...(tool?.rawInput !== undefined ? { input: tool.rawInput } : {}),
      questions: [{ question: (NAME[kind] ?? "Tool") + " " + (what.length > 0 ? what : title) + ": allow it?", header: "Permission", options: options.map((o) => ({ label: o.name, description: o.kind.replace(/_/g, " ") })) }],
    });
  };

  /** Answer permission `rid`: option `optionId`, or cancelled. */
  const answerPermission = (rid: string, optionId: string): void => {
    const a = asked.get(rid);
    if (a === undefined) return;
    asked.delete(rid);
    send({ jsonrpc: "2.0", id: a.rpc, result: { outcome: optionId.length > 0 ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
  };

  const lines = (ls: string[]): void => {
    for (const l of ls) {
      let m: Msg | null;
      try {
        m = obj(JSON.parse(l));
      } catch {
        m = null;
      }
      if (m === null) continue;
      if (m.method === undefined && typeof m.id === "number") {
        const answer = waiting.get(m.id);
        waiting.delete(m.id);
        const err = obj(m.error);
        if (answer !== undefined) answer(m.result, err !== null ? str(err.message) + (err.data !== undefined ? ": " + JSON.stringify(err.data) : "") : "");
      } else if (m.id !== undefined && m.id !== null) request(m);
      else if (m.method === "session/update") {
        const p = obj(m.params);
        const u = obj(p?.update);
        const sid = str(p?.sessionId);
        const side = sides.get(sid);
        if (side !== undefined) {
          if (u !== null && u.sessionUpdate === "agent_message_chunk") {
            side.text += str(obj(u.content)?.text);
            emit({ type: "aside", id: side.id, text: side.text });
          }
        } else if (u !== null && !dead.has(sid) && (sid === session || session.length === 0)) update(u);
      }
    }
    flush();
  };

  /** The process ended: a turn it ran ends with it; the next message starts it again and loads its session. */
  const exited = (code: number): void => {
    // A process killed is over already; what it says after is not heard.
    processes++;
    proc = null;
    dropTitle();
    initialized = false;
    ready = false;
    switching = false;
    const answers = [...waiting.values()];
    waiting.clear();
    asked.clear();
    for (const answer of answers) answer(null, "the agent's process ended");
    if (code !== 0 && code !== -1) notice(entry.name + " ended (exit code " + String(code) + ")", "error");
    emit({ type: "process", state: "ended" });
    flush();
  };

  /** Start the process and initialize it, then `then`; "" or why it could not start. */
  const spawn = (folder: string, then: () => void): string => {
    cwd = folder;
    // Sessions made and left by processes before this one go (not the one this process loads again).
    sweep(api, entries, fresh);
    // Its lines and its end are heard while it is the process (one killed is replaced at once).
    const seq = ++processes;
    const command = resolved(api, entry.command);
    const p = api.process.spawn(command, { cwd: folder }, {
      lines: (ls) => {
        if (seq === processes) lines(ls);
      },
      exit: (code) => {
        if (seq === processes) exited(code);
      },
      error: (text) => api.note(id + ": " + text.trimEnd()),
    });
    if (!p.started) return "cannot start " + command.join(" ");
    proc = p;
    emit({ type: "process", state: "running" });
    rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "widecode", version: String(widecode.version) } }, (result, error) => {
      if (error.length > 0) {
        notice(entry.name + " did not start", "error", error);
        failQueue();
        return;
      }
      const caps = obj(obj(result)?.agentCapabilities);
      canLoad = caps?.loadSession === true;
      canResume = obj(caps?.sessionCapabilities)?.resume !== undefined;
      canImages = obj(caps?.promptCapabilities)?.image === true;
      canList = obj(caps?.sessionCapabilities)?.list !== undefined;
      canMcp = obj(caps?.mcpCapabilities)?.http === true;
      canFork = obj(caps?.sessionCapabilities)?.fork !== undefined;
      initialized = true;
      then();
    });
    return "";
  };

  /** Choose `value` for the setting of `category` ("" or why not): a config option, else the older set_mode and set_model. */
  const choose = (category: string, value: string, what: string): string => {
    const s = settings.get(category);
    if (s === undefined || (s.id.length === 0 && category === "thought_level")) return entry.name + " has no " + what + " to choose";
    if (s.values.length > 0 && !s.values.includes(value)) {
      const some = s.values.slice(0, 8).join(", ") + (s.values.length > 8 ? ", … (" + String(s.values.length) + ")" : "");
      return entry.name + " has no " + what + " " + value + " (it has " + some + ")";
    }
    const answered = (result: unknown, error: string): void => {
      if (error.length > 0) notice(what + " " + value + ": " + error, "error");
      else if (Array.isArray(obj(result)?.configOptions)) applyOptions(obj(result)?.configOptions);
      else {
        s.current = value;
        announce();
      }
      // Another mode may have other tools; another model other efforts, so the effort asked for meanwhile goes now.
      if (error.length === 0 && category === "mode") readTools();
      if (category === "model") {
        switching = false;
        wantedEffort();
      }
    };
    if (category === "model") switching = true;
    if (s.id.length > 0) rpc("session/set_config_option", { sessionId: session, configId: s.id, value }, answered);
    else if (category === "mode") rpc("session/set_mode", { sessionId: session, modeId: value }, answered);
    else rpc("session/set_model", { sessionId: session, modelId: value }, answered);
    return "";
  };

  const setMode = (mode: string): string => {
    if (!ready) {
      wantMode = mode;
      return "";
    }
    return choose("mode", mode, "mode");
  };

  const setModel = (name: string): void => {
    if (!ready) {
      wantModel = name;
      return;
    }
    const why = choose("model", name, "model");
    if (why.length === 0) return;
    // The status goes back to the model the agent runs on.
    notice(why, "info");
    announce();
  };

  const setEffort = (level: string): void => {
    if (!ready || switching) {
      wantEffort = level;
      return;
    }
    const why = choose("thought_level", level, "effort");
    if (why.length === 0) return;
    notice(why, "info");
    announce();
  };

  /** A listing read: kept, and said when it changed. */
  const gotSessions = (folder: string, l: widecode.AgentSession[]): void => {
    listing = false;
    const changed = folder !== listedFolder || JSON.stringify(l) !== JSON.stringify(listed);
    listed = l;
    listedFolder = folder;
    listedAt = Date.now();
    if (!changed) return;
    emit({ type: "sessions" });
    flush();
  };

  /** Read the sessions of `folder` in the background: from the agent while it runs and can list them, else from the entry's command. */
  const readSessions = (folder: string): void => {
    if (listing) return;
    if (proc !== null && initialized && canList) {
      listing = true;
      rpc("session/list", { cwd: folder }, (result, error) => gotSessions(folder, error.length > 0 ? listed : sessionsOf(obj(result)?.sessions, folder)));
      return;
    }
    if (entry.sessions.length === 0) return;
    listing = true;
    api.process.run(throughFile(folder, resolved(api, entry.sessions)), "", 10000).then(
      (r) => {
        let v: unknown = [];
        try {
          v = r.code === 0 ? JSON.parse(r.out) : [];
        } catch {
          v = [];
        }
        gotSessions(folder, sessionsOf(v, folder));
      },
      () => {
        listing = false;
      },
    );
  };

  /** Session `sid`, a side question's fork, deleted with the entry's forget command once it answered. */
  const forget = (sid: string): void => deleteSession(api, entry, cwd, sid, "side session");

  /** Side question `question` in a fork of the session (read-only in the agent's plan mode, when it has one), its answer streamed as aside events. */
  const askAside = (question: string): string => {
    if (!canFork) return entry.name + " cannot fork a session for a side question";
    if (!ready || session.length === 0) return "a side question needs the session: send " + entry.name + " a message first";
    const aside = "btw" + String(++sideSeq);
    emit({ type: "aside", id: aside, question });
    const gen = generation;
    const failed = (why: string): void => emit({ type: "aside", id: aside, error: why });
    rpc("session/fork", { sessionId: session, cwd, mcpServers: [], ...metaOf() }, (result, error) => {
      if (gen !== generation) return;
      const fork = str(obj(result)?.sessionId);
      if (error.length > 0 || fork.length === 0) return failed(error.length > 0 ? error : entry.name + " made no fork");
      sides.set(fork, { id: aside, text: "" });
      const ask = (): void =>
        rpc("session/prompt", { sessionId: fork, prompt: [{ type: "text", text: SIDE_PROMPT + question }] }, (_answer, answerError) => {
          const side = sides.get(fork);
          sides.delete(fork);
          if (answerError.length > 0) failed(answerError);
          else emit({ type: "aside", id: aside, text: side !== undefined && side.text.trim().length > 0 ? side.text.trim() : entry.name + " gave no answer", done: true });
          forget(fork);
        });
      const mode = settings.get("mode");
      if (mode === undefined || !mode.values.includes("plan")) return ask();
      if (mode.id.length > 0) rpc("session/set_config_option", { sessionId: fork, configId: mode.id, value: "plan" }, () => ask());
      else rpc("session/set_mode", { sessionId: fork, modeId: "plan" }, () => ask());
    });
    flush();
    return "";
  };

  /** Cancel the turn: permissions still asked are withdrawn first, as ACP asks. */
  const cancel = (): void => {
    for (const rid of [...asked.keys()]) {
      answerPermission(rid, "");
      emit({ type: "cancelRequest", id: rid });
    }
    if (inTurn && session.length > 0) {
      cancelled = true;
      notify("session/cancel", { sessionId: session });
    }
  };

  return {
    id,
    name: entry.name,
    // Its session starts with widecode: the models and efforts it offers are known before the first message.
    eager: true,
    start(o) {
      const folder = o.cwd;
      harnessPrompt = o.systemPrompt;
      if (proc !== null) {
        // The process runs with no session (after /new): a new one, on the model and effort chosen.
        if (initialized && !ready && !replaying) {
          wantModel = o.model;
          wantEffort = o.effort;
          if (session.length > 0) reopen(session);
          else newSession();
        }
        flush();
        return "";
      }
      const target = session.length > 0 ? session : o.resume;
      wantModel = o.model;
      wantEffort = o.effort;
      const error = spawn(folder, () => (target.length > 0 ? reopen(target) : newSession()));
      flush();
      return error;
    },
    send(text, images) {
      queue.push({ text, images });
      pump();
      flush();
      return "";
    },
    interrupt() {
      cancel();
      flush();
    },
    setMode(mode) {
      const r = setMode(mode);
      flush();
      return r;
    },
    setModel(name) {
      setModel(name);
      flush();
    },
    setEffort(level) {
      setEffort(level);
      flush();
    },
    respond(req, reply) {
      const a = asked.get(req.id);
      if (a === undefined) return;
      const label = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
      const chosen = a.options.find((o) => o.name === label) ?? a.options.find((o) => o.kind === "reject_once") ?? null;
      answerPermission(req.id, chosen !== null ? chosen.optionId : "");
    },
    withdraw() {
      // Those not yet sent come back; one sent into the turn is the agent's now.
      emit({ type: "withdrawn", texts: queue.splice(0).map((m) => m.text) });
      flush();
      return "";
    },
    sideQuestion(question) {
      return askAside(question);
    },
    resume(sid) {
      if (proc !== null && initialized) {
        if (!canLoad && !canResume) notice(entry.name + " cannot reopen a past session", "error");
        else reopen(sid);
        emit({ type: "process", state: "running" });
      } else if (proc === null) {
        const error = spawn(api.state.active().folder, () => (canLoad || canResume ? reopen(sid) : notice(entry.name + " cannot reopen a past session", "error")));
        if (error.length > 0) notice(error, "error");
      }
      flush();
    },
    reset() {
      cancel();
      generation++;
      // One made and never written to is not worth keeping.
      if (fresh.length > 0 && fresh === session) forgetFresh();
      if (session.length > 0) dead.add(session);
      queue.splice(0);
      replaying = false;
      userText = null;
      tokensIn = 0;
      tokensOut = 0;
      session = "";
      shown = "";
      ready = false;
      switching = false;
      wantEffort = "";
      inTurn = false;
      prompts = 0;
      sides.clear();
      open = "";
      flush();
    },
    sessions(folder) {
      if (folder !== listedFolder || Date.now() - listedAt > LISTING_MS) readSessions(folder);
      return folder === listedFolder ? listed : [];
    },
    loadSubagent(callId) {
      // A Task run keeps its own transcript under the session it started in; read it back under
      // the call, as Claude's adapter does.
      const sid = session.length > 0 ? session : api.agent.sessionId();
      if (sid.length === 0) return false;
      let raw = "";
      try {
        raw = api.store.taskTranscript(sid, callId);
      } catch {
        raw = "";
      }
      if (raw.length === 0) return false;
      const events: unknown[] = [];
      for (const line of raw.split("\n")) if (line.length > 0) {
        const v = parse(line);
        if (v !== null) events.push(v);
      }
      if (events.length === 0) return false;
      api.conversation.subagent(callId, events as widecode.ConversationEvent[], true);
      return true;
    },
    stop() {
      if (proc !== null) proc.stop(2000);
    },
    kill() {
      if (proc === null) return;
      // The session made and not written to is left (deleted when the agent starts again, here or in a later widecode).
      fresh = "";
      proc.kill();
      exited(-1);
    },
  };
};

/** A request waiting on the subagent's answer, with what hears it. */
class Waiter {
  readonly id: number;
  readonly then: (result: Msg | null, error: string) => void;

  constructor(id: number, then: (result: Msg | null, error: string) => void) {
    this.id = id;
    this.then = then;
  }
}

/**
 * One Task run: an ACP agent started for a target, its session and prompt, mapped into the
 * conversation under the call Claude made. It answers the MCP call with the subagent's last words,
 * and dies with it.
 */
class SubagentRun {
  private readonly api: widecode.Api;
  private readonly entry: Entry;
  private readonly target: TaskTarget;
  private readonly box: BoxRunner | null;
  private readonly boxFolder: string;
  private readonly cwd: string;
  private readonly worktree: string;
  private readonly model: string;
  private readonly callId: string;
  private readonly description: string;
  private readonly synthetic: boolean;
  private readonly background: boolean;
  private readonly timeoutMs: number;
  private readonly onDone: () => void;
  private proc: widecode.ProcessHandle | null = null;
  private seq = 0;
  private waiting: Waiter[] = [];
  private session = "";
  private runSession = "";
  private modelConfig = "";
  private open = "";
  private openKind = "";
  private blocks = 0;
  private calls = new Map<string, string>();
  /** The last input JSON emitted for each open call, dropped when the call finishes. */
  private inputs = new Map<string, string>();
  private out: unknown[] = [];
  /** The events applied so far, each as its JSON line: encoded once, as it streams, so keeping them is a join. */
  private history: string[] = [];
  /** The characters kept in `history`, and the size at which the next line is logged. */
  private historyChars = 0;
  private historyLoggedAt = HISTORY_LOG_CHARS;
  private reply = "";
  /** The title of a permission this prompt's run refused, while it has not reported its end. */
  private refused = "";
  private busy = false;
  private closed = false;
  /** Whether this call has a result reported to the parent, so a later process exit does not report it again. */
  private reported = false;
  private timeoutGen = 0;
  private resolve: (text: string) => void = () => {};
  private reject: (error: Error) => void = () => {};
  readonly promise: Promise<string>;

  constructor(api: widecode.Api, entry: Entry, target: TaskTarget, box: BoxRunner | null, boxFolder: string, cwd: string, worktree: string, model: string, callId: string, description: string, synthetic: boolean, background: boolean, timeoutMs: number, onDone: () => void) {
    this.api = api;
    this.entry = entry;
    this.target = target;
    this.box = box;
    this.boxFolder = boxFolder;
    this.cwd = cwd;
    this.worktree = worktree;
    this.model = model;
    this.callId = callId;
    this.description = description;
    this.synthetic = synthetic;
    this.background = background;
    this.timeoutMs = timeoutMs;
    this.onDone = onDone;
    this.promise = new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /** Keep `e` in the run's history, as the line a later read applies. */
  private keep(e: Ev): void {
    const line = JSON.stringify(e);
    if (line.length > EVENT_LOG_CHARS) this.api.note("acp: task " + this.callId + " event " + str(obj(e)?.type) + " " + String(line.length) + " characters");
    this.history.push(line);
    this.historyChars += line.length;
    while (this.historyChars >= this.historyLoggedAt) {
      this.api.note("acp: task " + this.callId + " history " + String(this.historyChars) + " characters");
      this.historyLoggedAt += HISTORY_LOG_CHARS;
    }
  }

  private flush(): void {
    if (this.out.length === 0) return;
    const batch = this.out;
    this.out = [];
    for (const e of batch) this.keep(e as Ev);
    this.api.conversation.subagent(this.callId, batch as widecode.ConversationEvent[]);
  }

  /** Keep this run's events under the project, so a later run can read its steps back. */
  private persist(): void {
    if (this.runSession.length === 0) this.runSession = this.api.agent.sessionId();
    const sid = this.runSession;
    if (sid.length === 0 || this.history.length === 0) return;
    this.api.store.saveTaskTranscript(sid, this.callId, this.history.join("\n") + "\n");
  }

  /** Run `work`, reporting a failure through the run's own failure path rather than the process's handler. */
  private guard(where: string, work: () => void): void {
    try {
      work();
    } catch (e) {
      this.crashed(where, e);
    }
  }

  /** An exception while handling what the process said: settle the call, or just note it once it has a result. */
  private crashed(where: string, e: unknown): void {
    const why = e instanceof Error ? e.message : String(e);
    const text = "the subagent run failed in " + where + ": " + why;
    try {
      if (!this.closed && !this.reported) this.fail(text);
      else this.api.note("acp: task " + this.callId + ": " + text);
    } catch {
      // A host call is failing; nothing more can be done from here.
    }
  }

  /** Whether a prompt is running: what counts against the bound on subagents at once. */
  working(): boolean {
    return this.busy && !this.closed;
  }

  private emit(e: Ev): void {
    this.out.push(e);
  }

  /** A key or call id of this run, so a subagent's ids cannot collide with the main conversation's. */
  private key(id: string): string {
    return "task:" + this.callId + ":" + id;
  }

  /** A main agent that names no call (an ACP agent) gets the card made here, under its open turn. */
  createCard(): boolean {
    if (!this.synthetic) return true;
    const n = this.api.conversation.apply([{ type: "block", key: this.callId, kind: "tool", id: this.callId, name: "Task", text: "" }]);
    return n > 0;
  }

  start(prompt: string): Promise<string> {
    this.runSession = this.api.agent.sessionId();
    this.busy = true;
    this.reported = false;
    this.emit({ type: "facts", id: this.callId, category: "agent", summary: this.target.name + ": " + this.description, agentType: this.target.name, agentTask: this.description, agentPrompt: prompt });
    this.emit({ type: "task", id: this.callId, taskId: this.callId, description: this.description, agentType: this.target.name, background: this.background });
    this.flush();
    if (this.target.box) {
      if (this.box === null) {
        this.fail("no box is configured for " + this.target.name);
        return this.promise;
      }
      this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "running", summary: "starting the box" });
      this.flush();
      return this.box.ensure(this.boxFolder).then((why) => {
        let out: Promise<string> = this.promise;
        this.guard("its box", () => {
          if (why.length > 0) this.fail(why);
          else out = this.launch(prompt, true);
        });
        return out;
      });
    }
    return this.launch(prompt, false);
  }

  private launch(prompt: string, boxed: boolean): Promise<string> {
    const command = resolved(this.api, this.entry.command);
    const words = boxed && this.box !== null
      ? ["node", this.box.config.script, "ssh", "--forward-proxy", String(this.box.config.proxyPort), "--", ...command]
      : command;
    const p = this.api.process.spawn(words, { cwd: this.cwd }, {
      // Each batch goes under the card as it comes, so the run streams and no one call carries all of it.
      lines: (lines) =>
        this.guard("its output", () => {
          for (const l of lines) this.line(l);
          this.flush();
        }),
      exit: (code) => this.guard("its exit", () => this.exited(code)),
      error: (text) =>
        this.guard("its error output", () => this.api.note(this.entry.name + ": " + text.trimEnd())),
    });
    if (!p.started) {
      const text = "cannot start " + words.join(" ");
      this.closed = true;
      this.onDone();
      if (this.background) this.notify(text, true);
      this.reject(new Error(text));
      return this.promise;
    }
    this.proc = p;
    this.rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "widecode", version: String(widecode.version) } }, (_result, error) => {
      if (error.length > 0) {
        this.fail(error);
        return;
      }
      this.newSession(prompt);
    });
    if (this.background) return Promise.resolve("subagent started: " + this.callId + (this.worktree.length > 0 ? "\nworktree: " + this.worktree : ""));
    return this.promise;
  }

  /** A message from the main agent to an idle run; "" or why not. */
  send(text: string): string {
    if (this.closed || this.proc === null) return "the subagent is not running";
    if (this.busy) return "the subagent is busy";
    this.reported = false;
    this.reply = "";
    this.open = "";
    this.openKind = "";
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "running", summary: this.description });
    this.flush();
    this.prompt(text);
    return "";
  }

  /** The agent cancelled the call, or the user stopped the run: its session stops and its card says so. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    this.reported = true;
    const proc = this.proc;
    this.proc = null;
    if (proc !== null) {
      attempt(() => proc.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } })));
      end(proc, 1000);
    }
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: "stopped" });
    attempt(() => this.flush());
    attempt(() => this.persist());
    attempt(() => this.onDone());
    this.resolve(this.reply.length > 0 ? this.reply : "The subagent was stopped.");
  }

  /** End its process without reporting: the plugin, or the session it ran in, is going away (`why`, for its transcript). */
  stopQuietly(why: string): void {
    const unsettled = !this.reported && !this.closed;
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    // A run that never reported keeps a stopped end in its transcript, so a later read does not say
    // it is still running. It is not sent to the conversation now, nor told to the parent.
    if (unsettled) {
      this.reported = true;
      this.keep({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: "stopped: " + why });
      attempt(() => this.persist());
    }
    const proc = this.proc;
    this.proc = null;
    if (proc === null) return;
    end(proc, 1000);
  }

  /** Whether it ran in another session than `session`, so it should stop with that session. */
  elsewhere(session: string): boolean {
    return this.runSession.length > 0 && this.runSession !== session;
  }

  timeout(): void {
    if (this.closed || !this.busy) return;
    this.fail("The subagent took too long.");
  }

  /** A prompt or the start failed: the card says so, and a background run tells the main agent. */
  private fail(text: string): void {
    if (this.closed || this.reported) return;
    this.closed = true;
    this.busy = false;
    this.timeoutGen++;
    this.reported = true;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "failed", summary: text.split("\n")[0] });
    attempt(() => this.flush());
    attempt(() => this.persist());
    const proc = this.proc;
    this.proc = null;
    if (proc !== null) end(proc, 1000);
    attempt(() => this.onDone());
    if (this.background) {
      attempt(() => this.notify(text, true));
    } else this.reject(new Error(text));
  }

  private rpc(method: string, params: unknown, then: (result: Msg | null, error: string) => void): void {
    if (this.proc === null) {
      then(null, "the agent does not run");
      return;
    }
    const id = ++this.seq;
    this.waiting.push(new Waiter(id, then));
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private newSession(prompt: string): void {
    this.rpc("session/new", { cwd: this.cwd, mcpServers: [] }, (result, error) => {
      if (result === null) {
        this.fail(error.length > 0 ? error : "no session");
        return;
      }
      this.session = str(result.sessionId);
      const options = list(result.configOptions).map(obj).filter((o): o is Msg => o !== null);
      for (const o of options) if (str(o.category) === "model" || str(o.id) === "model") this.modelConfig = str(o.id);
      this.setModel(prompt);
    });
  }

  private setModel(prompt: string): void {
    if (this.model.length === 0) {
      this.prompt(prompt);
      return;
    }
    const then = (_result: Msg | null, error: string): void => {
      if (error.length > 0) this.fail(error);
      else this.prompt(prompt);
    };
    if (this.modelConfig.length > 0) this.rpc("session/set_config_option", { sessionId: this.session, configId: this.modelConfig, value: this.model }, then);
    else this.rpc("session/set_model", { sessionId: this.session, modelId: this.model }, then);
  }

  private prompt(text: string): void {
    this.busy = true;
    this.reported = false;
    this.refused = "";
    const gen = ++this.timeoutGen;
    this.api.after(this.timeoutMs, () =>
      this.guard("its timer", () => {
        if (gen === this.timeoutGen && this.busy) this.timeout();
      }),
    );
    this.rpc("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text }] }, (result, error) => {
      if (error.length > 0) {
        this.promptDone(error, true);
        return;
      }
      const stop = str(obj(result)?.stopReason);
      this.promptDone(this.reply.length > 0 ? this.reply : stop.length > 0 ? "The subagent stopped: " + stop : "The subagent said nothing.", stop === "refusal" || stop === "error");
    });
  }

  private promptDone(text: string, error: boolean): void {
    if (this.closed) return;
    this.busy = false;
    this.timeoutGen++;
    this.reported = true;
    const refused = this.refused;
    this.refused = "";
    const said = refused.length > 0 ? text + "\n\n[a permission was refused: " + refused + "]" : text;
    const summary = error ? said.split("\n")[0] : refused.length > 0 ? "a permission was refused: " + refused : this.description;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: error ? "failed" : "done", summary });
    attempt(() => this.flush());
    attempt(() => this.persist());
    if (!this.background) {
      this.closed = true;
      const proc = this.proc;
      this.proc = null;
      if (proc !== null) end(proc, 500);
      attempt(() => this.onDone());
      if (error) this.reject(new Error(said));
      else this.resolve(this.worktree.length > 0 ? said + "\n\n[worktree: " + this.worktree + "]" : said);
      return;
    }
    attempt(() => this.notify(this.worktree.length > 0 ? said + "\n\n[worktree: " + this.worktree + "]" : said, error));
    this.reply = "";
    this.open = "";
    this.openKind = "";
  }

  /** Tell the main agent a background run finished or failed, when it is running to hear it. */
  private notify(text: string, error: boolean): void {
    const status = error ? "failed" : "finished";
    // A run of a session left since it started tells only the log: the agent now running never started it.
    const elsewhere = this.api.agent.sessionId() !== this.runSession;
    this.api.note("background subagent " + this.callId + " " + status + (elsewhere ? " in another session" : ""));
    if (elsewhere) return;
    if (!this.api.agent.started()) return;
    const line = "[background subagent " + this.callId + " " + status + "]\n" + text;
    const r = this.api.agent.send(line, { from: "task" });
    if (r.error.length > 0) this.api.note("background subagent " + this.callId + ": " + r.error);
  }

  private line(text: string): void {
    const value = parse(text);
    const m = obj(value);
    if (m === null) return;
    const id = typeof m.id === "number" ? m.id : -1;
    if (id >= 0 && (m.result !== undefined || m.error !== undefined)) {
      const at = this.waiting.findIndex((w) => w.id === id);
      if (at < 0) return;
      const waiter = this.waiting[at];
      this.waiting.splice(at, 1);
      const error = obj(m.error);
      waiter.then(obj(m.result), error !== null ? str(error.message) : "");
      return;
    }
    const method = str(m.method);
    if (method.length === 0) return;
    const params = obj(m.params);
    if (method === "session/update") {
      if (params !== null) this.update(obj(params.update));
      return;
    }
    if (method === "session/request_permission" && params !== null) {
      this.permission(m, params);
      return;
    }
    if (m.id !== undefined && m.id !== null && this.proc !== null) {
      this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: method + " is not supported" } }));
    }
  }

  private update(u: Msg | null): void {
    if (u === null) return;
    if (crashOnUpdate) throw new Error("injected update failure");
    const what = str(u.sessionUpdate);
    if (what === "agent_message_chunk") this.chunk("text", u.content);
    else if (what === "agent_thought_chunk") this.chunk("thinking", u.content);
    else if (what === "tool_call") this.call(u);
    else if (what === "tool_call_update") this.call(u);
    else if (what === "plan") this.plan(u);
  }

  private chunk(kind: "text" | "thinking", content: unknown): void {
    const c = obj(content);
    const text = c !== null && c.type === "text" ? str(c.text) : "";
    if (text.length === 0) return;
    if (this.open.length > 0 && this.openKind === kind) {
      this.emit({ type: "text", key: this.open, delta: text });
    } else {
      this.open = this.key(kind + String(++this.blocks));
      this.openKind = kind;
      this.emit({ type: "block", key: this.open, kind, text });
    }
    if (kind === "text") this.reply += text;
  }

  private call(u: Msg): void {
    const id = str(u.toolCallId);
    if (id.length === 0) return;
    const known = this.calls.get(id);
    const key = known !== undefined ? known : this.key("call:" + id);
    if (known === undefined) this.calls.set(id, key);
    const kind = str(u.kind);
    const title = str(u.title);
    const input = obj(u.rawInput);
    const locations = list(u.locations).map((l) => str(obj(l)?.path)).filter((p) => p.length > 0);
    const summary = input !== null && kind === "execute" && str(input.command).length > 0 ? str(input.command).split("\n")[0] : title;
    const facts: widecode.CallFacts = { category: CATEGORY[kind] ?? "other", summary, ...(locations.length > 0 && kind !== "execute" ? { paths: locations } : {}), ...(input !== null && typeof input.command === "string" ? { command: input.command } : {}) };
    if (input !== null && typeof input.subagent_type === "string") {
      facts.category = "agent";
      facts.agentType = str(input.subagent_type);
      facts.agentTask = str(input.description);
      facts.agentPrompt = str(input.prompt);
      facts.summary = str(input.subagent_type) + ": " + str(input.description);
    }
    if (known === undefined) this.emit({ type: "block", key, kind: "tool", id: key, name: NAME[kind] ?? "Tool", text: "", ...facts });
    else this.emit({ type: "facts", id: key, ...facts });
    if (u.rawInput !== undefined) {
      const json = JSON.stringify(u.rawInput);
      if (this.inputs.get(id) !== json) {
        this.inputs.set(id, json);
        this.emit({ type: "input", key, input: u.rawInput });
      }
    }
    const status = str(u.status);
    if (status !== "completed" && status !== "failed") return;
    this.emit({ type: "result", id: key, ...resultOf(this.output(u), u.rawOutput), error: status === "failed" });
    this.emit({ type: "finish", key });
    this.inputs.delete(id);
  }

  /** A call's text from its content blocks, else from its raw output. */
  private output(u: Msg): string {
    const parts: string[] = [];
    for (const v of list(u.content)) {
      const c = obj(v);
      const inner = obj(c?.content);
      if (c !== null && c.type === "content" && inner !== null && inner.type === "text") parts.push(str(inner.text));
    }
    if (parts.length > 0) return parts.join("\n");
    const raw = obj(u.rawOutput);
    if (raw !== null) for (const k of ["output", "stdout", "result", "error"]) if (typeof raw[k] === "string") return raw[k] as string;
    return "";
  }

  private plan(u: Msg): void {
    const key = this.key("plan" + String(++this.blocks));
    const todos: { text: string; state: "done" | "doing" | "todo" }[] = [];
    for (const v of list(u.entries)) {
      const e = obj(v);
      const s = str(e?.status);
      todos.push({ text: str(e?.content), state: s === "completed" ? "done" : s === "in_progress" ? "doing" : "todo" });
    }
    this.emit({ type: "block", key, kind: "tool", id: key, name: "Plan", text: "", category: "todo", summary: String(todos.length) + " todos", todos });
    this.emit({ type: "result", id: key, text: "" });
    this.emit({ type: "finish", key });
  }

  private permission(m: Msg, params: Msg): void {
    const call = obj(params.toolCall);
    const title = call !== null && str(call.title).length > 0 ? str(call.title) : "The subagent";
    const options = list(params.options).map(obj).filter((o): o is Msg => o !== null).map((o) => ({ id: str(o.optionId), label: str(o.name).length > 0 ? str(o.name) : str(o.kind), detail: str(o.kind) }));
    const question = title + " asks for permission";
    this.api.note("subagent " + this.callId + " asks: " + title);
    this.api.conversation
      .ask({ category: "question", name: "Task", permission: true, questions: [{ question, header: "Permission", options: options.map((o) => ({ label: o.label, description: o.detail })) }] }, this.callId)
      .then((reply) =>
        this.guard("its permission", () => {
          const label = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
          const chosen = options.find((o) => o.label === label);
          // The run's answer says a permission was refused, whether or not it went on after it.
          if (!this.closed && (chosen === undefined || chosen.detail.startsWith("reject"))) this.refused = title;
          this.api.note("subagent " + this.callId + " permission: " + (chosen !== undefined ? chosen.label : "cancelled"));
          const answer: unknown = chosen !== undefined ? { outcome: { outcome: "selected", optionId: chosen.id } } : { outcome: { outcome: "cancelled" } };
          if (this.proc !== null) this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }));
        }),
      );
  }

  private exited(code: number): void {
    this.proc = null;
    if (this.closed) return;
    if (this.reported) {
      // Its result already reached the parent: this exit only cleans up a process kept for SendMessage.
      this.closed = true;
      this.busy = false;
      this.timeoutGen++;
      attempt(() => this.api.note("acp: task " + this.callId + ": " + this.entry.name + " ended (exit code " + String(code) + ") after its result"));
      attempt(() => this.onDone());
      return;
    }
    const text = this.entry.name + " ended (exit code " + String(code) + ")";
    if (this.busy) {
      this.promptDone(text, true);
      return;
    }
    this.closed = true;
    this.reported = true;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: text });
    attempt(() => this.flush());
    attempt(() => this.persist());
    attempt(() => this.onDone());
    if (this.background) {
      attempt(() => this.notify(text, true));
    } else this.reject(new Error(text));
  }
}

/** The box this plugin started, stopped when the plugin deactivates. */
let boxRunner: BoxRunner | null = null;
/** The live Task runs, by id, so deactivation stops every process they started. */
let liveRuns: Map<string, SubagentRun> = new Map();

widecode.plugin({
  id: "acp",
  defaults: () => ({ agents: DEFAULT_AGENTS }),
  activate(api) {
    crashOnUpdate = api.fs.env("WIDECODE_ACP_TEST_CRASH") === "update";
    const section = api.settings.section();
    const agents = agentsOf(section);
    const tasks = tasksOf(section);
    for (const run of liveRuns.values()) run.stopQuietly("the acp plugin stopped");
    liveRuns = new Map();
    boxRunner = tasks.box !== null ? new BoxRunner(api, tasks.box) : null;
    const box = boxRunner;
    api.ui.segment({
      name: "box",
      draw: () => {
        if (tasks.targets.length === 0) return [];
        const boxed = tasks.box !== null && tasks.targets.every((t) => t.box);
        return boxed ? [{ text: "boxed", fg: widecode.theme.ok }] : [{ text: "unboxed", fg: widecode.theme.warn }];
      },
    });
    /** The ACP main's calls of widecode's Task tool that are in flight, which the Task tool runs under. */
    const taskCalls = new TaskCalls();
    for (const id of Object.keys(agents)) api.agents.register(acpAgent(api, id, agents[id], taskCalls));
    // Sessions made and left by widecode processes gone (one quit without writing to its session).
    sweep(api, agents, "");
    if (tasks.targets.length === 0) return;
    /** The live runs by id: a background run can be messaged or stopped after its call answered. */
    const runs = liveRuns;
    /** The parent session the runs belong to: a run of a session left since is stopped. */
    let parentSession = api.agent.sessionId();
    api.on("conversationChanged", () => {
      const now = api.agent.sessionId();
      if (now === parentSession) return;
      parentSession = now;
      for (const [id, run] of runs) {
        if (!run.elsewhere(now)) continue;
        run.stopQuietly("its session was left");
        runs.delete(id);
      }
    });
    /** Worktrees being made for a run not started yet. */
    let preparing = 0;
    /** The runs working now: an idle background run waits for a message and holds no place. */
    const working = (): number => {
      let n = preparing;
      for (const run of runs.values()) if (run.working()) n++;
      return n;
    };
    const names = tasks.targets.map((t) => t.name);
    api.tools.add({
      name: "Task",
      description: "Run a subagent in another agent and model, in this folder. Targets: " + tasks.targets.map((t) => t.name + " (" + t.agent + (t.model.length > 0 ? " " + t.model : "") + ")").join(", ") + ". The subagent is not Claude: it runs on the target's model, its steps show under the call, and its final answer is the result. With run_in_background it starts and answers at once; the call id is its id for TaskStop and SendMessage, and its end comes back as a message.",
      category: "agent",
      input: { type: "object", properties: { description: { type: "string", description: "A short label for the call." }, prompt: { type: "string", description: "The whole task for the subagent." }, subagent_type: { type: "string", enum: names, description: "Which target to run." }, model: { type: "string", description: "A model for this call, overriding the target's." }, cwd: { type: "string", description: "The folder; the session's folder when left out." }, name: { type: "string", description: "A display name." }, isolation: { type: "string", enum: ["worktree"], description: "Run it in a git worktree of this folder." }, run_in_background: { type: "boolean", description: "Start it and answer at once; it goes on after this turn." } }, required: ["description", "prompt"] },
      call: (args, ctx) => {
        const wanted = str(args.subagent_type).length > 0 ? str(args.subagent_type) : names[0] ?? "";
        const target = tasks.targets.find((t) => t.name === wanted);
        if (target === undefined) throw new Error("no subagent type " + wanted + "; it has " + names.join(", "));
        const entry = agents[target.agent];
        if (entry === undefined) throw new Error("no agent " + target.agent + " for " + wanted);
        const prompt = str(args.prompt);
        if (prompt.length === 0) throw new Error("a subagent needs a prompt");
        const folder = api.state.active().folder;
        const bare = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);
        const cwd = str(args.cwd);
        if (cwd.length > 0 && bare(cwd) !== bare(folder)) throw new Error("a subagent runs in " + folder + ", not " + cwd);
        const isolation = str(args.isolation);
        if (isolation.length > 0 && isolation !== "worktree") throw new Error("isolation is \"worktree\" or none");
        if (working() >= tasks.maxConcurrent) throw new Error("too many subagents run (" + String(tasks.maxConcurrent) + ")");
        const description = str(args.description).length > 0 ? str(args.description) : str(args.name);
        // An ACP main names no tool-use id, but it announces the call itself: the run goes under that
        // card when its input is this one. A card made here needs an id no earlier run took.
        const claimed = ctx.toolUseId.length === 0 ? taskCalls.claim(prompt, description) : "";
        const synthetic = ctx.toolUseId.length === 0 && claimed.length === 0;
        const id = ctx.toolUseId.length > 0 ? ctx.toolUseId : claimed.length > 0 ? claimed : "task-" + Date.now().toString(36) + "-" + ctx.callId;
        const startRun = (cwd: string, worktree: string, boxFolder: string, onClose?: () => void): Promise<string> => {
          const run = new SubagentRun(api, entry, target, box, boxFolder, cwd, worktree, str(args.model).length > 0 ? str(args.model) : target.model, id, description, synthetic, args.run_in_background === true, tasks.timeoutMs, () => {
            runs.delete(id);
            if (onClose !== undefined) onClose();
          });
          if (!run.createCard()) throw new Error("the main agent cannot take a subagent card");
          runs.set(id, run);
          ctx.onCancel(() => run.cancel());
          return run.start(prompt);
        };
        if (isolation !== "worktree") return startRun(folder, "", folder);
        const part = id.replace(/[^A-Za-z0-9_.-]/g, "_");
        const path = folder + "/.worktrees/" + part;
        const branch = "widecode/task-" + part;
        preparing++;
        const made = (): void => {
          preparing--;
        };
        let cancelled = false;
        ctx.onCancel(() => {
          cancelled = true;
        });
        let baselineStatus = "";
        let baselineHead = "";
        let cleaned = false;
        const removeWorktree = (): Promise<void> => {
          if (cleaned) return Promise.resolve();
          cleaned = true;
          return api.process.run("git -C " + quote(folder) + " worktree remove --force " + quote(path), "", 15000).then(() => api.process.run("git -C " + quote(folder) + " branch -D " + quote(branch), "", 15000).then(() => {}));
        };
        const worktreeOver = (): Promise<boolean> =>
          api.process.run("git -C " + quote(path) + " status --porcelain", "", 15000).then((s) =>
            api.process.run("git -C " + quote(path) + " rev-list --count " + quote(baselineHead) + "..HEAD", "", 15000).then((h) => {
              if (s.code !== 0 || h.code !== 0 || s.out !== baselineStatus || h.out.trim() !== "0") return false;
              return removeWorktree().then(() => true);
            }),
          );
        const keptLine = "\n\n[worktree: " + path + " (branch " + branch + ")]";
        const goneLine = "\n\n[worktree removed: no changes]";
        const withLine = (text: string, removed: boolean): string => {
          if (text.endsWith(goneLine)) return removed ? text : text.slice(0, text.length - goneLine.length) + keptLine;
          if (text.endsWith(keptLine)) return removed ? text.slice(0, text.length - keptLine.length) + goneLine : text;
          return text + (removed ? goneLine : keptLine);
        };
        const background = args.run_in_background === true;
        const prepared = async (): Promise<string> => {
          try {
            const gitDir = await api.process.run("git -C " + quote(folder) + " rev-parse --absolute-git-dir", "", 15000);
            if (gitDir.code !== 0) throw new Error("cannot make a worktree: " + (gitDir.err.trim().length > 0 ? gitDir.err.trim() : gitDir.out.trim()));
            const exclude = quote(gitDir.out.trim() + "/info/exclude");
            const ignoring = await api.process.run("mkdir -p " + quote(folder + "/.worktrees") + " && mkdir -p " + quote(gitDir.out.trim() + "/info") + " && (grep -qxF .worktrees/ " + exclude + " || printf '%s\\n' .worktrees/ >> " + exclude + ")", "", 15000);
            if (ignoring.code !== 0) throw new Error("cannot ignore .worktrees/: " + (ignoring.err.trim().length > 0 ? ignoring.err.trim() : ignoring.out.trim()));
            const added = await api.process.run("git -C " + quote(folder) + " worktree add -b " + quote(branch) + " " + quote(path), "", 15000);
            if (cancelled) return "The subagent was stopped before it started.";
            if (added.code !== 0) throw new Error("cannot make a worktree: " + (added.err.trim().length > 0 ? added.err.trim() : added.out.trim()));
            for (const setupLine of tasks.worktreeSetup) {
              // In the worktree: process.run runs where widecode was started.
              const command = "cd " + quote(path) + " && env WIDECODE_FOLDER=" + quote(folder) + " WIDECODE_WORKTREE=" + quote(path) + " sh -c " + quote(setupLine);
              const done = await api.process.run(command, "", tasks.worktreeSetupTimeoutMs);
              if (cancelled) return "The subagent was stopped before it started.";
              if (done.code !== 0) {
                await removeWorktree();
                throw new Error("worktree setup failed: " + setupLine + ": " + (done.err.trim().length > 0 ? done.err.trim() : done.out.trim()));
              }
            }
            const status = await api.process.run("git -C " + quote(path) + " status --porcelain", "", 15000);
            const head = await api.process.run("git -C " + quote(path) + " rev-parse HEAD", "", 15000);
            baselineStatus = status.out;
            baselineHead = head.out.trim();
            if (cancelled) return "The subagent was stopped before it started.";
            const started = startRun(path, path + " (branch " + branch + ")", folder, background ? () => {
              void worktreeOver().then((removed) => api.note(removed ? "worktree removed: no changes" : "worktree kept: " + path + " (branch " + branch + ")"));
            } : undefined);
            if (background) return started;
            return started.then(
              (text) => worktreeOver().then((removed) => withLine(text, removed)),
              (e: unknown) => worktreeOver().then((removed) => {
                throw new Error(withLine(e instanceof Error ? e.message : String(e), removed));
              }),
            );
          } finally {
            made();
          }
        };
        return prepared();
      },
    });
    api.tools.add({
      name: "TaskStop",
      description: "Stop a subagent started with Task, by its task_id.",
      input: { type: "object", properties: { task_id: { type: "string", description: "The id Task answered, or the call id." } }, required: ["task_id"] },
      call: (args) => {
        const id = str(args.task_id);
        const run = runs.get(id);
        if (run === undefined) throw new Error("no subagent " + id);
        run.cancel();
        return "stopped " + id;
      },
    });
    api.tools.add({
      name: "SendMessage",
      description: "Send a message to an idle background subagent started with Task, by its task_id.",
      input: { type: "object", properties: { task_id: { type: "string", description: "The id Task answered, or the call id." }, message: { type: "string", description: "What to tell the subagent." } }, required: ["task_id", "message"] },
      call: (args) => {
        const id = str(args.task_id);
        const run = runs.get(id);
        if (run === undefined) throw new Error("no subagent " + id);
        if (!run.working() && working() >= tasks.maxConcurrent) throw new Error("too many subagents run (" + String(tasks.maxConcurrent) + ")");
        const why = run.send(str(args.message));
        if (why.length > 0) throw new Error(why);
        return "sent to " + id;
      },
    });
  },
  deactivate() {
    for (const run of liveRuns.values()) run.stopQuietly("the acp plugin stopped");
    liveRuns.clear();
    if (boxRunner !== null) boxRunner.stop();
    boxRunner = null;
  },
});

export {};
