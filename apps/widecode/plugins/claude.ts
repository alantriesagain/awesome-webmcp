// Claude Code as widecode's agent: its CLI (`claude -p` over stream-json) started on the first
// message, what it writes read into the conversation as events, what the user does written to it.
// Its records (live, and a session's transcript under ~/.claude/projects read on resume) are read
// here: a message's content blocks keyed by message and index (or a call's id), stream events
// previewing them, a call's facts from Claude's tools table, a subagent's records under its call,
// questions and plans for the request panel, and the status Claude Code's status line gets. A
// permission prompt the user need not see is allowed at once; one about a path outside the
// session's folders offers the folder, for the session or from now on. The Sessions tab lists the
// folder's transcripts, titled by Claude Code's own records. Its section of config.json: { "id":
// "claude", "projects": "" } (the id it is chosen by; where Claude Code keeps sessions, "" for
// $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects).

type Ev = widecode.ConversationEvent;

/** Any record or nested object, every field `unknown`. */
interface Rec {
  [key: string]: unknown;
}

const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const { str, num, list } = widecode.util;

/** A random version 4 UUID (QuickJS has no crypto; Math.random is enough for a message's id). */
const uuidV4 = (): string => {
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return hex(8) + "-" + hex(4) + "-4" + hex(3) + "-" + "89ab"[Math.floor(Math.random() * 4)] + hex(3) + "-" + hex(12);
};
const { parse } = widecode.util;

/** The window of a transcript a resume reads, and each "load earlier" before it. */
const HISTORY_BYTES = 4 * 1024 * 1024;
/** Lines kept of the live stream and of the loaded history; the model is rebuilt from them. */
const LIVE_MAX = 8000;
const HISTORY_MAX = 40000;
/** A process's /proc stat fields from the third (its state) on, past its name, which may hold spaces: [1] the parent's pid, [19] when it started. */
const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(")") + 2).split(" ");
/** Records never shown nor linked: left out of history windows. */
const SKIP_RECORDS = ['{"type":"file-history-snapshot"', '{"type":"file-history-delta"', '{"type":"queue-operation"', '{"type":"atis-latch"', '{"type":"last-prompt"', '{"type":"mode"'];

// The tools table: what kind of call a tool makes, its one line, the files it touches, a command
// whole, a new file's content, a todo list, a subagent's kind, task and prompt.

const CATEGORIES: string[][] = [
  ["run", "Bash", "BashOutput", "KillShell"],
  ["read", "Read", "NotebookRead", "LS"],
  ["search", "Grep", "Glob", "ToolSearch"],
  ["edit", "Edit", "MultiEdit", "Write", "NotebookEdit"],
  ["fetch", "WebFetch", "WebSearch"],
  ["agent", "Agent", "Task"],
  ["todo", "TodoWrite"],
  ["question", "AskUserQuestion"],
  ["plan", "ExitPlanMode"],
];
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const categoryOf = (name: string): string => {
  for (const row of CATEGORIES) if (row.indexOf(name) > 0) return row[0];
  return "other";
};

const firstLine = (text: string): string => {
  const cut = text.indexOf("\n");
  return cut >= 0 ? text.slice(0, cut) + " …" : text;
};

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

/** A call as this plugin knows it: its tool, input (whole, or streamed so far), result's diff. */
interface Call {
  name: string;
  input: unknown;
  partial: string;
  hasResult: boolean;
  patch: { oldStart: number; newStart: number; lines: string[] }[];
  paths: string[];
}

/** An Edit's +/- counts from what its result changed, else from its strings. */
const editCounts = (call: Call, input: Rec): string => {
  let add = 0;
  let del = 0;
  if (call.patch.length > 0)
    for (const hunk of call.patch)
      for (const s of hunk.lines) {
        if (s.startsWith("+")) add++;
        else if (s.startsWith("-")) del++;
      }
  else {
    add = countLines(str(input.new_string));
    del = countLines(str(input.old_string));
  }
  return "+" + String(add) + " -" + String(del);
};

/** The call's facts from its tool, input and result; paths in its line relative to `folder`. */
const describe = (call: Call, folder: string): widecode.CallFacts => {
  const relative = (path: string): string => (folder.length > 0 && path.startsWith(folder + "/") ? path.slice(folder.length + 1) : path);
  const name = call.name;
  const category = categoryOf(name);
  const input = rec(call.input);
  if (input === null) return { category, summary: "" };
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const shown = relative(path);
  let summary = "";
  if (name === "Bash") summary = firstLine(str(input.command));
  else if (name === "Read") summary = shown + (num(input.offset) > 0 ? " from line " + String(num(input.offset)) : "");
  else if (name === "Edit" || name === "MultiEdit") summary = shown + (call.hasResult || str(input.new_string).length > 0 ? "  " + editCounts(call, input) : "");
  else if (name === "Write") summary = shown + "  " + String(countLines(str(input.content))) + " lines";
  else if (name === "NotebookEdit") summary = shown;
  else if (name === "Grep") summary = str(input.pattern) + (shown.length > 0 ? " in " + shown : "");
  else if (name === "Glob") summary = str(input.pattern);
  else if (name === "WebFetch") summary = str(input.url);
  else if (name === "WebSearch") summary = str(input.query);
  else if (name === "Agent" || name === "Task") summary = (str(input.subagent_type).length > 0 ? str(input.subagent_type) + ": " : "") + str(input.description);
  else if (name === "TodoWrite") summary = String(list(input.todos).length) + " todos";
  else if (name === "ToolSearch") summary = str(input.query);
  else if (name === "AskUserQuestion") {
    const first = rec(list(input.questions)[0]);
    summary = first !== null ? str(first.question) : "";
  } else if (name === "Skill") summary = str(input.skill);
  else
    for (const key of ["description", "query", "prompt", "command", "url", "file_path"]) {
      const v = input[key];
      if (typeof v === "string" && v.length > 0) {
        summary = firstLine(v);
        break;
      }
    }
  const todos: { text: string; state: "done" | "doing" | "todo" }[] = [];
  if (name === "TodoWrite")
    for (const t of list(input.todos)) {
      const todo = rec(t);
      if (todo === null) continue;
      const status = str(todo.status);
      todos.push({ text: str(todo.content), state: status === "completed" ? "done" : status === "in_progress" ? "doing" : "todo" });
    }
  const facts: widecode.CallFacts = {
    category,
    summary,
    paths: path.length > 0 ? [path] : [],
    command: name === "Bash" ? str(input.command) : "",
    written: name === "Write" ? str(input.content) : "",
    todos,
  };
  if (category === "agent") {
    facts.agentType = str(input.subagent_type);
    facts.agentTask = str(input.description);
    facts.agentPrompt = str(input.prompt);
  }
  return facts;
};

// Requests: AskUserQuestion's questions, and the replies Claude Code expects (PROTOCOL.md).

const questionsOf = (value: unknown): { question: string; header: string; multi: boolean; options: { label: string; description: string }[] }[] => {
  const input = rec(value);
  if (input === null) return [];
  return list(input.questions)
    .map(rec)
    .filter((q): q is Rec => q !== null)
    .map((q) => ({
      question: str(q.question),
      header: str(q.header),
      multi: q.multiSelect === true,
      options: list(q.options)
        .map(rec)
        .filter((o): o is Rec => o !== null)
        .map((o) => ({ label: str(o.label), description: str(o.description) })),
    }));
};

/** The input as JSON text, `{}` when it is not an object. */
const inputJson = (input: unknown): string => {
  if (rec(input) === null) return "{}";
  const text = JSON.stringify(input);
  return text.startsWith("{") ? text : "{}";
};

/** The user's reply to a question or plan with `input`, as the response object's JSON text. */
const replyJson = (input: unknown, reply: widecode.AgentReply): string => {
  if (reply.state === "approved") return '{"behavior":"allow","updatedInput":' + inputJson(input) + ',"updatedPermissions":[{"type":"setMode","mode":"bypassPermissions","destination":"session"}]}';
  if (reply.state !== "answered") return '{"behavior":"deny","message":' + JSON.stringify(reply.message) + "}";
  let a = "";
  for (const ans of reply.answers) {
    const multi = ans.labels.length > 1 || (questionsOf(input).find((q) => q.question === ans.question)?.multi ?? false);
    const value = ans.text.length > 0 ? JSON.stringify(ans.text) : multi ? JSON.stringify(ans.labels) : JSON.stringify(ans.labels.length > 0 ? ans.labels[0] : "");
    a += (a.length > 0 ? "," : "") + JSON.stringify(ans.question) + ":" + value;
  }
  const base = inputJson(input);
  const inner = base.slice(1, base.length - 1).trim();
  return '{"behavior":"allow","updatedInput":{' + inner + (inner.length > 0 ? "," : "") + '"answers":{' + a + "}}}";
};

/** An init record's tools (the CLI's own, and each MCP server's, named mcp__<server>__<tool> with what in the server's name is not a letter, digit, _ or - made _) and its MCP servers. */
const toolsOf = (r: Rec): Ev => {
  const servers = list(r.mcp_servers)
    .map(rec)
    .filter((x): x is Rec => x !== null && str(x.name).length > 0)
    .map((x) => ({ name: str(x.name), status: str(x.status) }));
  const named = new Map(servers.map((x) => [x.name.replace(/[^A-Za-z0-9_-]/g, "_"), x.name]));
  const tools = list(r.tools)
    .filter((t): t is string => typeof t === "string")
    .map((name) => {
      const at = name.startsWith("mcp__") ? name.indexOf("__", 5) : -1;
      if (at < 0) return { name, server: "" };
      const key = name.slice(5, at);
      return { name: name.slice(at + 2), server: named.get(key) ?? key, id: name };
    });
  return { type: "tools", tools, servers };
};

// A transcript's active branch: from the leaf (the last message record) back through each record's
// parent (`parentUuid`, a compact boundary's `logicalParentUuid`); records off it were rewound.
// Over a window the walk may stop at a parent the window does not hold.

const CHAINED = ["user", "assistant", "system", "attachment"];

/** The active branch's records, parsed, oldest first. */
const activeChain = (lines: string[]): Rec[] => {
  const byUuid = new Map<string, { parent: string; r: Rec }>();
  let leaf = "";
  for (const line of lines) {
    const r = rec(parse(line));
    if (r === null) continue;
    const uuid = str(r.uuid);
    if (uuid.length === 0) continue;
    byUuid.set(uuid, { parent: str(r.parentUuid) || str(r.logicalParentUuid), r });
    if (CHAINED.includes(str(r.type)) && r.isSidechain !== true) leaf = uuid;
  }
  const seen = new Set<string>();
  const reversed: Rec[] = [];
  let at = byUuid.get(leaf);
  let uuid = leaf;
  while (at !== undefined && !seen.has(uuid)) {
    seen.add(uuid);
    reversed.push(at.r);
    uuid = at.parent;
    at = uuid.length > 0 ? byUuid.get(uuid) : undefined;
  }
  return reversed.reverse();
};

// The folder's sessions: `<projects>/<folder, every non-alphanumeric as '-'>/<id>.jsonl`, a head
// read for the first prompt and the folder it ran in, a tail for Claude Code's title; cached by
// size and time. Subagents are `<id>/subagents/agent-*.jsonl` with a `.meta.json` each.

const HEAD_BYTES = 64 * 1024;
const TAIL_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024];
const TEXT_MAX = 300;
const NOT_PROMPTS = ["<command-name>", "<command-message>", "<local-command", "<system-reminder>", "Caveat:"];
const TITLE_PREFIXES = ['{"type":"custom-title"', '{"type":"ai-title"', '{"type":"agent-name"', '{"type":"last-prompt"', '{"type":"summary"'];

const safeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,100}$/.test(id);
const clipText = (text: string): string => {
  const t = text.trim();
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + "…" : t;
};

/** The user's own words in a message's content, "" for an echo of a command or a caveat. */
const promptText = (content: unknown): string => {
  let text = "";
  if (typeof content === "string") text = content;
  else
    for (const b of list(content)) {
      const block = rec(b);
      if (block !== null && block.type === "text" && typeof block.text === "string") text += (text.length > 0 ? " " : "") + block.text;
    }
  const t = text.trim();
  for (const p of NOT_PROMPTS) if (t.startsWith(p)) return "";
  return t;
};

interface Listed {
  id: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  cwd: string;
  model: string;
  mtimeMs: number;
  size: number;
}

const summarize = (api: widecode.Api, path: string, id: string, size: number, mtimeMs: number): Listed => {
  const s: Listed = { id, title: "", firstPrompt: "", lastPrompt: "", cwd: "", model: "", mtimeMs, size };
  const head = api.fs.read(path, 0, Math.min(size, HEAD_BYTES)).split("\n");
  if (size > HEAD_BYTES) head.pop();
  for (const line of head) {
    if (line.length === 0 || line.startsWith('{"type":')) continue;
    const r = rec(parse(line));
    if (r === null) continue;
    if (s.cwd.length === 0 && typeof r.cwd === "string") s.cwd = r.cwd;
    if (r.type !== "user" || r.isMeta === true || r.isCompactSummary === true) continue;
    const text = promptText(rec(r.message)?.content);
    if (text.length === 0) continue;
    s.firstPrompt = clipText(text);
    break;
  }
  let custom = "";
  let ai = "";
  let summary = "";
  for (const step of TAIL_STEPS) {
    const length = Math.min(size, step);
    const lines = api.fs.read(path, size - length, length).split("\n");
    if (length < size) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (s.model.length === 0 && lines[i].includes('"type":"assistant"')) {
        const m = rec(rec(parse(lines[i]))?.message)?.model;
        if (typeof m === "string") s.model = m;
      }
      if (!TITLE_PREFIXES.some((p) => lines[i].startsWith(p))) continue;
      const r = rec(parse(lines[i]));
      if (r === null) continue;
      if (custom.length === 0 && typeof r.customTitle === "string") custom = r.customTitle;
      if (ai.length === 0 && typeof r.aiTitle === "string") ai = r.aiTitle;
      if (summary.length === 0 && typeof r.summary === "string") summary = r.summary;
      if (s.lastPrompt.length === 0 && typeof r.lastPrompt === "string") s.lastPrompt = clipText(r.lastPrompt);
    }
    if (custom.length > 0 || ai.length > 0 || length === size) break;
  }
  s.title = clipText(custom.length > 0 ? custom : ai.length > 0 ? ai : summary);
  return s;
};

// The status Claude Code's status line gets (widecode.StatusFields): the context of the latest
// main-thread request over the window a result reports, the cache's requests, misses and warmth,
// the rate limits, cost, tokens, lines changed.

class Status {
  f: Partial<widecode.StatusFields> = {};
  /** Rate limits seen (else the ones kept from the last run stand). */
  limits = false;
  private messages = new Set<string>();

  private add(key: keyof widecode.StatusFields, n: number): void {
    (this.f as Record<string, number>)[key] = ((this.f[key] as number | undefined) ?? 0) + n;
  }

  apply(r: Rec, when: number): void {
    const f = this.f;
    if (when > 0 && (f.startMs ?? 0) === 0) f.startMs = when;
    const type = str(r.type);
    if (type === "system") {
      const sub = str(r.subtype);
      if (sub === "init") {
        if (str(r.session_id).length > 0) f.sessionId = str(r.session_id);
        if (str(r.model).length > 0) f.modelId = str(r.model);
        if (str(r.cwd).length > 0) f.cwd = str(r.cwd);
        if (typeof r.claude_code_version === "string") f.version = r.claude_code_version;
      }
      if ((sub === "init" || sub === "status") && str(r.permissionMode).length > 0) f.mode = str(r.permissionMode);
      if (sub === "compact_boundary") {
        // A compaction leaves the context at its summary's size until the next reply says otherwise.
        const meta = rec(r.compact_metadata !== undefined ? r.compact_metadata : r.compactMetadata);
        const post = meta === null ? -1 : typeof meta.post_tokens === "number" ? meta.post_tokens : typeof meta.postTokens === "number" ? meta.postTokens : -1;
        if (post >= 0) {
          f.contextInput = post;
          f.contextCacheRead = 0;
          f.contextCacheWrite = 0;
        }
      }
    } else if (type === "assistant") {
      const msg = rec(r.message);
      if (msg === null) return;
      // The model the main thread runs on: a transcript names it without the "[1m]" an init carries.
      const model = str(msg.model);
      if (model.length > 0 && !model.startsWith("<") && str(r.parent_tool_use_id).length === 0 && model !== (f.modelId ?? "").replace("[1m]", "")) f.modelId = model;
      const id = str(msg.id);
      if (id.length === 0 || this.messages.has(id)) return;
      this.messages.add(id);
      const usage = rec(msg.usage);
      if (usage === null) return;
      const input = num(usage.input_tokens);
      const read = num(usage.cache_read_input_tokens);
      const write = num(usage.cache_creation_input_tokens);
      this.add("totalInput", input + read + write);
      this.add("totalOutput", num(usage.output_tokens));
      this.add("thinking", num(rec(usage.output_tokens_details)?.thinking_tokens));
      // The context and the cache follow the main conversation: a subagent starts a context of its own.
      if (str(r.parent_tool_use_id).length > 0) return;
      this.add("requests", 1);
      if ((f.requests ?? 0) > 1 && read === 0) this.add("misses", 1);
      this.add("cacheRead", read);
      this.add("allInput", input + read + write);
      const creation = rec(usage.cache_creation);
      if (creation !== null && num(creation.ephemeral_1h_input_tokens) > 0) f.cacheTtlMs = 3600000;
      else if ((f.cacheTtlMs ?? 0) === 0 && (read > 0 || write > 0)) f.cacheTtlMs = 300000;
      if (when > 0) f.lastRequestMs = when;
      f.contextInput = input;
      f.contextCacheRead = read;
      f.contextCacheWrite = write;
      f.contextOutput = num(usage.output_tokens);
    } else if (type === "user") {
      const data = rec(r.tool_use_result !== undefined ? r.tool_use_result : r.toolUseResult);
      if (data === null) return;
      for (const h of list(data.structuredPatch))
        for (const l of list(rec(h)?.lines))
          if (typeof l === "string") {
            if (l.startsWith("+")) this.add("linesAdded", 1);
            else if (l.startsWith("-")) this.add("linesRemoved", 1);
          }
    } else if (type === "result") {
      this.add("thinking", num(rec(rec(r.usage)?.output_tokens_details)?.thinking_tokens));
      this.add("apiMs", num(r.duration_api_ms));
      const models = rec(r.modelUsage);
      if (models === null) return;
      // The window of the model the session runs on; without a match, the largest reported.
      let size = 0;
      for (const key of Object.keys(models)) {
        const window = num(rec(models[key])?.contextWindow);
        if (key === (f.modelId ?? "").replace("[1m]", "")) {
          size = window;
          break;
        }
        if (window > size) size = window;
      }
      if (size > 0) f.contextSize = size;
    } else if (type === "rate_limit_event") {
      const windows = rec(rec(r.rate_limit_info)?.unifiedWindows);
      if (windows === null) return;
      const five = rec(windows.five_hour);
      const week = rec(windows.seven_day);
      if (five !== null) {
        f.fiveHourPct = num(five.utilization) * 100;
        f.fiveHourResets = num(five.resetsAt);
      }
      if (week !== null) {
        f.weekPct = num(week.utilization) * 100;
        f.weekResets = num(week.resetsAt);
      }
      this.limits = true;
    } else if (type === "cost-state") {
      this.add("costUsd", num(r.totalCostUSD));
      if (typeof r.startTime === "number" && ((f.startMs ?? 0) === 0 || r.startTime < (f.startMs ?? 0))) f.startMs = r.startTime;
    }
  }
}

// Claude Code's records as the conversation's events: one reader for the live stream and for a
// transcript's records. Claude's assistant messages arrive one content block per line, live and in
// transcripts, so they are the authority: a block is keyed by its message id and index
// (`apiBlockIndex` in a transcript, the count of that message's lines live) or, a call, by its id.
// Stream events only preview the block they name. A turn opens on the user's prompt (the CLI's
// replay of a message sent to it, or a transcript record), or on Claude's own output when none is
// open (a background task reporting); a `result` closes it.

const COMMAND_PREFIXES = ["<command-name>", "<command-message>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"];
const INTERRUPTED = "[Request interrupted by user";

const between = (text: string, tag: string): string => {
  const open = text.indexOf("<" + tag + ">");
  if (open < 0) return "";
  const from = open + tag.length + 2;
  const close = text.indexOf("</" + tag + ">", from);
  return close < 0 ? "" : text.slice(from, close).trim();
};

/** A background task's end as Claude Code tells Claude (`<task-notification>`): its summary, else its status; "" for the user's words. */
const taskNotice = (text: string): string => {
  if (!text.trimStart().startsWith("<task-notification>")) return "";
  const summary = between(text, "summary");
  if (summary.length > 0) return summary.replace(/\s+/g, " ");
  const status = between(text, "status");
  return "A background task " + (status.length > 0 ? status : "ended");
};

const tagged = (text: string, tag: string): string => {
  const open = text.indexOf("<" + tag + ">");
  const close = text.indexOf("</" + tag + ">");
  return open >= 0 && close > open ? text.slice(open + tag.length + 2, close).trim() : "";
};

/** A message's text and its images: a string, or text and image blocks. */
const contentText = (content: unknown): { text: string; images: number } => {
  if (typeof content === "string") return { text: content, images: 0 };
  let text = "";
  let images = 0;
  for (const b of list(content)) {
    const block = rec(b);
    if (block === null) continue;
    if (block.type === "text") text += (text.length > 0 ? "\n" : "") + str(block.text);
    else if (block.type === "image") images++;
  }
  return { text, images };
};

const kilo = (n: number): string => (n < 1000 ? String(n) : String(Math.round(n / 1000)) + "k");

const kindOf = (type: string): "text" | "thinking" | "tool" => (type === "tool_use" ? "tool" : type === "thinking" || type === "redacted_thinking" ? "thinking" : "text");

class Reader {
  /** The folder a call's paths are shown relative to. */
  folder = "";
  /** The records carry the time they were written (a transcript's): their timestamps time the calls. */
  stamped = false;
  /** The requests open (Claude Code's request id: the tool asked about and its input). */
  readonly requests = new Map<string, { tool: string; input: unknown }>();
  private readonly emit: (e: Ev) => void;
  private readonly readFile: (path: string) => string | null;
  private compacted = false;
  /** What each live message streams: its key prefix and its blocks' keys by index, by parent call. */
  private streams = new Map<string, { msg: string; keys: Map<number, string> }>();
  private lineCounts = new Map<string, number>();
  /** The blocks made (parent and key: their kind, whether done, a call's id), the calls by id. */
  private blocks = new Map<string, { kind: string; done: boolean; id: string }>();
  readonly calls = new Map<string, Call>();
  /** The thinking block streaming now (thinking_tokens records size it). */
  private thinking: { parent: string; key: string } | null = null;
  /** The calls of the turn open, newest last (a plan file is the last one written). */
  private turnCalls: string[] = [];
  /** While a subagent's transcript is read: the call its records go under. */
  private nested = "";
  /** The last record applied was stamped (an unstamped one after it is timed now). */
  private wasStamped = false;
  private ids = 0;

  constructor(emit: (e: Ev) => void, readFile: (path: string) => string | null) {
    this.emit = emit;
    this.readFile = readFile;
  }

  private parentOf(parent: string): string {
    return parent.length === 0 && this.nested.length > 0 ? this.nested : parent;
  }

  /** A turn closed (or another opened): what it was streaming goes with it. */
  private turnChanged(): void {
    this.streams.clear();
    this.thinking = null;
    this.turnCalls = [];
  }

  /** One record: a live line or a transcript record, parsed. */
  apply(value: unknown): void {
    const r = rec(value);
    if (r === null) return;
    if (this.stamped) {
      const stamp = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      this.emit({ type: "at", ms: Number.isNaN(stamp) ? Date.now() : stamp });
      this.wasStamped = true;
    } else if (this.wasStamped) {
      this.emit({ type: "at", ms: Date.now() });
      this.wasStamped = false;
    }
    const type = str(r.type);
    if (type === "stream_event") this.stream(r);
    else if (type === "assistant") this.assistant(r);
    else if (type === "user") this.user(r);
    else if (type === "system") this.system(r);
    else if (type === "result") this.result(r);
    else if (type === "attachment") this.attachment(r);
    else if (type === "control_request") this.controlRequest(r);
    else if (type === "control_cancel_request") this.emit({ type: "cancelRequest", id: str(r.request_id) });
  }

  /** The block a content block names, made when it is new. */
  private block(parent: string, key: string, cb: Rec): { kind: string; done: boolean; id: string } {
    const at = parent + "\u0000" + key;
    const found = this.blocks.get(at);
    if (found !== undefined) return found;
    const kind = kindOf(str(cb.type));
    const b = { kind, done: false, id: kind === "tool" ? str(cb.id) : key };
    this.blocks.set(at, b);
    if (kind === "tool") {
      const call: Call = { name: str(cb.name), input: null, partial: "", hasResult: false, patch: [], paths: [] };
      this.calls.set(b.id, call);
      this.turnCalls.push(b.id);
      this.emit({ type: "block", parent, key, kind, id: b.id, name: call.name, text: "", ...describe(call, this.folder) });
    } else this.emit({ type: "block", parent, key, kind, text: kind === "thinking" ? str(cb.thinking) : str(cb.text) });
    return b;
  }

  /** A block is complete; a call's facts are read from its whole input. */
  private finish(parent: string, key: string, b: { kind: string; done: boolean; id: string }): void {
    if (!b.done) {
      b.done = true;
      this.emit({ type: "finish", parent, key });
    }
    if (b.kind !== "tool") return;
    const call = this.calls.get(b.id);
    if (call === undefined) return;
    if (call.input === null) call.input = call.partial.length > 0 ? parse(call.partial) : null;
    this.facts(b.id, call);
  }

  private facts(id: string, call: Call): void {
    const facts = describe(call, this.folder);
    call.paths = facts.paths ?? call.paths;
    this.emit({ type: "facts", id, ...facts });
  }

  private stream(r: Rec): void {
    const e = rec(r.event);
    if (e === null) return;
    const raw = str(r.parent_tool_use_id);
    const type = str(e.type);
    if (type === "message_start") {
      const id = str(rec(e.message)?.id);
      this.streams.set(raw, { msg: id.length > 0 ? id : "pm" + String(++this.ids), keys: new Map() });
      return;
    }
    const s = this.streams.get(raw);
    if (s === undefined) return;
    const index = num(e.index);
    const parent = this.parentOf(raw);
    if (type === "content_block_start") {
      const cb = rec(e.content_block);
      if (cb === null) return;
      const key = str(cb.type) === "tool_use" ? str(cb.id) : s.msg + ":" + String(index);
      s.keys.set(index, key);
      const b = this.block(parent, key, cb);
      if (b.kind === "thinking" && raw.length === 0) this.thinking = { parent, key };
      return;
    }
    const key = s.keys.get(index);
    if (key === undefined) return;
    const b = this.blocks.get(parent + "\u0000" + key);
    if (b === undefined) return;
    if (type === "content_block_delta") {
      const d = rec(e.delta);
      if (d === null) return;
      const dt = str(d.type);
      if (dt === "text_delta" && b.kind === "text") this.emit({ type: "text", parent, key, delta: str(d.text) });
      else if (dt === "thinking_delta" && b.kind === "thinking") this.emit({ type: "text", parent, key, delta: str(d.thinking) });
      else if (dt === "input_json_delta" && b.kind === "tool") {
        const call = this.calls.get(b.id);
        if (call !== undefined) call.partial += str(d.partial_json);
        this.emit({ type: "partial", parent, key, json: str(d.partial_json) });
      }
    } else if (type === "content_block_stop") {
      if (b.done) return;
      if (this.thinking !== null && this.thinking.parent === parent && this.thinking.key === key) this.thinking = null;
      this.finish(parent, key, b);
    }
  }

  private assistant(r: Rec): void {
    const m = rec(r.message);
    if (m === null) return;
    let id = str(m.id);
    if (id.length === 0) id = "pm" + String(++this.ids);
    const seen = this.lineCounts.get(id) ?? 0;
    this.lineCounts.set(id, seen + 1);
    const parent = this.parentOf(str(r.parent_tool_use_id));
    const blocks = list(m.content);
    const base = typeof r.apiBlockIndex === "number" ? r.apiBlockIndex : seen;
    for (let i = 0; i < blocks.length; i++) {
      const cb = rec(blocks[i]);
      if (cb === null) continue;
      const type = str(cb.type);
      const key = type === "tool_use" ? str(cb.id) : id + ":" + String(base + i);
      const b = this.block(parent, key, cb);
      if (b.kind === "text" && type === "text") this.emit({ type: "text", parent, key, text: str(cb.text) });
      else if (b.kind === "thinking" && str(cb.thinking).length > 0) this.emit({ type: "text", parent, key, text: str(cb.thinking) });
      else if (b.kind === "tool" && type === "tool_use") {
        const call = this.calls.get(b.id);
        if (call !== undefined) {
          if (cb.input !== undefined) call.input = cb.input;
          if (str(cb.name).length > 0) call.name = str(cb.name);
        }
        if (cb.input !== undefined) this.emit({ type: "input", parent, key, input: cb.input, ...(str(cb.name).length > 0 ? { name: str(cb.name) } : {}) });
        else if (str(cb.name).length > 0) this.emit({ type: "input", parent, key, input: call?.input ?? null, name: str(cb.name) });
      }
      if (this.thinking !== null && this.thinking.parent === parent && this.thinking.key === key) this.thinking = null;
      this.finish(parent, key, b);
    }
  }

  private user(r: Rec): void {
    const m = rec(r.message);
    const content = m !== null ? m.content : null;
    const raw = str(r.parent_tool_use_id);
    let results = 0;
    for (const v of list(content)) {
      const block = rec(v);
      if (block === null || block.type !== "tool_result") continue;
      results++;
      const id = str(block.tool_use_id);
      const call = this.calls.get(id);
      if (call === undefined) continue;
      const got = contentText(block.content);
      const isError = block.is_error === true;
      const data = rec(r.tool_use_result !== undefined ? r.tool_use_result : r.toolUseResult);
      const patch: { oldStart: number; newStart: number; lines: string[] }[] = [];
      if (data !== null && data.structuredPatch !== undefined)
        for (const h of list(data.structuredPatch)) {
          const hunk = rec(h);
          if (hunk !== null) patch.push({ oldStart: num(hunk.oldStart), newStart: num(hunk.newStart), lines: list(hunk.lines).filter((l): l is string => typeof l === "string") });
        }
      call.hasResult = true;
      call.patch = patch;
      this.emit({ type: "result", id, text: got.text, images: got.images, error: isError, ...(data !== null && data.structuredPatch !== undefined ? { patch } : {}) });
      this.facts(id, call);
      if (isError || !EDIT_TOOLS.includes(call.name)) continue;
      const input = rec(call.input);
      const path = input !== null ? str(input.file_path) || str(input.notebook_path) : "";
      if (path.length > 0) this.emit({ type: "edited", path });
    }
    if (results > 0 || r.isMeta === true) return;
    const got = contentText(content);
    const here = this.parentOf("");
    // The summary a compaction leaves: flagged in a transcript, synthetic in the live stream after the boundary.
    if (r.isCompactSummary === true || (this.compacted && r.isSynthetic === true)) {
      this.emit({ type: "notice", text: "Summary of the earlier conversation", tone: "info", detail: got.text, parent: here });
      return;
    }
    if (raw.length > 0 || this.nested.length > 0) {
      this.emit({ type: "prompt", parent: this.parentOf(raw), text: got.text, images: got.images });
      return;
    }
    if (got.text.startsWith(INTERRUPTED)) {
      this.emit({ type: "notice", text: "Interrupted", tone: "info", once: true });
      return;
    }
    for (const prefix of COMMAND_PREFIXES)
      if (got.text.startsWith(prefix)) {
        const name = tagged(got.text, "command-name");
        const args = tagged(got.text, "command-args");
        const out = tagged(got.text, "local-command-stdout") + tagged(got.text, "local-command-stderr");
        // /compact's own "Compacted" says what the boundary's notice already said (and its message left the queue when compacting began).
        const compacted = this.compacted && out.trim() === "Compacted";
        if (name.length > 0) this.emit({ type: "notice", text: name + (args.length > 0 ? " " + args : ""), tone: "command" });
        else if (out.length > 0 && !compacted) this.emit({ type: "notice", text: out, tone: "command" });
        // A command Claude Code ran itself answers the oldest queued command.
        if (r.isReplay === true && !compacted) this.emit({ type: "takeCommand" });
        return;
      }
    // A background task's notification is Claude Code's own prompt, never a message the user queued.
    const notice = taskNotice(got.text);
    if (r.isReplay === true && notice.length === 0)
      this.emit({
        type: "take",
        text: got.text,
        parts: list(content)
          .map(rec)
          .filter((b): b is Rec => b !== null && b.type === "text")
          .map((b) => str(b.text)),
      });
    this.emit({ type: "turn", text: notice.length > 0 ? notice : got.text, images: got.images, ...(notice.length > 0 ? { notice: true } : {}) });
    this.turnChanged();
  }

  private system(r: Rec): void {
    const sub = str(r.subtype);
    if (sub === "init") {
      // Paths are shown relative to the folder the session runs in.
      if (this.folder.length === 0) this.folder = str(r.cwd);
      const commands = list(r.slash_commands).filter((c): c is string => typeof c === "string");
      this.emit({ type: "session", id: str(r.session_id), model: str(r.model), mode: str(r.permissionMode), cwd: str(r.cwd), ...(commands.length > 0 ? { commands } : {}) });
      if (Array.isArray(r.tools)) this.emit(toolsOf(r));
    } else if (sub === "status") {
      if (str(r.permissionMode).length > 0) this.emit({ type: "mode", mode: str(r.permissionMode) });
      this.emit({ type: "status", status: str(r.status) });
      // A compaction answers the message waiting (/compact, or one that filled the context): shown as sent, not queued.
      if (str(r.status) === "compacting") this.emit({ type: "startQueued" });
    } else if (sub === "thinking_tokens") {
      const t = this.thinking;
      if (t !== null) this.emit({ type: "thinkingTokens", parent: t.parent, key: t.key, tokens: num(r.estimated_tokens) });
    } else if (sub === "compact_boundary") {
      const meta = rec(r.compact_metadata !== undefined ? r.compact_metadata : r.compactMetadata);
      const pre = meta !== null ? num(meta.pre_tokens) + num(meta.preTokens) : 0;
      const post = meta !== null ? num(meta.post_tokens) + num(meta.postTokens) : 0;
      const auto = meta !== null && meta.trigger === "auto";
      this.emit({ type: "notice", text: "Conversation compacted" + (auto ? " automatically" : "") + (pre > 0 ? " · " + kilo(pre) + " → " + kilo(post) + " tokens" : ""), tone: "info", parent: this.parentOf("") });
      this.compacted = true;
    } else if (sub === "local_command") {
      const text = str(r.content);
      const name = tagged(text, "command-name");
      const out = tagged(text, "local-command-stdout");
      if (name.length > 0 || out.length > 0) this.emit({ type: "notice", text: name.length > 0 ? name : out, tone: "command", parent: this.parentOf("") });
    } else if (sub === "task_started")
      this.emit({ type: "task", id: str(r.tool_use_id), taskId: str(r.task_id), description: str(r.description), agentType: str(r.subagent_type), background: r.is_backgrounded === true });
    else if (sub === "task_progress")
      this.emit({ type: "taskUpdate", id: str(r.tool_use_id), taskId: str(r.task_id), ...(str(r.last_tool_name).length > 0 ? { lastTool: str(r.last_tool_name) } : {}), ...(str(r.description).length > 0 ? { description: str(r.description) } : {}) });
    else if (sub === "task_updated") {
      const status = str(rec(r.patch)?.status);
      this.emit({ type: "taskUpdate", id: str(r.tool_use_id), taskId: str(r.task_id), ...(status.length > 0 ? { status } : {}) });
    } else if (sub === "task_notification")
      this.emit({ type: "taskUpdate", id: str(r.tool_use_id), taskId: str(r.task_id), ...(str(r.status).length > 0 ? { status: str(r.status) } : {}), summary: str(r.summary), done: true });
  }

  private result(r: Rec): void {
    this.compacted = false;
    const reason = str(r.terminal_reason);
    const isError = r.is_error === true;
    if (reason === "aborted_streaming" || reason === "aborted_tools") this.emit({ type: "notice", text: "Interrupted", tone: "info", once: true });
    else if (isError) {
      const errors = list(r.errors).filter((e): e is string => typeof e === "string");
      this.emit({ type: "notice", text: "Error: " + str(r.subtype), tone: "error", detail: errors.length > 0 ? errors.join("\n") : str(r.result), ifOpen: true });
    }
    this.emit({ type: "end", error: isError, status: str(r.subtype), reason, durationMs: num(r.duration_ms), costUsd: num(r.total_cost_usd), text: str(r.result) });
    this.turnChanged();
  }

  private attachment(r: Rec): void {
    const a = rec(r.attachment);
    if (a === null || a.type !== "queued_command") return;
    // A message sent while a tool ran, handed to Claude with its result: text, or content blocks.
    const got = contentText(a.prompt);
    if (got.text.length === 0 && got.images === 0) return;
    const notice = taskNotice(got.text);
    this.emit({ type: "prompt", parent: this.parentOf(""), text: notice.length > 0 ? notice : got.text, images: got.images, ...(notice.length > 0 ? { notice: true } : {}) });
  }

  private controlRequest(r: Rec): void {
    const q = rec(r.request);
    if (q === null || q.subtype !== "can_use_tool") return;
    const tool = str(q.tool_name);
    if (tool !== "AskUserQuestion" && tool !== "ExitPlanMode") return;
    const input = q.input !== undefined ? q.input : null;
    const id = str(r.request_id);
    this.requests.set(id, { tool, input });
    if (tool === "AskUserQuestion") this.emit({ type: "request", id, name: tool, callId: str(q.tool_use_id), input, category: "question", questions: questionsOf(input) });
    else this.emit({ type: "request", id, name: tool, callId: str(q.tool_use_id), input, category: "plan", plan: this.planText() });
  }

  /** ExitPlanMode's input is empty: the plan is the file Claude wrote under ~/.claude/plans/ just before. */
  private planText(): string {
    for (let i = this.turnCalls.length - 1; i >= 0; i--) {
      const call = this.calls.get(this.turnCalls[i]);
      if (call === undefined || categoryOf(call.name) !== "edit" || call.name === "NotebookEdit") continue;
      const path = call.paths.length > 0 ? call.paths[0] : "";
      if (!path.includes("/.claude/plans/")) continue;
      const text = this.readFile(path);
      if (text !== null) return text;
    }
    return "";
  }

  /** A subagent's transcript (its own file) under call `callId`: its prompt, text and calls become the call's. */
  applyNested(callId: string, values: unknown[]): void {
    if (!this.calls.has(callId)) return;
    this.nested = callId;
    const stamped = this.stamped;
    this.stamped = true;
    try {
      for (const v of values) this.apply(v);
    } finally {
      this.nested = "";
      this.stamped = stamped;
    }
    this.emit({ type: "closeChildren", id: callId });
  }
}

// The agent: the CLI's process, the session's history, the bookkeeping kept in widecode's store.

/** Tools whose permission prompts are their own request (a question, a plan); any other prompt is a permission to grant or refuse. */
const INTERACTIVE = ["AskUserQuestion", "ExitPlanMode"];

const PERMISSION_OPTIONS = [
  { label: "Allow once", description: "this call runs" },
  { label: "Allow for this session", description: "and the same call again without asking" },
  { label: "Deny", description: "the agent is told you refused" },
];

/** What a permission prompt is about: the tool's main argument (a command, a path, a pattern, a URL), else its input in one line. */
const argumentOf = (tool: string, input: unknown): string => {
  const r = rec(input);
  if (r === null) return "";
  if (tool === "Bash") return str(r.command);
  const path = str(r.file_path) || str(r.notebook_path);
  if (path.length > 0) return path;
  if (tool === "Grep" || tool === "Glob") return str(r.pattern) + (str(r.path).length > 0 ? " in " + str(r.path) : "");
  if (tool === "WebFetch") return str(r.url);
  if (tool === "WebSearch") return str(r.query);
  for (const key of ["description", "query", "prompt", "command", "url"]) if (str(r[key]).length > 0) return firstLine(str(r[key]));
  const text = JSON.stringify(input);
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
};

/** The path a prompt is about when the call reaches outside the session's folders: the CLI's blocked path, else the call's own path when that is why it asks; "" for any other prompt. */
const outsidePath = (q: Rec): string => {
  const blocked = str(q.blocked_path);
  if (blocked.length > 0) return blocked;
  const r = rec(q.input);
  return q.decision_reason_type === "workingDir" && r !== null ? str(r.file_path) || str(r.notebook_path) || str(r.path) : "";
};

/** The answers that add a folder to the session's, for the folder as shown. */
const folderSessionLabel = (shown: string): string => "Allow " + shown + " for this session";
const folderKeptLabel = (shown: string): string => "Allow " + shown + " from now on";

/** The control response that lets a call run with its own input, adding `folder` to the session's folders (kept in the project's local settings when `kept`) when one is given. */
const allowResponse = (requestId: string, input: unknown, folder = "", kept = false): string =>
  '{"type":"control_response","response":{"subtype":"success","request_id":' + JSON.stringify(requestId) + ',"response":{"behavior":"allow","updatedInput":' + inputJson(input) + (folder.length > 0 ? ',"updatedPermissions":[{"type":"addDirectories","directories":[' + JSON.stringify(folder) + '],"destination":' + (kept ? '"localSettings"' : '"session"') + "}]" : "") + "}}}";

const claudeAgent = (api: widecode.Api, id: string, projects: string): widecode.AgentAdapter => {
  let proc: widecode.ProcessHandle | null = null;
  let processes = 0;
  /** widecode's MCP server as this plugin's agent sees it, and whether the CLI restarts at the turn's end to pick up a change to the harness. */
  let server: { url: string; headers: { name: string; value: string }[]; tools: { name: string; category: string }[]; file: string } | null = null;
  let restartWanted = false;
  /** The permission prompts open in the request panel, by the CLI's request id, with the folder each may add ("" for none, else as shown); the calls the user allowed for the session (tool and argument); the folders added to the session's, given again to each start. */
  const permissions = new Map<string, { tool: string; input: unknown; key: string; folder: string; shown: string }>();
  const allowedThisSession = new Set<string>();
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
  let reader = new Reader(emit, readFile);
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
    reader = new Reader(emit, readFile);
    reader.folder = folder;
    status = new Status();
    for (const r of activeChain(history)) applyRecord(r, true);
    // The CLI's cost per print-mode process, kept in the transcript off the message chain.
    for (const line of history) if (line.startsWith('{"type":"cost-state"')) status.apply(rec(parse(line)) ?? {}, 0);
    emit({ type: "close" });
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
        if (allowedThisSession.has(key)) {
          write(allowResponse(id, q.input));
          api.note("claude: allowed " + tool + " again (allowed for this session)");
        } else {
          const outside = folderOf(outsidePath(q));
          const folder = allowedFolders.includes(outside) ? "" : outside;
          const shown = shownPath(folder);
          const options = folder.length === 0 ? PERMISSION_OPTIONS : [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[1], { label: folderSessionLabel(shown), description: "the folder joins this session's: reading there stops asking" }, { label: folderKeptLabel(shown), description: "the same, kept in this folder's .claude/settings.local.json for later sessions" }, PERMISSION_OPTIONS[2]];
          permissions.set(id, { tool, input: q.input, key, folder, shown });
          emit({ type: "request", id, name: tool, callId: str(q.tool_use_id), input: q.input, category: "permission", questions: [{ question: tool + " " + argument + ": allow it?", header: "Permission", options }] });
        }
      }
    }
    applyRecord(value, false);
    if (r.type === "result") {
      sendStatus();
      finishedTurn(r);
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
    // Recorded once per session by default, the prompt would stay as the first launch had it: off, a changed prompt.md reaches a resumed session.
    if (o.systemPrompt.length > 0) command.push("--append-system-prompt", o.systemPrompt, "--system-prompt-snapshot", "off");
    // Claude Code enforces them: a deny rule blocks in every mode, an ask rule prompts (here, over stdio) in every mode.
    if (o.permissions.allow.length + o.permissions.ask.length + o.permissions.deny.length > 0) command.push("--settings", JSON.stringify({ permissions: o.permissions }));
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
  });

  return {
    id,
    name: "Claude",
    choices: { anyModel: true, efforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ value: e, name: e })), modes: ["default", "acceptEdits", "plan", "bypassPermissions"].map((m) => ({ value: m, name: m })), models: [] },
    start(o) {
      return start(o);
    },
    send(text, images) {
      const content: unknown[] = images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }));
      content.push({ type: "text", text });
      // Its uuid lets it be taken back while it waits in the CLI's queue (cancel_async_message).
      const uuid = uuidV4();
      queued.push({ uuid, text });
      if (turnOpen) sentDuringTurn++;
      turnOpen = true;
      write(JSON.stringify({ type: "user", session_id: "", uuid, message: { role: "user", content }, parent_tool_use_id: null }));
      return "";
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
      folder = api.state.active().folder;
      resumed = sid;
      sides = [];
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
      if (proc !== null) proc.stop(3000);
      processes++;
      proc = null;
      unanswered();
      sides = [];
      resumed = "";
      historyStart = 0;
      history = [];
      live = [];
      reader = new Reader(emit, readFile);
      reader.folder = folder;
      status = new Status();
      sentStatus = "";
    },
    receive(text) {
      // A line, or a batch of them (JSON lines hold no raw newline).
      for (const l of text.split("\n")) if (l.length > 0) line(l, false);
      sendStatus();
      flush();
    },
    stop() {
      if (proc !== null) proc.stop(3000);
      processes++;
      proc = null;
    },
    kill() {
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
  defaults: () => ({ id: "claude", projects: "" }),
  activate(api) {
    const section = rec(api.settings.section());
    const agentId = section !== null && str(section.id).length > 0 ? str(section.id) : "claude";
    api.agents.register(claudeAgent(api, agentId, str(section?.projects)));
  },
});

export {};
