// The Glob tool: the files under a folder matching a pattern, newest first, 500 at most; the
// folder's files come from the workspace lister (git's own list in a repository, else a walk that
// skips the usual build folders).
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { str } from "@lightstart/lib/json.ts";
import { listFiles } from "@lightstart/workspace/files.ts";
import { globMatches } from "./glob-match.ts";
import { resolvePath } from "./read.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const MAX_MATCHES = 500;
const MAX_STAT = 5000;

/** Whether `dir` is inside a git repository. */
export const inRepo = (dir: string): boolean => {
  let at = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(at, ".git"))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
  return false;
};

export const globTool = async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const pattern = str(input["pattern"]);
  if (pattern.length === 0) return ToolOutcome.failed("no pattern given");
  const base = resolvePath(ctx.cwd, str(input["path"]).length > 0 ? str(input["path"]) : ".");
  if (!existsSync(base)) return ToolOutcome.failed("no folder " + base);
  let paths: string[] = [];
  let truncated = false;
  try {
    const list = await listFiles(base, inRepo(base));
    paths = list.paths;
    truncated = list.truncated;
  } catch (e) {
    return ToolOutcome.failed("cannot list " + base + ": " + (e instanceof Error ? e.message : "error"));
  }
  const matched = paths.filter((p) => globMatches(pattern, p));
  // Newest first, when there are not too many to stat.
  const stamped = matched.slice(0, MAX_STAT).map((p) => {
    let ms = 0;
    try {
      ms = statSync(join(base, p)).mtimeMs;
    } catch {
      ms = 0;
    }
    return { p, ms };
  });
  stamped.sort((a, b) => b.ms - a.ms || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const shown = stamped.slice(0, MAX_MATCHES).map((s) => (base === ctx.cwd ? s.p : join(relative(ctx.cwd, base) || ".", s.p)));
  const out = new ToolOutcome();
  const notes: string[] = [];
  if (matched.length > MAX_MATCHES) notes.push("(" + String(matched.length - MAX_MATCHES) + " more matches)");
  if (truncated) notes.push("(the listing was cut: the folder has many files)");
  out.text = (shown.length > 0 ? shown.join("\n") : "No files match " + pattern) + (notes.length > 0 ? "\n" + notes.join("\n") : "");
  return out;
};
