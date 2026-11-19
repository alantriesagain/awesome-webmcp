// Claude Code's records as the conversation's events: one reader for the live stream and for a
// transcript's records.

import type { Ev, Rec } from "./records.ts";
import type { Call } from "./tools.ts";
import { rec, str, num, list, parse } from "./records.ts";
import { describe, categoryOf, EDIT_TOOLS, questionsOf, toolsOf, firstLine } from "./tools.ts";
import { limitMessage } from "./status.ts";

// Claude Code's records as the conversation's events: one reader for the live stream and for a
// transcript's records. Claude's assistant messages arrive one content block per line, live and in
// transcripts, so they are the authority: a block is keyed by its message id and index
// (`apiBlockIndex` in a transcript, the count of that message's lines live) or, a call, by its id.
// Stream events only preview the block they name. A turn opens on the user's prompt (the CLI's
// replay of a message sent to it, or a transcript record), or on Claude's own output when none is
// open (a background task reporting); a `result` closes it.

/** Calls kept for a later subagent read by id (their input and diff are released at the turn's end). */
const CALLS_MAX = 2000;
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

export class Reader {
  /** The folder a call's paths are shown relative to. */
  folder = "";
  /** The records carry the time they were written (a transcript's): their timestamps time the calls. */
  stamped = false;
  /** The requests open (Claude Code's request id: the tool asked about and its input). */
  readonly requests = new Map<string, { tool: string; input: unknown }>();
  private readonly emit: (e: Ev) => void;
  private readonly readFile: (path: string) => string | null;
  /** The skills an init record names, each with its file and description (the plugins the record lists locate a plugin's; the folder, a project's). */
  private readonly skillsOf: (names: string[], plugins: unknown[], folder: string) => widecode.AgentSkill[];
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

  constructor(emit: (e: Ev) => void, readFile: (path: string) => string | null, skillsOf: (names: string[], plugins: unknown[], folder: string) => widecode.AgentSkill[]) {
    this.emit = emit;
    this.readFile = readFile;
    this.skillsOf = skillsOf;
  }

  private parentOf(parent: string): string {
    return parent.length === 0 && this.nested.length > 0 ? this.nested : parent;
  }

  /** A turn closed (or another opened): what it was streaming goes with it, and the turn's calls keep only what a later subagent read needs. */
  private turnChanged(): void {
    this.streams.clear();
    this.thinking = null;
    for (const id of this.turnCalls) {
      const call = this.calls.get(id);
      if (call === undefined) continue;
      call.input = null;
      call.partial = "";
      call.patch = [];
    }
    this.turnCalls = [];
    // The message ids and block keys a transcript names only within its turn: a new turn starts new ones.
    this.lineCounts.clear();
    this.blocks.clear();
    while (this.calls.size > CALLS_MAX) {
      const oldest = this.calls.keys().next();
      if (oldest.done === true) break;
      this.calls.delete(oldest.value);
    }
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
      if (Array.isArray(r.skills)) this.emit({ type: "skills", skills: this.skillsOf(list(r.skills).filter((c): c is string => typeof c === "string"), list(r.plugins), this.folder) });
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
      const limit = limitMessage(r);
      const errors = list(r.errors).filter((e): e is string => typeof e === "string");
      if (limit.length > 0) this.emit({ type: "notice", text: firstLine(limit), tone: "error", ifOpen: true });
      else this.emit({ type: "notice", text: "Error: " + str(r.subtype), tone: "error", detail: errors.length > 0 ? errors.join("\n") : str(r.result), ifOpen: true });
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
