// The project's instructions for agents: AGENTS.md, CLAUDE.md and .claude/CLAUDE.md in each folder
// from the repository's root down to the session's folder (a trusted folder's only), then the
// user's own `~/.lightcode/harness/AGENTS.md`. A file is cut at 32 KB and all of them at 128 KB; a
// file whose text another one had already (CLAUDE.md often links AGENTS.md) is left out.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTextOr } from "@lightstart/lib/fs.ts";

const FILE_MAX = 32 * 1024;
const ALL_MAX = 128 * 1024;
const NAMES = ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md")];

export class ContextFile {
  readonly path: string;
  readonly text: string;

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
  }
}

/** The folders from the repository's root (the nearest with `.git`, else `cwd` alone) down to `cwd`. */
export const foldersDown = (cwd: string): string[] => {
  const up: string[] = [];
  let at = cwd;
  let root = "";
  for (let i = 0; i < 64; i++) {
    up.push(at);
    if (existsSync(join(at, ".git"))) {
      root = at;
      break;
    }
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return root.length > 0 ? up.reverse() : [cwd];
};

/** The context files for a session in `cwd` (the project's when `trusted`), then `userFile` ("" for none). */
export const contextFiles = (cwd: string, trusted: boolean, userFile: string): ContextFile[] => {
  const paths: string[] = [];
  if (trusted && cwd.length > 0) for (const dir of foldersDown(cwd)) for (const n of NAMES) paths.push(join(dir, n));
  if (userFile.length > 0) paths.push(userFile);
  const out: ContextFile[] = [];
  let total = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let text = readTextOr(path, "").trim();
    if (text.length === 0 || out.some((f) => f.text === text)) continue;
    if (text.length > FILE_MAX) text = text.slice(0, FILE_MAX) + "\n[… cut at " + String(FILE_MAX) + " characters]";
    if (total + text.length > ALL_MAX) break;
    total += text.length;
    out.push(new ContextFile(path, text));
  }
  return out;
};

/** The system prompt's section of the files ("" with none). */
export const contextSection = (files: ContextFile[]): string => {
  if (files.length === 0) return "";
  return "The project's instructions, which you follow:\n\n" + files.map((f) => '<file path="' + f.path + '">\n' + f.text + "\n</file>").join("\n\n");
};
