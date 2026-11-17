// The ACP agent adapter: one agent over ACP, its process and JSON-RPC requests, the session it makes
// or loads, its updates mapped to the conversation's events, its permissions and dialogs, its model,
// mode and effort, its listings, and a side question's fork.

import { obj, str, list, parse } from "./json.ts";
import type { Ev, Msg } from "./json.ts";
import { resolved } from "./agents.ts";
import type { Entry } from "./agents.ts";
import { accessOf, listedOf, skillsOf } from "./rules.ts";
import type { Rule } from "./rules.ts";
import { CATEGORY, NAME, OWN_NAME, ownSummary, cutText, resultOf, unifiedHunks, hunksOf, MAX_WHOLE } from "./calls.ts";
import { throughFile } from "./shell.ts";
import { SIDE_PROMPT, LISTING_MS, sessionsOf, rememberFresh, dropFresh, ownPid, deleteSession, sweep } from "./sessions.ts";
import { setting, optionsOf } from "./settings.ts";
import type { Setting, Option } from "./settings.ts";
import { TaskCalls } from "./tasks.ts";

export const acpAgent = (api: widecode.Api, id: string, entry: Entry, taskCalls: TaskCalls): widecode.AgentAdapter => {
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
  /** widecode's _meta for its own agent: the project's prompt and trust, and `side` on a side question's fork. */
  const metaOf = (side = false): Record<string, unknown> => (entry.own ? { _meta: { widecode: side ? { systemPrompt: harnessPrompt, trusted: api.harness.info().trusted, side: true } : { systemPrompt: harnessPrompt, trusted: api.harness.info().trusted } } } : {});
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
  /** The extension UI dialogs open (request id -> its JSON-RPC id and method, and the select's options), the statuses and widgets set, and the segments and strips they draw. */
  const dialogs = new Map<string, { rpc: unknown; method: string; options: string[]; answered: boolean }>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string[]>();
  const uiSegments = new Set<string>();
  const uiBands = new Set<string>();
  let uiSeq = 0;
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

  /** A request from the agent: a permission asked, an extension UI dialog, else not something widecode offers. */
  const request = (m: Msg): void => {
    const method = str(m.method);
    const p = obj(m.params);
    if (method === "_widecode/ui" && p !== null) {
      uiDialog(m, p);
      return;
    }
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

  /** Withdraw dialog `rid`: its panel entry is cancelled and the agent hears cancelled. */
  const withdrawUi = (rid: string): void => {
    const d = dialogs.get(rid);
    if (d === undefined || d.answered) return;
    d.answered = true;
    dialogs.delete(rid);
    send({ jsonrpc: "2.0", id: d.rpc, result: { cancelled: true } });
    emit({ type: "cancelRequest", id: rid });
    flush();
  };

  /** Clear what the agent put on the screen: its segments and strips draw nothing until it sets them again. */
  const clearUi = (): void => {
    for (const key of statuses.keys()) statuses.set(key, "");
    for (const key of widgets.keys()) widgets.set(key, []);
  };

  /** A `_widecode/ui` request: a select, confirm, input or editor dialog in the request panel. */
  const uiDialog = (m: Msg, p: Msg): void => {
    const method = str(p.method);
    // A side question's session asks for nothing: it answers from what it knows.
    if (sides.has(str(p.sessionId))) {
      send({ jsonrpc: "2.0", id: m.id, result: { cancelled: true } });
      return;
    }
    const title = str(p.title);
    const message = str(p.message);
    let header = "ACP";
    let question = title;
    let options: { label: string; description: string }[] = [];
    let selected: string[] = [];
    if (method === "select") {
      selected = list(p.options).map((o) => str(o));
      options = selected.map((o) => ({ label: o, description: "" }));
      header = "Select";
    } else if (method === "confirm") {
      options = [{ label: "Yes", description: "confirm" }, { label: "No", description: "do not" }];
      question = title + (message.length > 0 ? "\n\n" + message : "");
      header = "Confirm";
    } else if (method === "input") {
      const placeholder = str(p.placeholder);
      question = title + (placeholder.length > 0 ? "\n\n" + placeholder : "");
      header = "Input";
    } else if (method === "editor") {
      const prefill = str(p.prefill);
      question = title + (prefill.length > 0 ? "\n\n" + prefill : "");
      header = "Editor";
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "widecode does not offer _widecode/ui " + method } });
      return;
    }
    const rid = "acp" + String(++uiSeq);
    dialogs.set(rid, { rpc: m.id, method, options: selected, answered: false });
    emit({ type: "request", id: rid, category: "question", name: entry.name, questions: [{ question, header, options }] });
    const timeout = typeof p.timeout === "number" ? p.timeout : 0;
    if (timeout > 0)
      api.after(timeout, () => {
        if (dialogs.has(rid)) withdrawUi(rid);
      });
  };

  /** Answer dialog `rid` with the user's reply: a value, a confirmation, or cancelled. */
  const answerUi = (rid: string, reply: widecode.AgentReply): void => {
    const d = dialogs.get(rid);
    if (d === undefined || d.answered) return;
    d.answered = true;
    dialogs.delete(rid);
    const answer = reply.answers.length > 0 ? reply.answers[0] : null;
    const label = answer !== null && answer.labels.length > 0 ? answer.labels[0] : "";
    const text = answer !== null && answer.text.length > 0 ? answer.text : label;
    if (reply.state !== "answered") send({ jsonrpc: "2.0", id: d.rpc, result: { cancelled: true } });
    else if (d.method === "confirm") send({ jsonrpc: "2.0", id: d.rpc, result: { confirmed: /^y/i.test(label) } });
    else send({ jsonrpc: "2.0", id: d.rpc, result: { value: text } });
    emit({ type: "cancelRequest", id: rid, ...(reply.state === "answered" ? { state: "answered" } : {}) });
  };

  /** A `_widecode/ui` notification: what the screen shows. */
  const uiNotification = (p: Msg): void => {
    const method = str(p.method);
    if (method === "notify") {
      const message = str(p.message);
      const kind = str(p.notifyType);
      if (kind === "error" || kind === "warning") api.ui.notice(entry.name + ": " + message);
      else api.tell(message);
      return;
    }
    if (method === "setStatus") {
      const key = str(p.statusKey);
      const text = str(p.statusText);
      statuses.set(key, text);
      const name = "acp:" + key;
      if (!uiSegments.has(name)) {
        uiSegments.add(name);
        api.ui.segment({
          name,
          draw: () => {
            const t = statuses.get(key) ?? "";
            return t.length > 0 ? [{ text: t, fg: widecode.theme.dim }] : [];
          },
        });
      }
      return;
    }
    if (method === "setWidget") {
      const key = str(p.widgetKey);
      const lines = list(p.widgetLines).map((l) => str(l)).filter((l) => l.length > 0);
      widgets.set(key, lines);
      const name = "acp:" + key;
      if (!uiBands.has(name)) {
        uiBands.add(name);
        api.ui.band({
          id: name,
          under: "chat",
          lines: () => {
            const current = widgets.get(key) ?? [];
            return current.map((l) => ({ runs: [{ text: l, fg: widecode.theme.dim }] }));
          },
        });
      }
      return;
    }
    if (method === "setTitle") {
      api.agent.setTitle(str(p.title));
      return;
    }
    if (method === "set_editor_text") {
      const text = str(p.text);
      api.composer.set(text.split("\n"), Math.max(0, text.split("\n").length - 1), widecode.util.graphemes(text.split("\n")[text.split("\n").length - 1] ?? "").length);
    }
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
      } else if (m.method === "_widecode/ui") {
        const p = obj(m.params);
        if (p !== null) {
          const sid = str(p.sessionId);
          if (!sides.has(sid) && !dead.has(sid) && (sid === session || session.length === 0)) uiNotification(p);
        }
      } else if (m.method === "_widecode/plugin") {
        const p = obj(m.params);
        if (p !== null) {
          const sid = str(p.sessionId);
          if (!sides.has(sid) && !dead.has(sid) && (sid === session || session.length === 0)) api.conversation.fromAgentPart(str(p.plugin), str(p.type), p.data === undefined ? null : p.data);
        }
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
    // Its dialogs are gone and what it put on the screen goes with it.
    for (const rid of [...dialogs.keys()]) emit({ type: "cancelRequest", id: rid });
    dialogs.clear();
    clearUi();
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
    rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { widecode: { ui: true } } }, clientInfo: { name: "widecode", version: String(widecode.version) } }, (result, error) => {
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
    // The fork says it is a side question's, so the agent's plugins can tell it from a fork the user asked for.
    rpc("session/fork", { sessionId: session, cwd, mcpServers: [], ...metaOf(true) }, (result, error) => {
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

  /** Cancel the turn: permissions and dialogs still asked are withdrawn first, as ACP asks. */
  const cancel = (): void => {
    for (const rid of [...asked.keys()]) {
      answerPermission(rid, "");
      emit({ type: "cancelRequest", id: rid });
    }
    for (const rid of [...dialogs.keys()]) withdrawUi(rid);
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
    toAgentPart(plugin, type, data) {
      if (proc === null || session.length === 0) return false;
      notify("_widecode/plugin", { sessionId: session, plugin: plugin, type: type, data: data === undefined ? null : data });
      flush();
      return true;
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
      if (dialogs.has(req.id)) {
        answerUi(req.id, reply);
        flush();
        return;
      }
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
      clearUi();
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
      clearUi();
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
