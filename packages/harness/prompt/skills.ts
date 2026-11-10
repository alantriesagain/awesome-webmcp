// The skills the harness offers, in the Agent Skills format: a folder holding a SKILL.md whose
// frontmatter names it and says what it is for. They are found in the folder's `.agents/skills`,
// `.claude/skills` and `.pi/skills` and each plugin folder's `skills` under its `.widecode/plugins`
// (a trusted folder's), then the user's `~/.agents/skills`, `~/.claude/skills` and its synced
// folders, pi's agent folder, each plugin folder's `skills` under the store's `plugins` and the
// harness's own under the store; a name found twice is the first one's. pi's agent folder is
// `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. The system prompt lists the names and
// descriptions, and the Skill tool gives the body when the model asks for one; a skill whose
// frontmatter says `disable-model-invocation: true` is not listed for the model.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listText, objectText } from "@light/lib/json.ts";
import { readTextOr } from "@light/lib/fs.ts";

/** How much of a SKILL.md the scan reads for its frontmatter. */
const HEAD_BYTES = 4096;
/** A skill's body the tool gives, at most. */
const BODY_MAX = 64 * 1024;
const SYNCED_PREFIX = "anthropic-skills:";

export class SkillInfo {
  readonly name: string;
  readonly path: string;
  /** "project", "user" or "harness". */
  readonly source: string;
  description = "";
  /** Whether the model is told of it (the frontmatter's `disable-model-invocation` says no). */
  listed = true;

  constructor(name: string, path: string, source: string) {
    this.name = name;
    this.path = path;
    this.source = source;
  }
}

/** The frontmatter's fields as text (a value that spans indented lines after `|` or `>` joined), and the body after it. */
export const frontmatter = (text: string): { fields: Map<string, string>; body: string } => {
  const fields = new Map<string, string>();
  if (!text.startsWith("---")) return { fields, body: text };
  const end = text.indexOf("\n---", 3);
  const head = end > 0 ? text.slice(3, end) : text.slice(3);
  const after = end > 0 ? text.indexOf("\n", end + 4) : -1;
  const body = end > 0 ? (after > 0 ? text.slice(after + 1) : "") : "";
  const lines = head.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (m === null) continue;
    let value = m[2].trim();
    if (value.length === 0 || value === "|" || value === ">" || value === "|-" || value === ">-") {
      const more: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) more.push(lines[j].trim());
      value = more.join(" ");
    }
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    fields.set(m[1], value.replace(/\s+/g, " ").trim());
  }
  return { fields, body };
};

/** pi's agent folder: `PI_CODING_AGENT_DIR` when it is set, else `~/.pi/agent` ("" with no home). */
export const piAgentDir = (home: string): string => {
  const given = (process.env["PI_CODING_AGENT_DIR"] ?? "").trim();
  if (given.length > 0) return given;
  return home.length > 0 ? join(home, ".pi", "agent") : "";
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
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

/** The plugin folders of `dir` (a folder of plugin folders): those holding an `index.js`, by name. */
export const pluginFolders = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of names(dir)) {
    const path = join(dir, entry);
    if (isDir(path) && existsSync(join(path, "index.js"))) out.push(path);
  }
  return out;
};

/** The skills of `dir` (a folder of skill folders), named with `prefix`, into `out` past those named already. */
const scanDir = (dir: string, source: string, prefix: string, out: SkillInfo[]): void => {
  for (const entry of names(dir)) {
    const path = join(dir, entry, "SKILL.md");
    if (!isDir(join(dir, entry)) || !existsSync(path)) continue;
    const head = frontmatter(readTextOr(path, "").slice(0, HEAD_BYTES));
    const given = head.fields.get("name") ?? "";
    const name = prefix + (given.length > 0 && prefix.length === 0 ? given : entry);
    if (out.some((s) => s.name === name)) continue;
    const s = new SkillInfo(name, path, source);
    s.description = head.fields.get("description") ?? "";
    s.listed = (head.fields.get("disable-model-invocation") ?? "") !== "true";
    out.push(s);
  }
};

/** The skills for a session in `cwd`: the folder's when `trusted`, the user's under `home` ("" for none), the harness's under `harnessRoot`. */
export const scanSkills = (cwd: string, trusted: boolean, home: string, harnessRoot: string): SkillInfo[] => {
  const out: SkillInfo[] = [];
  if (trusted && cwd.length > 0) {
    scanDir(join(cwd, ".agents", "skills"), "project", "", out);
    scanDir(join(cwd, ".claude", "skills"), "project", "", out);
    scanDir(join(cwd, ".pi", "skills"), "project", "", out);
    for (const plugin of pluginFolders(join(cwd, ".widecode", "plugins"))) scanDir(join(plugin, "skills"), "project", "", out);
  }
  if (home.length > 0) {
    scanDir(join(home, ".agents", "skills"), "user", "", out);
    const claude = join(home, ".claude", "skills");
    scanDir(claude, "user", "", out);
    for (const id of names(join(claude, "synced"))) scanDir(join(claude, "synced", id), "user", SYNCED_PREFIX, out);
  }
  const pi = piAgentDir(home);
  if (pi.length > 0) scanDir(join(pi, "skills"), "user", "", out);
  if (harnessRoot.length > 0) {
    for (const plugin of pluginFolders(join(dirname(harnessRoot), "plugins"))) scanDir(join(plugin, "skills"), "user", "", out);
    scanDir(join(harnessRoot, "skills"), "harness", "", out);
  }
  return out;
};

/** The skills as the `skills` side command prints them: a list of name, description and location. */
export const skillsJson = (skills: SkillInfo[]): string => listText(skills.map((s) => objectText(["name", "description", "location"], [JSON.stringify(s.name), JSON.stringify(s.description), JSON.stringify(s.path)])));

/** The system prompt's section on the listed skills ("" with none). */
export const skillsSection = (skills: SkillInfo[]): string => {
  const listed = skills.filter((s) => s.listed);
  if (listed.length === 0) return "";
  return (
    "Skills: each is a folder with a SKILL.md of instructions for a kind of task. When a task matches one, load it with the Skill tool before you start, then follow it; files it names are relative to its folder.\n" +
    listed.map((s) => "- " + s.name + (s.description.length > 0 ? ": " + s.description : "")).join("\n")
  );
};

/** A skill's instructions for the model: its folder, then its body without the frontmatter. */
export const skillText = (s: SkillInfo): string => {
  const body = frontmatter(readTextOr(s.path, "")).body.trim();
  const folder = s.path.slice(0, s.path.length - "/SKILL.md".length);
  return "The skill " + s.name + ", from " + folder + ":\n\n" + (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "\n[… cut]" : body);
};
