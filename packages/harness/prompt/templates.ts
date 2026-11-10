// Prompt templates in pi's format: a Markdown file whose name without `.md` is the command and
// whose body is the prompt, with `$1`, `$@` and `${@:N:L}` expanded from the words after the
// command. They are found in a trusted folder's `.widecode/prompts` and `.pi/prompts` and each
// plugin folder's `prompts` under its `.widecode/plugins`, then the harness's own `prompts` under
// the store, each plugin folder's `prompts` under the store's `plugins`, then pi's agent folder
// (`PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`); a name found twice is the first one's. The
// frontmatter's `description` is the command's description, else the body's first non-empty line cut
// to 60 characters, and its `argument-hint` is the hint a client shows beside the command.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTextOr } from "@light/lib/fs.ts";
import { frontmatter, piAgentDir, pluginFolders } from "./skills.ts";

/** How much of a body's first line the description takes when the frontmatter gives none. */
const DESCRIPTION_MAX = 60;

export class TemplateInfo {
  readonly name: string;
  readonly path: string;
  /** "project", "user" or "harness". */
  readonly source: string;
  description = "";
  /** The frontmatter's `argument-hint` ("" for none). */
  argumentHint = "";
  /** The body after the frontmatter, before the arguments are put in it. */
  body = "";

  constructor(name: string, path: string, source: string) {
    this.name = name;
    this.path = path;
    this.source = source;
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** The templates of `dir` (its direct `.md` children), into `out` past those named already. */
const scanDir = (dir: string, source: string, out: TemplateInfo[]): void => {
  for (const entry of names(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    if (!isFile(path)) continue;
    const name = entry.slice(0, entry.length - 3);
    if (out.some((t) => t.name === name)) continue;
    const head = frontmatter(readTextOr(path, ""));
    const t = new TemplateInfo(name, path, source);
    let description = head.fields.get("description") ?? "";
    if (description.length === 0) {
      const first = head.body.split("\n").find((line) => line.trim().length > 0) ?? "";
      description = first.trim().slice(0, DESCRIPTION_MAX);
    }
    t.description = description;
    t.argumentHint = head.fields.get("argument-hint") ?? "";
    t.body = head.body;
    out.push(t);
  }
};

/** The templates for a session in `cwd`: the folder's when `trusted`, the harness's under `harnessRoot`, pi's under `home` ("" for none). */
export const scanTemplates = (cwd: string, trusted: boolean, home: string, harnessRoot: string): TemplateInfo[] => {
  const out: TemplateInfo[] = [];
  if (trusted && cwd.length > 0) {
    scanDir(join(cwd, ".widecode", "prompts"), "project", out);
    scanDir(join(cwd, ".pi", "prompts"), "project", out);
    for (const plugin of pluginFolders(join(cwd, ".widecode", "plugins"))) scanDir(join(plugin, "prompts"), "project", out);
  }
  if (harnessRoot.length > 0) {
    scanDir(join(harnessRoot, "prompts"), "harness", out);
    for (const plugin of pluginFolders(join(dirname(harnessRoot), "plugins"))) scanDir(join(plugin, "prompts"), "user", out);
  }
  const pi = piAgentDir(home);
  if (pi.length > 0) scanDir(join(pi, "prompts"), "user", out);
  return out;
};

/** The words of a command line, with shell-like quoting: single and double quotes, backslash escapes. */
export const splitArgs = (text: string): string[] => {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      hasToken = true;
      i += 2;
    } else if (c === "'") {
      hasToken = true;
      i++;
      while (i < text.length && text[i] !== "'") {
        current += text[i];
        i++;
      }
      i++;
    } else if (c === '"') {
      hasToken = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          current += text[i + 1];
          i += 2;
        } else {
          current += text[i];
          i++;
        }
      }
      i++;
    } else if (/\s/.test(c)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      i++;
    } else {
      current += c;
      hasToken = true;
      i++;
    }
  }
  if (hasToken) args.push(current);
  return args;
};

/** `body` with the placeholders put in from `args`: `$N`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`, `${@:N}`, `${@:N:L}`. */
export const substituteArgs = (body: string, args: string[]): string => {
  const all = args.join(" ");
  return body.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match: string, target: string | undefined, fallback: string | undefined, startText: string | undefined, lengthText: string | undefined, simple: string | undefined): string => {
      if (target !== undefined) {
        const value = target === "@" || target === "ARGUMENTS" ? all : args[parseInt(target, 10) - 1];
        return value !== undefined && value.length > 0 ? value : fallback ?? "";
      }
      if (startText !== undefined) {
        let start = parseInt(startText, 10) - 1;
        if (start < 0) start = 0;
        if (lengthText !== undefined) return args.slice(start, start + parseInt(lengthText, 10)).join(" ");
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return all;
      const value = simple !== undefined ? args[parseInt(simple, 10) - 1] : undefined;
      return value === undefined ? "" : value;
    },
  );
};

/** `text` expanded from the template it names (`/name words`), or `text` when it names none. */
export const expandTemplate = (text: string, templates: TemplateInfo[]): string => {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (m === null) return text;
  const found = templates.find((t) => t.name === m[1]) ?? null;
  if (found === null) return text;
  return substituteArgs(found.body, splitArgs(m[2] ?? ""));
};
