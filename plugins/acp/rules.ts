// What a mode lets its tools do: opencode's permission rules, the tools and skills an entry's
// commands print, and the access each tool has.

import { obj, str, list } from "./json.ts";
import type { Msg } from "./json.ts";

/** A permission rule of opencode's: what a call of `permission` (a tool's) on `pattern` gets. */
export interface Rule {
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
export const accessOf = (tool: string, rules: Rule[]): { access: string; scope: string } => {
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
export const listedOf = (v: unknown): { names: string[]; rules: Rule[] } | null => {
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
export const skillsOf = (v: unknown, cwd: string, home: string): lightcode.AgentSkill[] => {
  const out: lightcode.AgentSkill[] = [];
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
