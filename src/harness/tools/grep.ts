// The Grep tool: a regular expression searched through the folder's files, ripgrep when a `rg`
// binary is on PATH, else grep; file name, line number and the line, 200 matches at most.
import { existsSync } from "node:fs";
import { num, str } from "@lightstart/lib/json.ts";
import { SpawnOptions, spawnCapped } from "@lightstart/lib/process.ts";
import { SKIP_DIRS } from "@lightstart/lib/paths.ts";
import { resolvePath } from "./read.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const MAX_MATCHES = 200;

/** The ripgrep binary on PATH ("" for none). */
export const ripgrep = (): string => {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir.length === 0) continue;
    const at = dir + "/rg";
    if (existsSync(at)) return at;
  }
  return "";
};

export const grepTool = async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const pattern = str(input["pattern"]);
  if (pattern.length === 0) return ToolOutcome.failed("no pattern given");
  const base = resolvePath(ctx.cwd, str(input["path"]).length > 0 ? str(input["path"]) : ".");
  if (!existsSync(base)) return ToolOutcome.failed("no such path " + base);
  const include = str(input["include"]);
  const ignoreCase = input["ignoreCase"] === true;
  const context = Math.max(0, Math.min(10, Math.floor(num(input["context"], 0))));
  const rg = ripgrep();
  const args: string[] = [];
  let command = "grep";
  if (rg.length > 0) {
    command = rg;
    args.push("--no-heading", "-n", "--color", "never", "--max-count", String(MAX_MATCHES));
    if (ignoreCase) args.push("-i");
    if (context > 0) args.push("-C", String(context));
    if (include.length > 0) args.push("--glob", include);
    args.push("-e", pattern, base);
  } else {
    args.push("-rnIE", "--color=never");
    for (const d of SKIP_DIRS) args.push("--exclude-dir=" + d);
    if (ignoreCase) args.push("-i");
    if (context > 0) args.push("-C", String(context));
    if (include.length > 0) args.push("--include=" + include);
    args.push("-e", pattern, base);
  }
  const o = new SpawnOptions();
  o.cwd = ctx.cwd;
  o.timeoutMs = 30000;
  o.maxBytes = 4 * 1024 * 1024;
  const run = await spawnCapped(command, args, o);
  if (run.error.length > 0) return ToolOutcome.failed("cannot search: " + run.error);
  if (run.timedOut) return ToolOutcome.failed("the search took longer than 30 s");
  // grep and rg exit 1 with no match, 2 on an error.
  if (run.code === 2 || run.code > 2) return ToolOutcome.failed(run.err.length > 0 ? run.err.split("\n")[0] : "the search failed");
  // Paths relative to the folder, as the model names them.
  const prefix = ctx.cwd + "/";
  const lines = run.text.split("\n").filter((l) => l.length > 0).map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
  const shown = lines.slice(0, MAX_MATCHES);
  const out = new ToolOutcome();
  out.text = shown.length > 0 ? shown.join("\n") + (lines.length > MAX_MATCHES ? "\n(" + String(lines.length - MAX_MATCHES) + " more lines)" : "") : "No matches for " + pattern;
  return out;
};
