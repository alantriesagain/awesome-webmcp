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

/** A JSON-RPC message, or any object in one, every field unknown. */
interface Msg {
  [key: string]: unknown;
}

const { obj, str, list, parse } = widecode.util;

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

/** A subagent target: the `subagent_type` Claude names, the agent entry it runs on, its model ("" for the entry's default) and what it is for. */
interface TaskTarget {
  name: string;
  agent: string;
  model: string;
  description: string;
}

/** The `tasks` section: whether Claude's own subagent tools are replaced, the targets, and the bounds. */
interface TasksConfig {
  replace: boolean;
  targets: TaskTarget[];
  maxConcurrent: number;
  timeoutMs: number;
}

const tasksOf = (section: unknown): TasksConfig => {
  const t = obj(obj(section)?.tasks);
  const out: TasksConfig = { replace: t?.replaceClaudeSubagents === true, targets: [], maxConcurrent: 4, timeoutMs: 1800000 };
  const targets = obj(t?.targets);
  if (targets !== null)
    for (const name of Object.keys(targets)) {
      const e = obj(targets[name]);
      if (e === null) continue;
      const agent = str(e.agent).length > 0 ? str(e.agent) : name;
      const model = str(e.model);
      out.targets.push({ name, agent, model, description: str(e.description).length > 0 ? str(e.description) : "Runs on " + (model.length > 0 ? model : agent) });
    }
  if (typeof t?.maxConcurrent === "number" && t.maxConcurrent > 0) out.maxConcurrent = Math.floor(t.maxConcurrent);
  if (typeof t?.timeoutMs === "number" && t.timeoutMs >= 1000) out.timeoutMs = Math.floor(t.timeoutMs);
  return out;
};

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

const acpAgent = (api: widecode.Api, id: string, entry: Entry): widecode.AgentAdapter => {
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
    if (diffs.length === 1 && (diffs[0].oldText === null || diffs[0].oldText === undefined)) facts.written = str(diffs[0].newText);
    else if (kind === "edit" && input !== null && typeof input.content === "string") facts.written = input.content;
    const name = tool !== null ? (OWN_NAME[tool.category] ?? tool.name) : skill.length > 0 ? "Skill" : (NAME[kind] ?? "Tool");
    if (isNew) emit({ type: "block", key: callId, kind: "tool", id: callId, name, text: "", ...facts });
    else emit({ type: "facts", id: callId, ...facts });
    if (u.rawInput !== undefined) emit({ type: "input", key: callId, input: u.rawInput, ...(subagent ? { name: "Agent" } : todos.length > 0 ? { name: "Todo" } : {}) });
    const status = str(u.status);
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
    emit({ type: "result", id: callId, text: outputOf(content, u.rawOutput), error: status === "failed", ...(patch.length > 0 ? { patch } : {}) });
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
  private readonly folder: string;
  private readonly model: string;
  private readonly callId: string;
  private readonly description: string;
  private readonly onDone: () => void;
  private proc: widecode.ProcessHandle | null = null;
  private seq = 0;
  private waiting: Waiter[] = [];
  private session = "";
  private modelConfig = "";
  private open = "";
  private openKind = "";
  private blocks = 0;
  private calls = new Map<string, string>();
  private out: unknown[] = [];
  private reply = "";
  private ended = false;
  private done = false;
  private resolve: (text: string) => void = () => {};
  private reject: (error: Error) => void = () => {};
  readonly promise: Promise<string>;

  constructor(api: widecode.Api, entry: Entry, target: TaskTarget, folder: string, model: string, callId: string, description: string, onDone: () => void) {
    this.api = api;
    this.entry = entry;
    this.target = target;
    this.folder = folder;
    this.model = model;
    this.callId = callId;
    this.description = description;
    this.onDone = onDone;
    this.promise = new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  private flush(): void {
    if (this.out.length === 0) return;
    const batch = this.out;
    this.out = [];
    this.api.conversation.subagent(this.callId, batch as widecode.ConversationEvent[]);
  }

  private emit(e: Ev): void {
    this.out.push(e);
  }

  /** A key or call id of this run, so a subagent's ids cannot collide with the main conversation's. */
  private key(id: string): string {
    return "task:" + this.callId + ":" + id;
  }

  start(prompt: string): Promise<string> {
    this.emit({ type: "facts", id: this.callId, category: "agent", summary: this.target.name + ": " + this.description, agentType: this.target.name, agentTask: this.description, agentPrompt: prompt });
    this.emit({ type: "task", id: this.callId, taskId: this.callId, description: this.description, agentType: this.target.name, background: false });
    this.flush();
    const words = resolved(this.api, this.entry.command);
    const p = this.api.process.spawn(words, { cwd: this.folder }, {
      lines: (lines) => {
        for (const l of lines) this.line(l);
      },
      exit: (code) => this.exited(code),
      error: (text) => this.api.note(this.entry.name + ": " + text.trimEnd()),
    });
    if (!p.started) {
      this.finish("cannot start " + words.join(" "), true);
      return this.promise;
    }
    this.proc = p;
    this.rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "widecode", version: String(widecode.version) } }, (_result, error) => {
      if (error.length > 0) {
        this.finish(error, true);
        return;
      }
      this.newSession(prompt);
    });
    return this.promise;
  }

  /** The agent cancelled the call: its session stops, the call closes with what it had. */
  cancel(): void {
    if (this.done) return;
    this.ended = true;
    this.proc?.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } }));
    this.proc?.stop(1000);
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: "stopped", summary: "stopped" });
    this.flush();
    this.done = true;
    this.onDone();
    this.resolve(this.reply.length > 0 ? this.reply : "The subagent was stopped.");
  }

  timeout(): void {
    if (this.done) return;
    this.finish("The subagent took too long.", true);
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
    this.rpc("session/new", { cwd: this.folder, mcpServers: [] }, (result, error) => {
      if (result === null) {
        this.finish(error.length > 0 ? error : "no session", true);
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
      if (error.length > 0) this.finish(error, true);
      else this.prompt(prompt);
    };
    if (this.modelConfig.length > 0) this.rpc("session/set_config_option", { sessionId: this.session, configId: this.modelConfig, value: this.model }, then);
    else this.rpc("session/set_model", { sessionId: this.session, modelId: this.model }, then);
  }

  private prompt(text: string): void {
    this.rpc("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text }] }, (result, error) => {
      if (error.length > 0) {
        this.finish(error, true);
        return;
      }
      const stop = str(obj(result)?.stopReason);
      this.finish(this.reply.length > 0 ? this.reply : stop.length > 0 ? "The subagent stopped: " + stop : "The subagent said nothing.", stop === "refusal" || stop === "error");
    });
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
    const params = obj(m.params);
    if (params === null) return;
    if (method === "session/update") this.update(obj(params.update));
    else if (method === "session/request_permission") this.permission(m, params);
  }

  private update(u: Msg | null): void {
    if (u === null) return;
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
    if (u.rawInput !== undefined) this.emit({ type: "input", key, input: u.rawInput });
    const status = str(u.status);
    if (status !== "completed" && status !== "failed") return;
    this.emit({ type: "result", id: key, text: this.output(u), error: status === "failed" });
    this.emit({ type: "finish", key });
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
    this.api.conversation
      .ask({ category: "question", name: "Task", questions: [{ question, header: "Permission", options: options.map((o) => ({ label: o.label, description: o.detail })) }] }, this.callId)
      .then((reply) => {
        const label = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.length > 0 ? reply.answers[0].labels[0] : "";
        const chosen = options.find((o) => o.label === label);
        const answer: unknown = chosen !== undefined ? { outcome: { outcome: "selected", optionId: chosen.id } } : { outcome: { outcome: "cancelled" } };
        if (this.proc !== null) this.proc.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }));
      });
  }

  private exited(code: number): void {
    this.proc = null;
    if (this.done) return;
    if (!this.ended) this.finish(this.entry.name + " ended (exit code " + String(code) + ")", true);
  }

  private finish(text: string, error: boolean): void {
    if (this.done) return;
    this.done = true;
    this.emit({ type: "taskUpdate", id: this.callId, taskId: this.callId, status: error ? "failed" : "done", summary: error ? text.split("\n")[0] : this.description });
    this.flush();
    this.onDone();
    if (this.proc !== null) this.proc.stop(500);
    if (error) this.reject(new Error(text));
    else this.resolve(text);
  }
}

widecode.plugin({
  id: "acp",
  defaults: () => ({ agents: DEFAULT_AGENTS }),
  activate(api) {
    const section = api.settings.section();
    const agents = agentsOf(section);
    const tasks = tasksOf(section);
    for (const id of Object.keys(agents)) api.agents.register(acpAgent(api, id, agents[id]));
    // Sessions made and left by widecode processes gone (one quit without writing to its session).
    sweep(api, agents, "");
    if (tasks.targets.length === 0) return;
    /** The runs under way, so the limit is kept. */
    let running = 0;
    const names = tasks.targets.map((t) => t.name);
    api.tools.add({
      name: "Task",
      description: "Run a subagent in another agent and model, in this folder. Targets: " + tasks.targets.map((t) => t.name + " (" + t.agent + (t.model.length > 0 ? " " + t.model : "") + ")").join(", ") + ". The subagent is not Claude: it runs on the target's model, its steps show under the call, and its final answer is the result.",
      category: "agent",
      except: ["acp"],
      input: { type: "object", properties: { description: { type: "string", description: "A short label for the call." }, prompt: { type: "string", description: "The whole task for the subagent." }, subagent_type: { type: "string", enum: names, description: "Which target to run." }, model: { type: "string", description: "A model for this call, overriding the target's." }, cwd: { type: "string", description: "The folder; the session's folder when left out." }, name: { type: "string", description: "A display name." } }, required: ["description", "prompt"] },
      call: (args, ctx) => {
        const wanted = str(args.subagent_type).length > 0 ? str(args.subagent_type) : names[0] ?? "";
        const target = tasks.targets.find((t) => t.name === wanted);
        if (target === undefined) throw new Error("no subagent type " + wanted + "; it has " + names.join(", "));
        const entry = agents[target.agent];
        if (entry === undefined) throw new Error("no agent " + target.agent + " for " + wanted);
        const prompt = str(args.prompt);
        if (prompt.length === 0) throw new Error("a subagent needs a prompt");
        const folder = api.state.active().folder;
        const cwd = str(args.cwd);
        if (cwd.length > 0 && cwd !== folder) throw new Error("a subagent runs in " + folder + ", not " + cwd);
        if (ctx.toolUseId.length === 0) throw new Error("the agent did not name this call");
        if (running >= tasks.maxConcurrent) throw new Error("too many subagents run (" + String(tasks.maxConcurrent) + ")");
        running++;
        const run = new SubagentRun(api, entry, target, folder, str(args.model).length > 0 ? str(args.model) : target.model, ctx.toolUseId, str(args.description).length > 0 ? str(args.description) : str(args.name), () => {
          running--;
        });
        ctx.onCancel(() => run.cancel());
        api.after(tasks.timeoutMs, () => run.timeout());
        return run.start(prompt);
      },
    });
  },
});

export {};
