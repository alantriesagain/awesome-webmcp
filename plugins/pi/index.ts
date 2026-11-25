// pi as lightcode's agent: the user's own `pi --mode rpc` (the coding agent at
// @earendil-works/pi-coding-agent, never bundled), one process per session, spoken to in JSONL on
// its stdin and stdout. Its prompt, steering and abort, its messages read into the conversation as
// events, its models and thinking levels as the model and effort, its commands as the session's
// slash commands, its sessions listed from its session folder and resumed with `--session`, and its
// extension UI requests (select, confirm, input and editor to the request panel; notify, setStatus,
// setWidget, setTitle and set_editor_text to the screen). lightcode's own MCP tools do not reach it:
// pi takes MCP servers only through an extension. Its section of config.json:
// { "plugins": { "pi": { "name": "pi", "command": ["pi", "--mode", "rpc"] } } }; an entry is used
// only when its program is on PATH. A run ends at agent_settled, as pi's protocol says.

type Ev = lightcode.ConversationEvent;

/** Any record of the protocol, every field unknown. */
interface Rec {
  [key: string]: unknown;
}

const { obj, str, list, parse } = lightcode.util;

/** The plugin's section: a name and the words that start pi in RPC mode. */
interface Entry {
  name: string;
  command: string[];
}

const DEFAULT_ENTRY: Entry = { name: "pi", command: ["pi", "--mode", "rpc"] };

const entryOf = (section: unknown): Entry => {
  const s = obj(section);
  const words = list(s?.command).filter((w): w is string => typeof w === "string" && w.length > 0);
  return { name: str(s?.name).length > 0 ? str(s?.name) : DEFAULT_ENTRY.name, command: words.length > 0 ? words : DEFAULT_ENTRY.command };
};

/** Whether the program `command[0]` can be started: a path that exists, or a name on PATH. */
const available = (api: lightcode.Api, command: string[]): boolean => {
  const program = command.length > 0 ? command[0] : "";
  if (program.length === 0) return false;
  if (program.includes("/")) return api.fs.stat(program) !== null;
  for (const dir of api.fs.env("PATH").split(":")) if (dir.length > 0 && api.fs.stat(dir + "/" + program) !== null) return true;
  return false;
};

/** A tool result past this many characters is kept as its first CUT_HEAD, a line saying how many
 * characters were cut, and its last CUT_TAIL. */
const CUT_AT = 64000;
const CUT_HEAD = 48000;
const CUT_TAIL = 16000;

const cutText = (text: string): { text: string; size: number; truncated: boolean } => {
  if (text.length <= CUT_AT) return { text, size: text.length, truncated: false };
  const cut = text.length - CUT_HEAD - CUT_TAIL;
  return { text: text.slice(0, CUT_HEAD) + "\n[… " + String(cut) + " characters cut by lightcode …]\n" + text.slice(text.length - CUT_TAIL), size: text.length, truncated: true };
};

/** A tool result's fields from its text: bounded when long, with the full size and who cut it. */
const resultOf = (text: string, customerCut: boolean): { text: string; size?: number; truncated?: "agent" | "lightcode" } => {
  const cut = cutText(text);
  if (customerCut) return cut.truncated ? { text: cut.text, size: cut.size, truncated: "agent" } : { text: cut.text, truncated: "agent" };
  return cut.truncated ? { text: cut.text, size: cut.size, truncated: "lightcode" } : { text: cut.text };
};

/** A call's kind and its name on the call's line, for pi's built-in tools. */
const CATEGORY: Record<string, string> = { read: "read", bash: "run", edit: "edit", write: "edit", grep: "search", find: "search", ls: "read" };
const NAME: Record<string, string> = { read: "Read", bash: "Bash", edit: "Edit", write: "Write", grep: "Grep", find: "Find", ls: "LS" };

/** The tools pi has by default, as a Tools event names them. */
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const firstLine = (text: string): string => {
  const at = text.indexOf("\n");
  return at >= 0 ? text.slice(0, at) : text;
};

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

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

/** A diff's hunks from an edit's replaced texts, when pi gave no unified patch (one hunk per edit). */
const editsPatch = (args: Rec | null): { oldStart: number; newStart: number; lines: string[] }[] => {
  const out: { oldStart: number; newStart: number; lines: string[] }[] = [];
  for (const v of list(args?.edits)) {
    const e = obj(v);
    if (e === null) continue;
    const oldText = str(e.oldText);
    const newText = str(e.newText);
    const lines: string[] = [];
    for (const l of oldText.length > 0 ? oldText.split("\n") : []) lines.push("-" + l);
    for (const l of newText.length > 0 ? newText.split("\n") : []) lines.push("+" + l);
    out.push({ oldStart: 1, newStart: 1, lines });
  }
  return out;
};

/** The +/- counts of a patch. */
const patchCounts = (patch: { lines: string[] }[]): { add: number; del: number } => {
  let add = 0;
  let del = 0;
  for (const h of patch)
    for (const line of h.lines) {
      if (line.startsWith("+")) add++;
      else if (line.startsWith("-")) del++;
    }
  return { add, del };
};

/** A tool call's facts from its name, input, result of a completed call and its patch. */
const factsOf = (tool: string, args: Rec | null, path: string, patch: { lines: string[] }[]): lightcode.CallFacts => {
  const facts: lightcode.CallFacts = { category: CATEGORY[tool] ?? "other" };
  const shown = path.length > 0 ? path : str(args?.path);
  if (tool === "bash") facts.summary = str(args?.command).length > 0 ? firstLine(str(args?.command)) : "";
  else if (tool === "read") facts.summary = shown + (typeof args?.offset === "number" && args.offset > 0 ? " from line " + String(args.offset) : "");
  else if (tool === "edit") {
    const counts = patchCounts(patch);
    facts.summary = shown + (patch.length > 0 ? "  +" + String(counts.add) + " -" + String(counts.del) : "");
  } else if (tool === "write") facts.summary = shown + "  " + String(countLines(str(args?.content))) + " lines";
  else if (tool === "grep") facts.summary = str(args?.pattern) + (shown.length > 0 ? " in " + shown : "");
  else if (tool === "find") facts.summary = str(args?.pattern);
  else if (tool === "ls") facts.summary = shown.length > 0 ? shown : ".";
  else {
    for (const key of ["description", "query", "prompt", "command", "url"]) {
      const v = str(args?.[key]);
      if (v.length > 0) {
        facts.summary = firstLine(v);
        break;
      }
    }
  }
  if (tool !== "bash" && shown.length > 0) facts.paths = [shown];
  if (tool === "bash") facts.command = str(args?.command);
  if (tool === "write") facts.written = cutText(str(args?.content)).text;
  return facts;
};

/** A model's value in the conversation: provider/id (what set_model takes in two parts). */
const modelValue = (model: Rec | null): string => {
  if (model === null) return "";
  const id = str(model.id);
  if (id.length === 0) return "";
  const provider = str(model.provider);
  return provider.length > 0 ? provider + "/" + id : id;
};

/** pi's session folder for `cwd`: its path without the leading slash, / and : made -, under ~/.pi/agent/sessions. */
const sessionDir = (api: lightcode.Api, cwd: string): string => {
  const safe = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return api.fs.home() + "/.pi/agent/sessions/--" + safe + "--";
};

/** The header of session file `path`, null when it is not pi's session. */
const headerOf = (api: lightcode.Api, path: string): Rec | null => {
  const head = api.fs.read(path, 0, 8192);
  const at = head.indexOf("\n");
  const line = at >= 0 ? head.slice(0, at) : head;
  const v = parse(line);
  const h = obj(v);
  return h !== null && h.type === "session" ? h : null;
};

/** A session file's title: its latest session_info name, else its first user message. */
const titleOf = (api: lightcode.Api, path: string): string => {
  const tail = api.fs.window(path, -1, 262144, []);
  for (let i = tail.lines.length - 1; i >= 0; i--) {
    const e = obj(parse(tail.lines[i]));
    if (e !== null && e.type === "session_info") {
      const name = str(e.name).trim();
      if (name.length > 0) return name;
    }
  }
  const head = api.fs.read(path, 0, 262144);
  for (const line of head.split("\n")) {
    const e = obj(parse(line));
    if (e === null || e.type !== "message") continue;
    const message = obj(e.message);
    if (message === null || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return firstLine(content.trim());
    for (const v of list(content)) {
      const t = obj(v);
      if (t !== null && t.type === "text" && str(t.text).trim().length > 0) return firstLine(str(t.text).trim());
    }
  }
  return "";
};

/** Sessions of `folder`, newest first, read from pi's session files. */
const sessionsOf = (api: lightcode.Api, folder: string): lightcode.AgentSession[] => {
  const dir = sessionDir(api, folder);
  const out: lightcode.AgentSession[] = [];
  for (const f of api.fs.list(dir)) {
    if (!f.file || !f.name.endsWith(".jsonl")) continue;
    const path = dir + "/" + f.name;
    const header = headerOf(api, path);
    if (header === null) continue;
    const cwd = str(header.cwd);
    if (cwd.length > 0 && cwd !== folder) continue;
    const id = str(header.id) || f.name.slice(f.name.lastIndexOf("_") + 1).replace(/\.jsonl$/, "");
    if (id.length === 0) continue;
    out.push({ id, title: titleOf(api, path), mtimeMs: f.mtimeMs });
  }
  return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
};

/** The file of session `id` in `folder` ("" when there is none). */
const sessionFileOf = (api: lightcode.Api, folder: string, id: string): string => {
  const dir = sessionDir(api, folder);
  for (const f of api.fs.list(dir)) {
    if (!f.file || !f.name.endsWith(".jsonl")) continue;
    const path = dir + "/" + f.name;
    const header = headerOf(api, path);
    if (header !== null && str(header.id) === id) return path;
  }
  return "";
};

const LISTING_MS = 3000;

const piAgent = (api: lightcode.Api, id: string, entry: Entry): lightcode.AgentAdapter => {
  let proc: lightcode.ProcessHandle | null = null;
  let cwd = "";
  let ready = false;
  let session = "";
  let sessionFile = "";
  let generation = 0;
  let processes = 0;
  let seq = 0;
  const waiting = new Map<string, (result: unknown, error: string) => void>();
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
  const notice = (text: string, tone: "info" | "error", detail?: string): void => emit({ type: "notice", text, tone, detail: detail ?? "" });

  /** The models, efforts and commands as pi last listed them, and which one runs. */
  let models: lightcode.AgentOption[] = [];
  let efforts: lightcode.AgentOption[] = [];
  let commands: string[] = [];
  const modelOf = new Map<string, { provider: string; id: string }>();
  let currentModel = "";
  let currentEffort = "";
  let contextWindow = 0;
  /** The cost of the session so far, and the cost pi last reported for the message that streams
   * (its usage carries that message's cost, not the session's). */
  let spent = 0;
  let messageCost = 0;
  let wantModel = "";
  let wantEffort = "";
  /** A session's listing, the folder it was for, and when it was read. */
  let listed: lightcode.AgentSession[] = [];
  let listedFolder = "";
  let listedAt = 0;
  /** Messages waiting for the session, the turn that runs, and whether the user cancelled it. */
  const queue: { text: string; images: { mediaType: string; data: string; path?: string }[] }[] = [];
  let inTurn = false;
  let turnAt = 0;
  let cancelled = false;
  let lastError = "";
  /** The text or thinking block streaming, its kind, and a counter for keys. */
  let open = "";
  let openKind = "";
  let blocks = 0;
  /** The calls seen: their tool, input and facts. */
  const calls = new Map<string, { tool: string; args: Rec | null; facts: lightcode.CallFacts; path: string }>();
  /** The extension UI requests open (request id -> pi's id and method), the statuses and widgets set. */
  const requests = new Map<string, { ui: string; method: string; options: string[]; answered: boolean }>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string[]>();
  const segments = new Set<string>();
  const bands = new Set<string>();
  let uiSeq = 0;

  const send = (m: Rec): void => {
    if (proc !== null) proc.write(JSON.stringify(m));
  };

  /** A command to pi; its answer's data (or error) reaches `answer` while this process runs. */
  const rpc = (type: string, fields: Rec, answer: (data: unknown, error: string) => void): void => {
    if (proc === null) return;
    const rid = "p" + String(++seq);
    waiting.set(rid, answer);
    send({ id: rid, type, ...fields });
  };

  const relative = (path: string): string => (cwd.length > 0 && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path);

  const closeBlock = (): void => {
    if (open.length > 0) emit({ type: "finish", key: open });
    open = "";
    openKind = "";
  };

  const chunk = (kind: "text" | "thinking", delta: string): void => {
    if (delta.length === 0) return;
    if (open.length > 0 && openKind === kind) {
      emit({ type: "text", key: open, delta });
      return;
    }
    closeBlock();
    open = (kind === "text" ? "m" : "th") + String(++blocks);
    openKind = kind;
    emit({ type: "block", key: open, kind, text: "" });
    emit({ type: "text", key: open, delta });
  };

  /** The models and efforts as they stand, and what pi offers, to the conversation. */
  const announce = (): void => {
    emit({ type: "choices", models, efforts, modes: [] });
    emit({ type: "session", id: session, cwd, ...(currentModel.length > 0 ? { model: currentModel } : {}), ...(currentEffort.length > 0 ? { effort: currentEffort } : {}) });
    if (currentModel.length > 0) emit({ type: "usage", model: currentModel, ...(contextWindow > 0 ? { contextSize: contextWindow } : {}) });
    if (commands.length > 0) emit({ type: "session", commands });
  };

  const usageOf = (u: Rec | null): void => {
    if (u === null) return;
    const input = typeof u.input === "number" ? u.input : 0;
    const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
    const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
    const cost = obj(u.cost);
    const total = cost !== null && typeof cost.total === "number" ? cost.total : -1;
    if (total >= 0 && total >= messageCost) {
      spent += total - messageCost;
      messageCost = total;
    }
    emit({ type: "usage", contextUsed: input + cacheRead + cacheWrite, ...(contextWindow > 0 ? { contextSize: contextWindow } : {}), ...(total >= 0 ? { costUsd: spent } : {}) });
  };

  /** The state pi answered: the session and the model it runs on. */
  const applyState = (data: Rec | null): void => {
    if (data === null) return;
    session = str(data.sessionId).length > 0 ? str(data.sessionId) : session;
    sessionFile = str(data.sessionFile);
    const model = obj(data.model);
    currentModel = modelValue(model);
    contextWindow = model !== null && typeof model.contextWindow === "number" ? model.contextWindow : contextWindow;
    currentEffort = str(data.thinkingLevel);
    emit({ type: "session", id: session, cwd, ...(currentModel.length > 0 ? { model: currentModel } : {}), ...(currentEffort.length > 0 ? { effort: currentEffort } : {}) });
  };

  /** Ask pi for its state, models, efforts and commands; once all answer, the session is ready. */
  const refresh = (): void => {
    if (proc === null) return;
    const gen = generation;
    rpc("get_state", {}, (data, error) => {
      if (gen !== generation) return;
      if (error.length > 0) {
        notice(entry.name + " did not answer with its state", "error", error);
        return;
      }
      applyState(obj(data));
      let left = 3;
      const one = (): void => {
        if (gen !== generation) return;
        left--;
        if (left > 0) return;
        ready = true;
        announce();
        emit({ type: "tools", tools: TOOLS.map((name) => ({ name })), partial: false });
        emit({ type: "sessions" });
        const model = wantModel;
        const effort = wantEffort;
        wantModel = "";
        wantEffort = "";
        const applyEffort = (): void => {
          if (effort.length > 0 && efforts.some((e) => e.value === effort) && currentEffort !== effort) setEffortNow(effort, pump);
          else pump();
        };
        if (model.length > 0 && modelOf.has(model) && currentModel !== model) setModelNow(model, applyEffort);
        else applyEffort();
      };
      rpc("get_available_models", {}, (v, e2) => {
        if (gen !== generation) return;
        if (e2.length === 0) {
          models = [];
          modelOf.clear();
          for (const x of list(obj(v)?.models)) {
            const m = obj(x);
            if (m === null) continue;
            const value = modelValue(m);
            if (value.length === 0) continue;
            models.push({ value, name: str(m.name).length > 0 ? str(m.name) : value });
            modelOf.set(value, { provider: str(m.provider), id: str(m.id) });
          }
        }
        one();
      });
      rpc("get_available_thinking_levels", {}, (v, e2) => {
        if (gen !== generation) return;
        if (e2.length === 0) efforts = list(obj(v)?.levels).map((l) => str(l)).filter((l) => l.length > 0).map((l) => ({ value: l, name: l }));
        one();
      });
      rpc("get_commands", {}, (v, e2) => {
        if (gen !== generation) return;
        if (e2.length === 0) commands = list(obj(v)?.commands).map((c) => str(obj(c)?.name)).filter((n) => n.length > 0);
        one();
      });
    });
  };

  /** Start a new session in the running process (after /new), then ask for its state again. */
  const newSession = (): void => {
    const gen = generation;
    rpc("new_session", {}, (_data, error) => {
      if (gen !== generation || error.length > 0) return;
      session = "";
      sessionFile = "";
      spent = 0;
      messageCost = 0;
      listedAt = 0;
      refresh();
    });
  };

  const pump = (): void => {
    if (!ready || inTurn || queue.length === 0 || proc === null) return;
    const m = queue.shift()!;
    inTurn = true;
    turnAt = Date.now();
    cancelled = false;
    lastError = "";
    closeBlock();
    emit({ type: "take", text: m.text });
    emit({ type: "turn", text: m.text, images: m.images.length, imagePaths: m.images.map((i) => i.path ?? "") });
    prompt(m, false);
  };

  /** Send `m` as a prompt: a new turn, or steered into the turn that runs. */
  const prompt = (m: { text: string; images: { mediaType: string; data: string; path?: string }[] }, steer: boolean): void => {
    const images = m.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mediaType }));
    const fields: Rec = { message: m.text, ...(images.length > 0 ? { images } : {}), ...(steer ? { streamingBehavior: "steer" } : {}) };
    rpc("prompt", fields, (data, error) => {
      if (steer) {
        if (error.length > 0) notice(entry.name + ": " + error, "error");
        return;
      }
      if (error.length > 0) {
        lastError = error;
        notice("Error", "error", error);
        finishTurn(true);
        return;
      }
      const disposition = str(obj(data)?.disposition);
      listedAt = 0;
      // A command an extension took, or a prompt handled without a run, ends here.
      if (disposition === "handled") finishTurn(false);
    });
  };

  const finishTurn = (error: boolean): void => {
    if (!inTurn) return;
    closeBlock();
    inTurn = false;
    listedAt = 0;
    const stopped = cancelled;
    const failed = error || lastError.length > 0;
    cancelled = false;
    lastError = "";
    if (stopped) notice("Interrupted", "info");
    emit({ type: "end", error: failed, status: stopped ? "cancelled" : "", durationMs: Date.now() - turnAt });
    emit({ type: "sessions" });
    pump();
  };

  /** A tool call starts: its card, facts and input. */
  const callStart = (e: Rec): void => {
    const id = str(e.toolCallId);
    if (id.length === 0) return;
    closeBlock();
    const tool = str(e.toolName);
    const args = obj(e.args);
    const path = args !== null ? relative(str(args.path)) : "";
    const facts = factsOf(tool, args, path, []);
    calls.set(id, { tool, args, facts, path });
    emit({ type: "block", key: id, kind: "tool", id, name: NAME[tool] ?? "Tool", text: "", ...facts });
    if (args !== null) emit({ type: "input", key: id, input: args });
  };

  /** A tool call ends: its result, its diff (an edit's or a write's), and its card finished. */
  const callEnd = (e: Rec): void => {
    const id = str(e.toolCallId);
    if (id.length === 0) return;
    closeBlock();
    const tool = str(e.toolName);
    const known = calls.get(id);
    const args = known !== undefined ? known.args : obj(e.args);
    const path = known !== undefined ? known.path : args !== null ? relative(str(args.path)) : "";
    const result = obj(e.result);
    const details = obj(result?.details);
    const parts: string[] = [];
    for (const v of list(result?.content)) {
      const c = obj(v);
      if (c !== null && c.type === "text") parts.push(str(c.text));
    }
    let patch: { oldStart: number; newStart: number; lines: string[] }[] = [];
    if (tool === "edit") {
      const unified = str(details?.patch);
      patch = unified.length > 0 ? unifiedHunks(unified) : editsPatch(args);
    }
    const facts = factsOf(tool, args, path, patch);
    if (known !== undefined) known.facts = facts;
    emit({ type: "facts", id, ...facts });
    const text = parts.join("\n");
    const truncated = details !== null && (details.truncated === true || details.truncation !== undefined);
    emit({ type: "result", id, ...resultOf(text, truncated), error: e.isError === true, ...(patch.length > 0 ? { patch } : {}) });
    emit({ type: "finish", key: id });
    if (e.isError !== true && (tool === "edit" || tool === "write") && path.length > 0) emit({ type: "edited", path: path.startsWith("/") ? path : cwd + "/" + path });
    calls.delete(id);
  };

  /** A session event from pi. */
  const event = (e: Rec): void => {
    const type = str(e.type);
    if (type === "message_start" || type === "message_end") {
      const message = obj(e.message);
      if (type === "message_end") closeBlock();
      else if (message !== null && message.role === "assistant") messageCost = 0;
      return;
    }
    if (type === "message_update") {
      usageOf(obj(e.usage));
      const inner = obj(e.assistantMessageEvent);
      if (inner === null) return;
      const what = str(inner.type);
      if (what === "text_start") chunk("text", "");
      else if (what === "text_delta") chunk("text", str(inner.delta));
      else if (what === "text_end") closeBlock();
      else if (what === "thinking_start") chunk("thinking", "");
      else if (what === "thinking_delta") chunk("thinking", str(inner.delta));
      else if (what === "thinking_end") closeBlock();
      else if (what === "error") {
        const message = obj(inner.error);
        lastError = message !== null && str(message.errorMessage).length > 0 ? str(message.errorMessage) : str(inner.reason);
        notice("Error", "error", lastError);
      }
      return;
    }
    if (type === "agent_start") return;
    if (type === "agent_end") {
      if (e.willRetry === true) notice(entry.name + " retries after an error", "info");
      return;
    }
    if (type === "agent_settled") {
      if (e.aborted === true) cancelled = true;
      finishTurn(false);
    } else if (type === "tool_execution_start") callStart(e);
    else if (type === "tool_execution_end") callEnd(e);
    else if (type === "compaction_start") notice(entry.name + " compacts the conversation", "info");
    else if (type === "compaction_end") {
      if (str(e.errorMessage).length > 0) notice("Compaction failed", "error", str(e.errorMessage));
      else notice("Compacted", "info");
    } else if (type === "auto_retry_start") notice(entry.name + " retries (attempt " + String(e.attempt) + " of " + String(e.maxAttempts) + ")", "info", str(e.errorMessage));
    else if (type === "auto_retry_end") {
      if (e.success !== true) notice("Retry failed", "error", str(e.finalError));
    } else if (type === "session_info_changed") {
      api.agent.setTitle(str(e.name));
    } else if (type === "extension_error") {
      const text = "pi extension " + str(e.extensionPath) + " failed on " + str(e.event) + ": " + str(e.error);
      api.note(text);
      api.ui.notice(text);
    } else if (type === "thinking_level_changed") {
      currentEffort = str(e.level);
      emit({ type: "session", effort: currentEffort });
    }
  };

  /** Withdraw UI request `requestId`: its panel entry is cancelled and pi hears cancelled. */
  const withdraw = (requestId: string): void => {
    const r = requests.get(requestId);
    if (r === undefined || r.answered) return;
    r.answered = true;
    requests.delete(requestId);
    send({ type: "extension_ui_response", id: r.ui, cancelled: true });
    emit({ type: "cancelRequest", id: requestId });
    flush();
  };

  /** An extension UI request: a dialog to the request panel, or what the screen shows. */
  const extensionUi = (m: Rec): void => {
    const method = str(m.method);
    const ui = str(m.id);
    if (method === "notify") {
      const message = str(m.message);
      const kind = str(m.notifyType);
      if (kind === "error" || kind === "warning") api.ui.notice(entry.name + ": " + message);
      else api.tell(message);
      return;
    }
    if (method === "setStatus") {
      const key = str(m.statusKey);
      const text = str(m.statusText);
      statuses.set(key, text);
      const name = "pi:" + key;
      if (!segments.has(name)) {
        segments.add(name);
        api.ui.segment({
          name,
          draw: () => {
            const t = statuses.get(key) ?? "";
            return t.length > 0 ? [{ text: t, fg: lightcode.theme.dim }] : [];
          },
        });
      }
      return;
    }
    if (method === "setWidget") {
      const key = str(m.widgetKey);
      const lines = list(m.widgetLines).map((l) => str(l)).filter((l) => l.length > 0);
      widgets.set(key, lines);
      const name = "pi:" + key;
      if (!bands.has(name)) {
        bands.add(name);
        api.ui.band({
          id: name,
          under: "chat",
          lines: () => {
            const current = widgets.get(key) ?? [];
            return current.map((l) => ({ runs: [{ text: l, fg: lightcode.theme.dim }] }));
          },
        });
      }
      return;
    }
    if (method === "setTitle") {
      api.agent.setTitle(str(m.title));
      return;
    }
    if (method === "set_editor_text") {
      const text = str(m.text);
      api.composer.set(text.split("\n"), Math.max(0, text.split("\n").length - 1), lightcode.util.graphemes(text.split("\n")[text.split("\n").length - 1] ?? "").length);
      return;
    }
    const title = str(m.title);
    const message = str(m.message);
    const category: "question" = "question";
    let header = "pi";
    let question = title;
    let options: { label: string; description: string }[] = [];
    let selected: string[] = [];
    if (method === "select") {
      selected = list(m.options).map((o) => str(o));
      options = selected.map((o) => ({ label: o, description: "" }));
      header = "Select";
    } else if (method === "confirm") {
      options = [{ label: "Yes", description: "confirm" }, { label: "No", description: "do not" }];
      question = title + (message.length > 0 ? "\n\n" + message : "");
      header = "Confirm";
    } else if (method === "input") {
      const placeholder = str(m.placeholder);
      question = title + (placeholder.length > 0 ? "\n\n" + placeholder : "");
      header = "Input";
    } else if (method === "editor") {
      const prefill = str(m.prefill);
      question = title + (prefill.length > 0 ? "\n\n" + prefill : "");
      header = "Editor";
    } else return;
    const requestId = "pi" + String(++uiSeq);
    requests.set(requestId, { ui, method, options: selected, answered: false });
    emit({ type: "request", id: requestId, category, name: entry.name, questions: [{ question, header, options }] });
    const timeout = typeof m.timeout === "number" ? m.timeout : 0;
    if (timeout > 0)
      api.after(timeout, () => {
        if (!requests.has(requestId)) return;
        withdraw(requestId);
      });
    flush();
  };

  /** Answer UI request `requestId` with the user's reply, in pi's shape. */
  const answerUi = (requestId: string, reply: lightcode.AgentReply): void => {
    const r = requests.get(requestId);
    if (r === undefined || r.answered) return;
    r.answered = true;
    requests.delete(requestId);
    const answer = reply.answers.length > 0 ? reply.answers[0] : null;
    const label = answer !== null && answer.labels.length > 0 ? answer.labels[0] : "";
    const text = answer !== null && answer.text.length > 0 ? answer.text : label;
    if (reply.state !== "answered" && r.method !== "confirm") send({ type: "extension_ui_response", id: r.ui, cancelled: true });
    else if (r.method === "confirm") {
      if (reply.state !== "answered") send({ type: "extension_ui_response", id: r.ui, cancelled: true });
      else send({ type: "extension_ui_response", id: r.ui, confirmed: /^y/i.test(label) });
    } else send({ type: "extension_ui_response", id: r.ui, value: text });
    emit({ type: "cancelRequest", id: requestId, ...(reply.state === "answered" ? { state: "answered" } : {}) });
    flush();
  };

  /** Cancel the turn: UI requests open are withdrawn, then pi aborts. */
  const cancel = (): void => {
    for (const requestId of Array.from(requests.keys())) withdraw(requestId);
    if (inTurn) {
      cancelled = true;
      rpc("abort", {}, (_data, error) => {
        if (error.length > 0) notice(entry.name + ": " + error, "error");
      });
    }
    flush();
  };

  const lines = (ls: string[]): void => {
    for (const l of ls) {
      const v = parse(l);
      const m = obj(v);
      if (m === null) continue;
      const type = str(m.type);
      if (type === "response") {
        const rid = str(m.id);
        const answer = waiting.get(rid);
        if (answer === undefined) continue;
        waiting.delete(rid);
        if (m.success === true) answer(m.data === undefined ? null : m.data, "");
        else answer(null, str(m.error));
        continue;
      }
      if (type === "extension_ui_request") {
        extensionUi(m);
        continue;
      }
      event(m);
    }
    flush();
  };

  /** The process ended: a turn it ran ends with it; the next message starts it again and opens its session. */
  const exited = (code: number): void => {
    processes++;
    proc = null;
    ready = false;
    const answers = Array.from(waiting.values());
    waiting.clear();
    for (const answer of answers) answer(null, "the agent's process ended");
    if (code !== 0 && code !== -1) notice(entry.name + " ended (exit code " + String(code) + ")", "error");
    if (inTurn) {
      lastError = "the agent's process ended";
      finishTurn(true);
    }
    for (const requestId of Array.from(requests.keys())) withdraw(requestId);
    emit({ type: "process", state: "ended" });
    flush();
  };

  /** Start pi, opening session file `target` when there is one; "" or why it could not start. */
  const spawn = (folder: string, target: string): string => {
    cwd = folder;
    const gen = ++generation;
    const seqProcess = ++processes;
    const command = entry.command.slice();
    if (target.length > 0) command.push("--session", target);
    const p = api.process.spawn(command, { cwd: folder }, {
      lines: (ls) => {
        if (seqProcess === processes && gen === generation) lines(ls);
      },
      exit: (code) => {
        if (seqProcess === processes && gen === generation) exited(code);
      },
      error: (text) => api.note(id + ": " + text.trimEnd()),
    });
    if (!p.started) return "cannot start " + command.join(" ");
    proc = p;
    emit({ type: "process", state: "running" });
    flush();
    refresh();
    return "";
  };

  const setModelNow = (name: string, then: () => void): void => {
    const m = modelOf.get(name);
    if (m === undefined) {
      notice(entry.name + " has no model " + name, "info");
      then();
      return;
    }
    rpc("set_model", { provider: m.provider, modelId: m.id }, (data, error) => {
      if (error.length > 0) {
        notice(entry.name + " could not switch to " + name + ": " + error, "error");
        announce();
      } else {
        const model = obj(data);
        currentModel = model !== null ? modelValue(model) || name : name;
        contextWindow = model !== null && typeof model.contextWindow === "number" ? model.contextWindow : contextWindow;
        announce();
      }
      then();
    });
  };

  const setEffortNow = (level: string, then: () => void): void => {
    rpc("set_thinking_level", { level }, (_data, error) => {
      if (error.length > 0) notice(entry.name + " could not set effort " + level + ": " + error, "error");
      else {
        currentEffort = level;
        emit({ type: "session", effort: level });
      }
      then();
    });
  };

  return {
    id,
    name: entry.name,
    // pi's session comes with its process: models, efforts and commands are known before the first message.
    eager: true,
    start(o) {
      cwd = o.cwd;
      wantModel = o.model;
      wantEffort = o.effort;
      if (proc !== null) {
        // The process runs with an old session (after /new): a new one, on the model and effort chosen.
        const gen = generation;
        if (session.length === 0 && !ready) newSession();
        else {
          ready = false;
          rpc("get_state", {}, (data, error) => {
            if (gen !== generation || error.length > 0) return;
            applyState(obj(data));
            refresh();
          });
        }
        flush();
        return "";
      }
      const resumeFile = o.resume.length > 0 ? sessionFileOf(api, o.cwd, o.resume) : "";
      session = o.resume;
      const target = resumeFile.length > 0 ? resumeFile : o.resume;
      const error = spawn(o.cwd, target);
      flush();
      return error;
    },
    send(text, images) {
      queue.push({ text, images });
      if (ready && inTurn) {
        // Steered into the turn that runs, as pi takes a prompt with streamingBehavior.
        const m = queue.shift()!;
        emit({ type: "take", text: m.text });
        emit({ type: "prompt", text: m.text, images: m.images.length, imagePaths: m.images.map((i) => i.path ?? "") });
        prompt(m, true);
      } else pump();
      flush();
      return "";
    },
    interrupt() {
      cancel();
    },
    setMode() {
      return entry.name + " has no mode to choose";
    },
    setModel(name) {
      if (!ready || proc === null) {
        wantModel = name;
        return;
      }
      if (models.length > 0 && !modelOf.has(name)) {
        notice(entry.name + " has no model " + name + " (it has " + models.slice(0, 8).map((m) => m.value).join(", ") + (models.length > 8 ? ", …" : "") + ")", "info");
        announce();
        return;
      }
      setModelNow(name, () => flush());
    },
    setEffort(level) {
      if (!ready || proc === null) {
        wantEffort = level;
        return;
      }
      if (efforts.length > 0 && !efforts.some((e) => e.value === level)) {
        notice(entry.name + " has no effort " + level + " (it has " + efforts.map((e) => e.value).join(", ") + ")", "info");
        announce();
        return;
      }
      setEffortNow(level, () => flush());
    },
    respond(req: lightcode.AgentRequest, reply: lightcode.AgentReply) {
      answerUi(req.id, reply);
    },
    resume(sid) {
      // A resume opens the session file with a new process, as pi's --session does.
      generation++;
      ready = false;
      inTurn = false;
      cancelled = false;
      spent = 0;
      messageCost = 0;
      queue.splice(0);
      closeBlock();
      requests.clear();
      if (proc !== null) {
        const p = proc;
        proc = null;
        try {
          p.stop(1000);
        } catch {
          try {
            p.kill();
          } catch {
            // Already gone.
          }
        }
      }
      const folder = api.state.active().folder;
      session = sid;
      sessionFile = sessionFileOf(api, folder, sid);
      if (sessionFile.length === 0) {
        notice(entry.name + " has no session " + sid, "error");
        emit({ type: "process", state: "ended" });
        flush();
        return;
      }
      const error = spawn(folder, sessionFile);
      if (error.length > 0) notice(error, "error");
      flush();
    },
    reset() {
      generation++;
      queue.splice(0);
      inTurn = false;
      cancelled = false;
      lastError = "";
      ready = false;
      session = "";
      sessionFile = "";
      spent = 0;
      messageCost = 0;
      closeBlock();
      requests.clear();
      if (proc !== null) {
        const p = proc;
        proc = null;
        try {
          p.stop(1000);
        } catch {
          try {
            p.kill();
          } catch {
            // Already gone.
          }
        }
        emit({ type: "process", state: "ended" });
      }
      flush();
    },
    withdraw() {
      emit({ type: "withdrawn", texts: queue.splice(0).map((m) => m.text) });
      flush();
      return "";
    },
    stop() {
      if (proc !== null) proc.stop(2000);
    },
    kill() {
      if (proc === null) return;
      proc.kill();
      exited(-1);
    },
    sessions(folder) {
      if (folder !== listedFolder || Date.now() - listedAt > LISTING_MS) {
        listed = sessionsOf(api, folder);
        listedFolder = folder;
        listedAt = Date.now();
      }
      return listed;
    },
  };
};

lightcode.plugin({
  id: "pi",
  defaults: () => ({ name: DEFAULT_ENTRY.name, command: DEFAULT_ENTRY.command }),
  activate(api) {
    const entry = entryOf(api.settings.section());
    // Only when the user has pi: lightcode never brings its own copy.
    if (!available(api, entry.command)) return;
    api.agents.register(piAgent(api, "pi", entry));
  },
});

export {};
