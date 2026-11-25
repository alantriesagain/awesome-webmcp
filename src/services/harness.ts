// The project's harness: `<folder>/.lightcode/`, trusted as one with /trust. Its parts: `plugins/*.js`
// (the runtime loads and reloads them), `prompt.md` (appended to the agent's system prompt, after a
// fixed paragraph that tells the agent it runs inside lightcode and what it can reach) and
// `config.json` (plugin sections, column widths and tool permissions, over the user's). The folder
// is watched: a change says which part moved, and the app applies it. Nothing here reaches light.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { errorMessage, isRecord, recordOf } from "@lightstart/lib/json.ts";
import { stampOf } from "@lightstart/lib/fs.ts";
import { dirname, join } from "node:path";
import { Closer, Latest } from "@lightstart/lib/timing.ts";

const WATCH_MS = 300;

const PROMPT_SKELETON = `# Prompt

What is written here is appended to the agent's system prompt in this folder, after lightcode's own
paragraph. Say what the folder is for and how the agent works in it, then delete these lines.
`;

const EXAMPLE_PLUGIN = `// An example plugin of this folder's harness: a tab in the files column and a command. Saved, the
// file reloads on its own; deleted, the tab and the command go. The api tool has the whole API.
lightcode.plugin({
  id: "example",
  activate(api) {
    const lines = ["This tab comes from .lightcode/plugins/example.js.", "Edit the file and save: the tab follows.", "Delete the file: the tab goes."];
    api.ui.panel({
      id: "example",
      title: "Example",
      order: 90,
      count: () => lines.length,
      rows: (from, count) => lines.slice(from, from + count),
    });
    api.commands.add({ name: "/example", usage: "<text>", help: "an example command of this folder's harness", run: (arg) => api.tell("example: " + arg) });
  },
});
`;

const CONFIG_SKELETON = `{
  "plugins": {},
  "columns": {},
  "permissions": { "allow": [], "ask": [], "deny": [] }
}
`;

const SKILL = `---
name: lightcode
description: Extend lightcode, the terminal frontend you run in, from this folder's .lightcode/ (plugins, prompt, config). Use it when asked to change lightcode's screen, commands, tabs, status bar or tools, or to specialize it for this folder.
---

# lightcode's harness

You run inside lightcode. This folder's \`.lightcode/\` shapes it, once the user has trusted the folder
with \`/trust\` (ask them to when \`mcp__lightcode__state\` says it is not):

- \`plugins/*.js\`: JavaScript plugins. A file calls \`lightcode.plugin({ id, activate(api) })\`; \`api\`
  adds commands, keys, tabs (\`api.ui.panel\`), status segments, strips under a column, tools for
  yourself (\`api.tools.add\`), timers, processes, and reads the folder's state and files. A saved file
  reloads alone and the conversation goes on. A file named for a built-in plugin's id (\`status\`,
  \`git\`, ...) replaces it.
- \`prompt.md\`: appended to your system prompt in this folder. A change reaches you from your next turn.
- \`config.json\`: \`plugins\` (a section per plugin id; \`false\` switches one off), \`columns\`
  (widths, \`"chat": "40%"\`) and \`permissions\`, read over the user's \`~/.lightcode/config.json\`.

## Permissions

\`permissions\` holds tool rules in Claude Code's own syntax, \`{ "allow": [], "ask": [], "deny": [] }\`:
\`Bash(git push *)\`, \`Read(./.env)\`, \`WebFetch(domain:example.com)\`, \`mcp__lightcode__reload\`. lightcode
hands them to Claude Code, which enforces them: a deny rule blocks the call in every mode, an ask
rule puts the call to the user in lightcode's request panel (Allow once, Allow for this session,
Deny). The user's rules come first; this folder's file adds ask and deny rules and cannot add allow
rules or remove the user's. A change reaches Claude Code at the end of the turn.

## The loop

1. \`mcp__lightcode__api\` with \`part\` (a namespace such as \`ui\`, \`commands\`, \`tools\`, \`state\`, or
   \`guide\`) or \`find\` for the calls you need. Read it rather than guess the API.
2. \`mcp__lightcode__check\` with the source before writing it: its errors and warnings.
3. Write the file under \`.lightcode/plugins/\`. It reloads on its own; \`mcp__lightcode__reload\` with the
   file makes sure and answers what it defined.
4. \`mcp__lightcode__log\` for errors, \`mcp__lightcode__screen\` for what the user sees (every column but
   the chat unless named), \`mcp__lightcode__state\` for the plugins' states, the tabs and the columns.

## What a plugin can and cannot do

A plugin adds commands, keys, tabs in the files or tools column, strips under a column, status
segments, tools served to you over MCP, processes, reads of files and git, and can replace a
built-in plugin. It cannot change the colors, the composer, the request panel or how messages render,
and cannot add a column: those are the compiled core. Every value crosses as JSON; a call into a
plugin has 250 ms; a write to \`globalThis\` outlives a reload of the file.

## The tools

\`mcp__lightcode__screen\`, \`state\`, \`log\`, \`api\`, \`check\`, \`reload\` and \`config\` (the configuration in
use and where each part came from).
`;

/** What `.lightcode/config.json` says: the "plugins" and "columns" values as written, the "permissions" rules, and why it was not used ("" for used). */
export class HarnessConfig {
  plugins: unknown = null;
  columns: unknown = null;
  permissions: unknown = null;
  notice = "";
}


/**
 * The paragraph the agent always gets: where it runs, what the harness folder holds, the tools it
 * has (as Claude Code names them), and that the folder waits for /trust when it does.
 */
export const fixedPrompt = (tools: string[], trusted: boolean): string =>
  "You are running inside lightcode, an agent orchestrator in the terminal, as the lead agent of this session: the user talks with you, and lightcode draws your conversation, your edits and your subagents' work in columns beside it." +
  (tools.includes("Task") ? " lightcode's Task tool starts subagents, on other models and in sandboxes the project configures; you split the work, write their briefs and review what they return." : "") +
  " This folder's `.lightcode/` is lightcode's harness: `plugins/*.js` (JavaScript plugins, reloaded on save; a file calls `lightcode.plugin({ id, activate(api) })`), `prompt.md` (appended to this prompt) and `config.json` (plugin sections, column widths, tool permissions). The user's own `prompt.md` in lightcode's store (`~/.lightcode/prompt.md`) comes before this folder's." +
  (tools.length > 0 ? " The MCP server `lightcode` offers: " + tools.map((t) => "mcp__lightcode__" + t).join(", ") + ". Read mcp__lightcode__api before writing a plugin." : "") +
  (trusted ? "" : " The folder is not trusted yet: its plugins, prompt and config are not in use until the user trusts it (/trust).");

export class Harness {
  readonly folder: string;
  /** The user-wide prompt, `prompt.md` in lightcode's store ("" without a store). */
  userPromptPath = "";
  /** Whether the user trusts the folder (/trust): its parts are in use. */
  trusted = false;
  /** Called with "plugins", "prompt" or "config" when that part changed on disk. */
  onChange: ((what: string) => void) | null = null;
  private closers: Closer[] = [];
  private readonly changes = new Latest();
  private stamps = "";

  constructor(folder: string) {
    this.folder = folder;
  }

  dir(): string {
    return join(this.folder, ".lightcode");
  }

  pluginsDir(): string {
    return join(this.dir(), "plugins");
  }

  promptPath(): string {
    return join(this.dir(), "prompt.md");
  }

  configPath(): string {
    return join(this.dir(), "config.json");
  }

  hasFolder(): boolean {
    return existsSync(this.dir());
  }

  /** How many plugin files, and whether a prompt and a config are there (trusted or not). */
  summary(): { plugins: number; prompt: boolean; config: boolean } {
    let plugins = 0;
    try {
      for (const n of readdirSync(this.pluginsDir())) if (n.endsWith(".js")) plugins++;
    } catch {
      plugins = 0;
    }
    return { plugins, prompt: existsSync(this.promptPath()), config: existsSync(this.configPath()) };
  }

  /** Write the harness's skeleton where a file is missing (prompt.md, plugins/example.js, config.json, and Claude Code's skill for lightcode under .claude/skills); answers the paths written. */
  init(): string[] {
    const written: string[] = [];
    const put = (path: string, text: string): void => {
      if (existsSync(path)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      written.push(path);
    };
    put(this.promptPath(), PROMPT_SKELETON);
    put(join(this.pluginsDir(), "example.js"), EXAMPLE_PLUGIN);
    put(this.configPath(), CONFIG_SKELETON);
    put(join(this.folder, ".claude", "skills", "lightcode", "SKILL.md"), SKILL);
    return written;
  }

  /** The folder's plugin files, by name, trusted or not. */
  pluginFiles(): string[] {
    const out: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.pluginsDir());
    } catch {
      return out;
    }
    names.sort();
    for (const n of names) if (n.endsWith(".js")) out.push(join(this.pluginsDir(), n));
    return out;
  }

  /** `prompt.md` as written, trusted or not ("" for none). */
  rawPrompt(): string {
    try {
      return readFileSync(this.promptPath(), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** The top-level keys of `config.json` as written, trusted or not ([] for none; ["not valid JSON"] when it does not parse). */
  configKeys(): string[] {
    if (!existsSync(this.configPath())) return [];
    try {
      const value = JSON.parse(readFileSync(this.configPath(), "utf8")) as unknown;
      return isRecord(value) ? Object.keys(value as Record<string, unknown>) : ["not an object"];
    } catch {
      return ["not valid JSON"];
    }
  }

  /** `prompt.md` as text, "" when there is none or the folder is not trusted. */
  prompt(): string {
    return this.trusted ? this.rawPrompt() : "";
  }

  /** The user's `prompt.md` in lightcode's store as text, "" when there is no store or no file. */
  userPrompt(): string {
    if (this.userPromptPath.length === 0) return "";
    try {
      return readFileSync(this.userPromptPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  /** `config.json` read, empty when there is none or the folder is not trusted. */
  config(): HarnessConfig {
    const c = new HarnessConfig();
    if (!this.trusted || !existsSync(this.configPath())) return c;
    let value: unknown = null;
    try {
      value = JSON.parse(readFileSync(this.configPath(), "utf8"));
    } catch (err) {
      c.notice = ".lightcode/config.json is not valid JSON (" + (errorMessage(err, "error")) + "); not used";
      return c;
    }
    const root = recordOf(value);
    if (root === null) {
      c.notice = ".lightcode/config.json is not an object; not used";
      return c;
    }
    if (root.plugins !== undefined) c.plugins = root.plugins;
    if (root.columns !== undefined) c.columns = root.columns;
    if (root.permissions !== undefined) c.permissions = root.permissions;
    return c;
  }

  /** What the agent's system prompt gets appended: the fixed paragraph, then the user's `prompt.md`, then the folder's when trusted. */
  systemPrompt(tools: string[]): string {
    const mine = this.userPrompt();
    const own = this.prompt();
    return fixedPrompt(tools, this.trusted) + (mine.length > 0 ? "\n\n" + mine : "") + (own.length > 0 ? "\n\n" + own : "");
  }

  private stamp(): string {
    return stampOf(this.promptPath()) + "|" + stampOf(this.configPath()) + "|" + (existsSync(this.pluginsDir()) ? "p" : "-") + "|" + (existsSync(this.dir()) ? "d" : "-") + "|" + stampOf(this.userPromptPath);
  }

  /** Watch the folder for its parts changing (the project folder itself until `.lightcode/` appears) and the user prompt's folder; `onChange` hears which part. */
  watch(): void {
    this.stopWatching();
    this.stamps = this.stamp();
    const target = existsSync(this.dir()) ? this.dir() : this.folder;
    try {
      const w = watch(target, () => this.changed());
      this.closers.push(new Closer(() => w.close()));
    } catch {
      return;
    }
    if (this.userPromptPath.length === 0) return;
    try {
      const w = watch(dirname(this.userPromptPath), () => this.changed());
      this.closers.push(new Closer(() => w.close()));
    } catch {
    }
  }

  stopWatching(): void {
    for (const c of this.closers) c.unwatch();
    this.closers = [];
  }

  private changed(): void {
    const ticket = this.changes.next();
    setTimeout(() => {
      if (!this.changes.is(ticket)) return;
      const before = this.stamps.split("|");
      const now = this.stamp();
      this.stamps = now;
      const after = now.split("|");
      const fn = this.onChange;
      if (before[3] !== after[3]) this.watch();
      if (fn === null) return;
      if (before[2] !== after[2]) fn("plugins");
      if (before[0] !== after[0] || before[4] !== after[4]) fn("prompt");
      if (before[1] !== after[1]) fn("config");
    }, WATCH_MS).unref();
  }
}

/** The user's "plugins" value with the project's sections over it, per id (the project's `false` or object replaces the user's); built as text, since natively an object written by computed keys slows every call. */
export const mergePlugins = (user: unknown, project: unknown): unknown => {
  const u = recordOf(user);
  const p = recordOf(project);
  if (p === null) return user;
  if (u === null) return project;
  const ids: string[] = [];
  const values: unknown[] = [];
  for (const id of Object.keys(u)) {
    ids.push(id);
    values.push(u[id]);
  }
  for (const id of Object.keys(p)) {
    const at = ids.indexOf(id);
    if (at >= 0) values[at] = p[id];
    else {
      ids.push(id);
      values.push(p[id]);
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < ids.length; i++) parts.push(JSON.stringify(ids[i]) + ":" + JSON.stringify(values[i]));
  return JSON.parse("{" + parts.join(",") + "}") as unknown;
};

/** Tool permission rules in Claude Code's syntax: the user's and the project's put together (allow the user's alone, ask and deny both, the user's first). */
export class PermissionRules {
  allow: string[] = [];
  ask: string[] = [];
  deny: string[] = [];
  /** What was left out ("" for nothing). */
  notice = "";

  /** Whether any rule is set. */
  any(): boolean {
    return this.allow.length + this.ask.length + this.deny.length > 0;
  }

  /** The three lists as JSON text, `{"allow":[...],"ask":[...],"deny":[...]}`. */
  rulesJson(): string {
    return '{"allow":' + JSON.stringify(this.allow) + ',"ask":' + JSON.stringify(this.ask) + ',"deny":' + JSON.stringify(this.deny) + "}";
  }
}

/** The non-empty strings of list `key` in `section` ([] for none). */
const rulesIn = (section: unknown, key: string): string[] => {
  const f = recordOf(section);
  const out: string[] = [];
  if (f === null || !Array.isArray(f[key])) return out;
  for (const r of f[key] as unknown[]) if (typeof r === "string" && r.trim().length > 0 && !out.includes(r.trim())) out.push(r.trim());
  return out;
};

/** `a` then what `b` adds. */
const union = (a: string[], b: string[]): string[] => {
  const out = a.slice();
  for (const r of b) if (!out.includes(r)) out.push(r);
  return out;
};

/** The user's "permissions" with the project's added: ask and deny rules join the user's, the project's allow rules are left out (a project cannot loosen the user's rules). */
export const mergePermissions = (user: unknown, project: unknown): PermissionRules => {
  const p = new PermissionRules();
  p.allow = rulesIn(user, "allow");
  p.ask = union(rulesIn(user, "ask"), rulesIn(project, "ask"));
  p.deny = union(rulesIn(user, "deny"), rulesIn(project, "deny"));
  if (rulesIn(project, "allow").length > 0) p.notice = "the project's permissions.allow is not used: a project adds ask and deny rules only";
  return p;
};

/** The user's "columns" value with the project's keys over it. */
export const mergeColumns = (user: unknown, project: unknown): unknown => mergePlugins(user, project);
