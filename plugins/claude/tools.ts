// The tools table of Claude's calls: what kind of call a tool makes, its one line, the files it
// touches, a command whole, a new file's content, a todo list, a subagent's kind, task and prompt;
// a call's facts, the questions a request asks, the reply JSON Claude Code expects, and an init
// record's tools and MCP servers.

import type { Ev, Rec } from "./records.ts";
import { rec, str, num, list } from "./records.ts";

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
  ["skill", "Skill"],
];
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

export const categoryOf = (name: string): string => {
  for (const row of CATEGORIES) if (row.indexOf(name) > 0) return row[0];
  return "other";
};

export const firstLine = (text: string): string => {
  const cut = text.indexOf("\n");
  return cut >= 0 ? text.slice(0, cut) + " …" : text;
};

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

/** A call as this plugin knows it: its tool, input (whole, or streamed so far), result's diff. */
export interface Call {
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
export const describe = (call: Call, folder: string): widecode.CallFacts => {
  const relative = (path: string): string => (folder.length > 0 && path.startsWith(folder + "/") ? path.slice(folder.length + 1) : path);
  const name = call.name;
  const category = categoryOf(name);
  const input = rec(call.input);
  if (input === null) return { category, summary: "" };
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const shown = relative(path);
  let summary = "";
  if (name === "Bash") summary = str(input.description).trim().length > 0 ? str(input.description).trim() : firstLine(str(input.command));
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

export const questionsOf = (value: unknown): { question: string; header: string; multi: boolean; options: { label: string; description: string }[] }[] => {
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
export const inputJson = (input: unknown): string => {
  if (rec(input) === null) return "{}";
  const text = JSON.stringify(input);
  return text.startsWith("{") ? text : "{}";
};

/** The user's reply to a question or plan with `input`, as the response object's JSON text. */
export const replyJson = (input: unknown, reply: widecode.AgentReply): string => {
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
export const toolsOf = (r: Rec): Ev => {
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
