// The permission and subagent helpers: what a permission prompt is about, the answers that add a
// folder, the control response that allows a call, the subagent targets and the choices /subagents
// takes.

import type { Rec } from "./records.ts";
import { rec, str } from "./records.ts";
import { inputJson, firstLine } from "./tools.ts";

/** Tools whose permission prompts are their own request (a question, a plan); any other prompt is a permission to grant or refuse. */
export const INTERACTIVE = ["AskUserQuestion", "ExitPlanMode"];

/** One of the acp plugin's Task targets, as the subagent choice reads it. */
export interface SubagentTarget {
  name: string;
  agent: string;
  model: string;
}

/** What the acp plugin's tasks say: whether it offers widecode's Task, whether the config replaces Claude's own subagents, and the targets. */
export interface SubagentTasks {
  offered: boolean;
  replace: boolean;
  targets: SubagentTarget[];
}

/** The subagents the session runs, Claude Code's own, widecode's Task, or both, on `model` for Claude's (`""`: inherited). */
export interface SubagentChoice {
  mode: string;
  model: string;
}

export const ALLOW_ALL = "Allow all for this session";

export const PERMISSION_OPTIONS = [
  { label: "Allow once", description: "this call runs" },
  { label: "Allow for this session", description: "and the same call again without asking" },
  { label: ALLOW_ALL, description: "this call and every one after it, without asking, until /new; plan mode stays" },
  { label: "Deny", description: "the agent is told you refused" },
];

/** What a permission prompt is about: the tool's main argument (a command, a path, a pattern, a URL), else its input in one line. */
export const argumentOf = (tool: string, input: unknown): string => {
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
export const outsidePath = (q: Rec): string => {
  const blocked = str(q.blocked_path);
  if (blocked.length > 0) return blocked;
  const r = rec(q.input);
  return q.decision_reason_type === "workingDir" && r !== null ? str(r.file_path) || str(r.notebook_path) || str(r.path) : "";
};

/** The answers that add a folder to the session's, for the folder as shown. */
export const folderSessionLabel = (shown: string): string => "Allow " + shown + " for this session";
export const folderKeptLabel = (shown: string): string => "Allow " + shown + " from now on";

/** The control response that lets a call run with its own input, adding `folder` to the session's folders (kept in the project's local settings when `kept`) when one is given. */
export const allowResponse = (requestId: string, input: unknown, folder = "", kept = false): string =>
  '{"type":"control_response","response":{"subtype":"success","request_id":' + JSON.stringify(requestId) + ',"response":{"behavior":"allow","updatedInput":' + inputJson(input) + (folder.length > 0 ? ',"updatedPermissions":[{"type":"addDirectories","directories":[' + JSON.stringify(folder) + '],"destination":' + (kept ? '"localSettings"' : '"session"') + "}]" : "") + "}}}";
