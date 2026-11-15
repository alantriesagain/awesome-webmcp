// The calls the harness refuses: the `permissions.deny` rules of the user's config.json and of a
// trusted project's `.widecode/config.json`, in Claude Code's syntax. The harness asks no
// permission (every other call runs), so a deny rule is the one guard: `Bash` or `Bash(<pattern>)`
// (the pattern a glob over each simple command of the line, `*` any text; `npm run test:*` the old
// prefix form), `Read(<path>)` and `Edit(<path>)` (a gitignore-style path: `./x` and `x/` in the
// folder, `/x` from the root, `~/x` in the home, `**/x` at any depth; Read's covers Grep, Glob and
// LS, Edit's covers Write), `WebFetch(domain:<host>)` (the host and its subdomains), a tool's bare
// name, and `mcp__<server>` or `mcp__<server>__<tool>`. A refused call ends with the rule that
// refused it, for the model to take another way.
import { isAbsolute, join, normalize, relative } from "node:path";
import { segments } from "../../conversation/command.ts";
import { listOf, parseJson, recordOf, str } from "@light/lib/json.ts";
import { readTextOr } from "@light/lib/fs.ts";
import { globToRegExp } from "./glob-match.ts";

export class DenyRule {
  /** The rule as written. */
  readonly text: string;
  readonly tool: string;
  /** What is inside the parentheses ("" for the whole tool). */
  readonly specifier: string;

  constructor(text: string, tool: string, specifier: string) {
    this.text = text;
    this.tool = tool;
    this.specifier = specifier;
  }
}

/** The rules of `list` (config.json's `permissions.deny`), those it can read. */
export const parseRules = (list: string[]): DenyRule[] => {
  const out: DenyRule[] = [];
  for (const raw of list) {
    const text = raw.trim();
    const m = /^([A-Za-z0-9_-]+)(?:\((.*)\))?$/.exec(text);
    if (m === null) continue;
    out.push(new DenyRule(text, m[1], m[2] ?? ""));
  }
  return out;
};

/** The deny rules of config.json at `path` ("" for none). */
export const rulesIn = (path: string): string[] => {
  const root = recordOf(parseJson(readTextOr(path, "{}")));
  const perms = root !== null ? recordOf(root["permissions"]) : null;
  const out: string[] = [];
  for (const v of listOf(perms !== null ? perms["deny"] : null)) if (str(v).length > 0) out.push(str(v));
  return out;
};

/** Whether a command's segment matches a Bash rule's pattern. */
const commandMatches = (pattern: string, segment: string): boolean => {
  const p = pattern.trim();
  if (p.endsWith(":*")) return segment.startsWith(p.slice(0, -2));
  let re = "";
  for (const c of p) re += c === "*" ? ".*" : /[.+?^$()|[\]{}\\]/.test(c) ? "\\" + c : c;
  // `git push *` also covers `git push` alone.
  if (p.endsWith(" *")) return new RegExp("^" + re + "$").test(segment) || segment === p.slice(0, -2);
  return new RegExp("^" + re + "$").test(segment);
};

/** Whether `file` (absolute) matches a path rule's pattern, the folder `cwd` and the home `home`. */
export const pathMatches = (pattern: string, file: string, cwd: string, home: string): boolean => {
  let p = pattern.trim();
  let base = cwd;
  if (p.startsWith("~/")) {
    base = home;
    p = p.slice(2);
  } else if (p.startsWith("//")) {
    base = "/";
    p = p.slice(2);
  } else if (p.startsWith("/")) {
    base = "/";
    p = p.slice(1);
  } else if (p.startsWith("./")) p = p.slice(2);
  if (base.length === 0) return false;
  const rel = relative(base, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // A folder covers itself and what is in it; a pattern without a slash matches a name at any depth below.
  if (p.endsWith("/")) {
    if (globToRegExp(p.slice(0, -1)).test(rel)) return true;
    p += "**";
  }
  const anyDepth = !p.includes("/");
  const re = globToRegExp(p);
  if (re.test(rel)) return true;
  if (globToRegExp(p + "/**").test(rel)) return true;
  if (anyDepth) for (const part of rel.split("/")) if (re.test(part)) return true;
  return false;
};

/** The host of an http(s) address, lowercase ("" for none). */
const hostOf = (url: string): string => {
  const m = /^https?:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url.trim());
  return m !== null ? m[1].toLowerCase() : "";
};

const READS = ["Read", "Grep", "Glob", "LS"];
const EDITS = ["Edit", "Write"];

/** The rule of `rules` that refuses calling `tool` with `input` in `cwd` ("" when none does). */
export const deniedBy = (rules: DenyRule[], tool: string, input: Record<string, unknown>, cwd: string, home: string): string => {
  for (const r of rules) {
    if (r.tool.startsWith("mcp__")) {
      if (tool === r.tool || tool.startsWith(r.tool + "__")) return r.text;
      continue;
    }
    const covers = r.tool === tool || (r.tool === "Read" && READS.includes(tool)) || (r.tool === "Edit" && EDITS.includes(tool));
    if (!covers) continue;
    if (r.specifier.length === 0 || r.specifier === "*") return r.text;
    if (r.tool === "Bash") {
      const command = str(input["command"]);
      for (const seg of segments(command)) if (commandMatches(r.specifier, seg.trim())) return r.text;
      if (commandMatches(r.specifier, command.trim())) return r.text;
    } else if (r.tool === "WebFetch") {
      const domain = r.specifier.startsWith("domain:") ? r.specifier.slice("domain:".length).toLowerCase() : "";
      const host = hostOf(str(input["url"]));
      if (domain.length > 0 && host.length > 0 && (host === domain || host.endsWith("." + domain))) return r.text;
    } else if (r.tool === "Read" || r.tool === "Edit") {
      const given = str(input["file_path"]).length > 0 ? str(input["file_path"]) : str(input["path"]);
      const file = given.length === 0 ? cwd : isAbsolute(given) ? normalize(given) : join(cwd, given);
      if (pathMatches(r.specifier, file, cwd, home)) return r.text;
    }
  }
  return "";
};

/** The rules as the acp plugin reads a tools listing's (opencode's shape): everything allowed, then each tool a rule denies whole. */
export const listingRules = (rules: DenyRule[]): string => {
  const whole = rules.filter((r) => r.specifier.length === 0 || r.specifier === "*");
  if (whole.length === 0) return "[]";
  const out = ['{"permission":"*","pattern":"*","action":"allow"}'];
  for (const r of whole) {
    // An MCP tool as the plugin names widecode's: `widecode_<tool>`, a whole server `widecode_*`.
    const m = /^mcp__([A-Za-z0-9_-]+?)(?:__(.+))?$/.exec(r.tool);
    const name = m !== null ? m[1] + "_" + (m[2] !== undefined ? m[2] : "*") : r.tool;
    out.push('{"permission":' + JSON.stringify(name) + ',"pattern":"*","action":"deny"}');
  }
  return "[" + out.join(",") + "]";
};
